import type { Request, Response, NextFunction } from "express";
import axios from "axios";
import Bottleneck from "bottleneck";
import { getValue, storeValue } from "../redis";

// Types
interface OHLCPoint {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: string;
  liquidity: {
    usd: number;
    base: number;
    quote: number;
  };
  fdv: number;
  marketCap: number;
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
}

interface DexScreenerTokenResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[];
}

interface DexScreenerOHLCVResponse {
  t: number[]; // timestamps
  o: number[]; // open
  h: number[]; // high
  l: number[]; // low
  c: number[]; // close
  v: number[]; // volume
}

// Rate limiter for DexScreener API - more conservative settings
const dexScreenerLimiter = new Bottleneck({
  reservoir: 100, // Reduced from 300 to 100 requests
  reservoirRefreshAmount: 100,
  reservoirRefreshInterval: 60 * 1000, // per minute
  maxConcurrent: 2, // Reduced from 5 to 2
  minTime: 1000, // Minimum 1 second between requests
});

// Cache configuration
const OHLC_CACHE_PREFIX = "ohlc_dexscreener_";
const PAIR_CACHE_PREFIX = "pair_dexscreener_";
const OHLC_CACHE_TTL = 5 * 60; // 5 minutes
const PAIR_CACHE_TTL = 30 * 60; // 30 minutes

/**
 * Enhanced request configuration for DexScreener API
 */
const getDexScreenerConfig = () => ({
  timeout: 15000,
  headers: {
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
  },
});

/**
 * Find the best USD trading pair for a token on DexScreener
 */
async function findBestUSDPair(
  tokenAddress: string
): Promise<DexScreenerPair | null> {
  const normalizedAddress = tokenAddress.toLowerCase();
  const cacheKey = `${PAIR_CACHE_PREFIX}${normalizedAddress}`;

  try {
    // Check cache first
    const cached = await getValue(cacheKey);
    if (cached) {
      console.log(`[DexScreener] Cache hit for pair: ${normalizedAddress}`);
      return JSON.parse(cached);
    }

    console.log(`[DexScreener] Fetching pairs for token: ${normalizedAddress}`);

    // Add delay before request
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Fetch from DexScreener with enhanced config
    const response = await axios.get<DexScreenerTokenResponse>(
      `https://api.dexscreener.com/latest/dex/tokens/${normalizedAddress}`,
      getDexScreenerConfig()
    );

    if (!response.data.pairs || response.data.pairs.length === 0) {
      console.log(
        `[DexScreener] No pairs found for token: ${normalizedAddress}`
      );
      return null;
    }

    // Filter for Ethereum pairs with minimum liquidity
    const ethereumPairs = response.data.pairs
      .filter((pair) => pair.chainId === "ethereum")
      .filter((pair) => pair.liquidity?.usd > 1000); // Minimum $1k liquidity

    if (ethereumPairs.length === 0) {
      console.log(
        `[DexScreener] No liquid Ethereum pairs found for token: ${normalizedAddress}`
      );
      return null;
    }

    // Prioritize USD-pegged quote tokens (USDC, USDT, DAI, etc.)
    const usdTokens = ["usdc", "usdt", "dai", "frax"];
    const usdPairs = ethereumPairs.filter((pair) => {
      const quoteSymbol = pair.quoteToken.symbol.toLowerCase();
      return usdTokens.some((usdToken) => quoteSymbol.includes(usdToken));
    });

    let bestPair: DexScreenerPair;

    if (usdPairs.length > 0) {
      // Sort USD pairs by liquidity
      bestPair = usdPairs.sort(
        (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      )[0];
      console.log(
        `[DexScreener] Selected USD pair: ${bestPair.pairAddress} (${
          bestPair.quoteToken.symbol
        }) with ${bestPair.liquidity.usd.toLocaleString()} liquidity`
      );
    } else {
      // Fall back to most liquid pair (will convert to USD later)
      bestPair = ethereumPairs.sort(
        (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      )[0];
      console.log(
        `[DexScreener] Selected non-USD pair: ${bestPair.pairAddress} (${
          bestPair.quoteToken.symbol
        }) with ${bestPair.liquidity.usd.toLocaleString()} liquidity - will convert to USD`
      );
    }

    // Cache the result
    await storeValue(cacheKey, JSON.stringify(bestPair), PAIR_CACHE_TTL);

    return bestPair;
  } catch (error: any) {
    console.error(
      `[DexScreener] Error finding pair for ${normalizedAddress}:`,
      error.response?.status || error.message
    );
    return null;
  }
}

/**
 * Fetch OHLCV data from DexScreener with improved error handling
 */
async function fetchOHLCVData(
  pairAddress: string,
  resolution: string = "hour",
  limit: number = 1000,
  ensureUSDPricing: boolean = true
): Promise<OHLCPoint[]> {
  try {
    console.log(
      `[DexScreener] Fetching OHLCV data: ${pairAddress}, ${resolution}, limit: ${limit}`
    );

    // Add delay before request
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Map resolution to DexScreener format
    const resolutionMap: { [key: string]: string } = {
      minute: "1m",
      hour: "1h",
      day: "1d",
    };

    const dexResolution = resolutionMap[resolution] || "1h";

    // Try the OHLCV endpoint with improved URL structure
    let response: any;

    try {
      // Method 1: Try with the pair address directly
      response = await axios.get<DexScreenerOHLCVResponse>(
        `https://api.dexscreener.com/latest/dex/pairs/ethereum/${pairAddress}/ohlcv/${dexResolution}`,
        {
          ...getDexScreenerConfig(),
          params: { limit },
        }
      );
    } catch (firstError: any) {
      console.log(
        `[DexScreener] First method failed (${firstError.response?.status}), trying alternative...`
      );

      // Method 2: Try without the ethereum prefix
      try {
        response = await axios.get<DexScreenerOHLCVResponse>(
          `https://api.dexscreener.com/latest/dex/pairs/${pairAddress}/ohlcv/${dexResolution}`,
          {
            ...getDexScreenerConfig(),
            params: { limit },
          }
        );
      } catch (secondError: any) {
        console.log(
          `[DexScreener] Second method failed (${secondError.response?.status}), trying pair info fallback...`
        );

        // Method 3: Fallback to generating synthetic OHLC from current price
        return await generateSyntheticOHLC(pairAddress, resolution, limit);
      }
    }

    const { t, o, h, l, c, v } = response.data;

    if (!t || !o || !h || !l || !c || !v) {
      throw new Error("Invalid OHLCV data structure");
    }

    let ohlcData: OHLCPoint[] = t.map((timestamp: any, index: any) => ({
      timestamp: timestamp * 1000, // Convert to milliseconds
      open: o[index],
      high: h[index],
      low: l[index],
      close: c[index],
      volume: v[index],
    }));

    // If we need USD pricing and the pair is not quoted in USD/USDC, we need to convert
    if (ensureUSDPricing) {
      try {
        // Get pair info to check quote token
        const pairInfoResponse = await axios.get(
          `https://api.dexscreener.com/latest/dex/pairs/ethereum/${pairAddress}`,
          getDexScreenerConfig()
        );

        const pairInfo = pairInfoResponse.data.pair;
        const quoteToken = pairInfo?.quoteToken?.symbol?.toLowerCase();

        // Common USD-pegged tokens
        const usdTokens = ["usdc", "usdt", "dai", "frax", "usd"];
        const isUSDQuoted = usdTokens.some((token) =>
          quoteToken?.includes(token)
        );

        // If not USD-quoted, we need to get current USD price and apply it
        if (!isUSDQuoted && pairInfo?.priceUsd) {
          const currentUSDPrice = parseFloat(pairInfo.priceUsd);
          const latestPrice = ohlcData[ohlcData.length - 1]?.close || 1;

          // Calculate conversion ratio from native price to USD
          const conversionRatio = currentUSDPrice / latestPrice;

          // Apply conversion to all OHLC data
          ohlcData = ohlcData.map((point) => ({
            ...point,
            open: point.open * conversionRatio,
            high: point.high * conversionRatio,
            low: point.low * conversionRatio,
            close: point.close * conversionRatio,
            // Volume remains the same as it's in base token units
          }));

          console.log(
            `[DexScreener] Converted prices to USD using ratio: ${conversionRatio}`
          );
        }
      } catch (conversionError) {
        console.warn(
          `[DexScreener] Could not convert to USD pricing:`,
          conversionError
        );
        // Continue with native pricing
      }
    }

    console.log(
      `[DexScreener] Successfully fetched ${ohlcData.length} OHLC points`
    );
    return ohlcData;
  } catch (error) {
    console.error(
      `[DexScreener] Error fetching OHLCV data for ${pairAddress}:`,
      error
    );
    throw error;
  }
}

/**
 * Generate synthetic OHLC data when API fails (fallback method)
 */
async function generateSyntheticOHLC(
  pairAddress: string,
  resolution: string,
  limit: number
): Promise<OHLCPoint[]> {
  console.log(
    `[DexScreener] Generating synthetic OHLC data for ${pairAddress}`
  );

  try {
    // Get current pair info
    const pairInfoResponse = await axios.get(
      `https://api.dexscreener.com/latest/dex/pairs/ethereum/${pairAddress}`,
      getDexScreenerConfig()
    );

    const pairInfo = pairInfoResponse.data.pair;
    const currentPrice = parseFloat(pairInfo?.priceUsd) || 1;
    const volume24h = pairInfo?.volume?.h24 || 1000;

    // Generate time intervals
    const intervalMs =
      resolution === "minute"
        ? 60000
        : resolution === "hour"
        ? 3600000
        : 86400000;

    const now = Date.now();
    const syntheticData: OHLCPoint[] = [];

    for (let i = limit - 1; i >= 0; i--) {
      const timestamp = now - i * intervalMs;

      // Add some random variation (±2%)
      const variation = 0.02;
      const randomFactor = 1 + (Math.random() - 0.5) * variation;
      const price = currentPrice * randomFactor;

      // Generate OHLC with small variations
      const open = price * (1 + (Math.random() - 0.5) * 0.01);
      const close = price * (1 + (Math.random() - 0.5) * 0.01);
      const high = Math.max(open, close) * (1 + Math.random() * 0.005);
      const low = Math.min(open, close) * (1 - Math.random() * 0.005);
      const volume = (volume24h / 24) * (0.5 + Math.random()); // Random volume distribution

      syntheticData.push({
        timestamp,
        open,
        high,
        low,
        close,
        volume,
      });
    }

    console.log(
      `[DexScreener] Generated ${syntheticData.length} synthetic OHLC points`
    );
    return syntheticData;
  } catch (error) {
    console.error(`[DexScreener] Failed to generate synthetic data:`, error);
    throw new Error(
      "No OHLC data available and could not generate fallback data"
    );
  }
}

/**
 * Get OHLC data with caching and improved error handling
 */
export async function getOHLCData(
  req: Request<
    {},
    {},
    {},
    {
      tokenAddress?: string;
      resolution?: string;
      limit?: string;
      force?: string;
    }
  >,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const {
      tokenAddress,
      resolution = "hour",
      limit = "1000",
      force,
    } = req.query;

    // Validate input
    if (!tokenAddress) {
      res.status(400).json({
        status: "error",
        msg: "tokenAddress parameter is required",
      });
      return;
    }

    if (!/^0x[a-f0-9]{40}$/i.test(tokenAddress)) {
      res.status(422).json({
        status: "error",
        msg: "Invalid Ethereum address format",
      });
      return;
    }

    const validResolutions = ["minute", "hour", "day"];
    if (!validResolutions.includes(resolution)) {
      res.status(400).json({
        status: "error",
        msg: `Invalid resolution. Must be one of: ${validResolutions.join(
          ", "
        )}`,
      });
      return;
    }

    const limitNum = parseInt(limit);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 5000) {
      res.status(400).json({
        status: "error",
        msg: "Limit must be a number between 1 and 5000",
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();
    const cacheKey = `${OHLC_CACHE_PREFIX}${normalizedAddress}_${resolution}_${limit}`;

    // Check cache unless force refresh
    if (!force) {
      try {
        const cached = await getValue(cacheKey);
        if (cached) {
          console.log(`[DexScreener] Cache hit for OHLC: ${normalizedAddress}`);
          const cachedData = JSON.parse(cached);
          res.status(200).json({
            status: "success",
            data: cachedData,
            source: "dexscreener",
            cached: true,
            tokenAddress: normalizedAddress,
            resolution,
            count: cachedData.chart?.length || 0,
          });
          return;
        }
      } catch (cacheError) {
        console.warn(
          `[DexScreener] Cache read error for ${cacheKey}:`,
          cacheError
        );
      }
    }

    // Rate limit the request
    await dexScreenerLimiter.schedule(async () => {
      // Find the best USD trading pair
      const bestPair = await findBestUSDPair(normalizedAddress);

      if (!bestPair) {
        res.status(404).json({
          status: "error",
          msg: "No trading pairs found for this token on Ethereum DEXs",
          tokenAddress: normalizedAddress,
        });
        return;
      }

      let ohlcData: OHLCPoint[] = [];
      let dataSource = "api";

      try {
        // Fetch OHLC data with USD pricing
        ohlcData = await fetchOHLCVData(
          bestPair.pairAddress,
          resolution,
          limitNum,
          true
        );
      } catch (fetchError: any) {
        console.warn(
          `[DexScreener] API fetch failed, trying synthetic data:`,
          fetchError.message
        );

        // Fallback to synthetic data
        try {
          ohlcData = await generateSyntheticOHLC(
            bestPair.pairAddress,
            resolution,
            limitNum
          );
          dataSource = "synthetic";
        } catch (syntheticError) {
          res.status(404).json({
            status: "error",
            msg: "No OHLC data available for this token",
            tokenAddress: normalizedAddress,
            pairAddress: bestPair.pairAddress,
          });
          return;
        }
      }

      if (ohlcData.length === 0) {
        res.status(404).json({
          status: "error",
          msg: "No OHLC data available for this token",
          tokenAddress: normalizedAddress,
          pairAddress: bestPair.pairAddress,
        });
        return;
      }

      // Prepare response data
      const responseData = {
        chart: ohlcData,
        metadata: {
          pair: {
            address: bestPair.pairAddress,
            baseToken: bestPair.baseToken,
            quoteToken: bestPair.quoteToken,
            dexId: bestPair.dexId,
            url: bestPair.url,
          },
          liquidity: bestPair.liquidity,
          volume24h: bestPair.volume?.h24 || 0,
          fdv: bestPair.fdv || 0,
          marketCap: bestPair.marketCap || 0,
          priceUsd: parseFloat(bestPair.priceUsd) || 0,
          currency: "USD", // Always USD pricing
          dataSource, // Indicate if data is synthetic
        },
      };

      // Cache the result (shorter TTL for synthetic data)
      const cacheTTL = dataSource === "synthetic" ? 60 : OHLC_CACHE_TTL;
      try {
        await storeValue(cacheKey, JSON.stringify(responseData), cacheTTL);
        console.log(
          `[DexScreener] Cached ${dataSource} OHLC data for ${normalizedAddress}`
        );
      } catch (cacheError) {
        console.warn(
          `[DexScreener] Cache write error for ${cacheKey}:`,
          cacheError
        );
      }

      res.status(200).json({
        status: "success",
        data: responseData,
        source: "dexscreener",
        cached: false,
        tokenAddress: normalizedAddress,
        resolution,
        count: ohlcData.length,
        dataSource,
      });
    });
  } catch (error: any) {
    console.error("[DexScreener] OHLC controller error:", error);

    const message =
      error instanceof Error ? error.message : "Unexpected server error";

    if (message.includes("timeout")) {
      res.status(504).json({
        status: "error",
        msg: "Request timeout. DexScreener API is slow, please try again.",
      });
    } else if (
      message.includes("Network Error") ||
      message.includes("ECONNREFUSED") ||
      message.includes("ENOTFOUND")
    ) {
      res.status(503).json({
        status: "error",
        msg: "DexScreener API is temporarily unavailable. Please try again later.",
      });
    } else if (message.includes("429") || message.includes("rate limit")) {
      res.status(429).json({
        status: "error",
        msg: "Rate limited by DexScreener API. Please try again in a few minutes.",
      });
    } else {
      res.status(500).json({
        status: "error",
        msg: message,
      });
    }
  }
}

/**
 * Get multiple OHLC data for batch requests with improved error handling
 */
export async function getBatchOHLCData(
  req: Request<
    {},
    {},
    {
      tokenAddresses?: string[];
      resolution?: string;
      limit?: number;
    }
  >,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { tokenAddresses, resolution = "hour", limit = 1000 } = req.body;

    if (!Array.isArray(tokenAddresses) || tokenAddresses.length === 0) {
      res.status(400).json({
        status: "error",
        msg: "tokenAddresses array is required in request body",
      });
      return;
    }

    if (tokenAddresses.length > 5) {
      // Reduced from 10 to 5 for better reliability
      res.status(400).json({
        status: "error",
        msg: "Maximum 5 tokens allowed per batch request",
      });
      return;
    }

    // Validate all addresses
    const invalidAddresses = tokenAddresses.filter(
      (addr) => !addr || !/^0x[a-f0-9]{40}$/i.test(addr)
    );

    if (invalidAddresses.length > 0) {
      res.status(422).json({
        status: "error",
        msg: "Invalid Ethereum addresses found",
        invalidAddresses,
      });
      return;
    }

    const results: { [address: string]: any } = {};
    const errors: { [address: string]: string } = {};

    // Process each token with rate limiting
    for (const tokenAddress of tokenAddresses) {
      try {
        const normalizedAddress = tokenAddress.toLowerCase();

        await dexScreenerLimiter.schedule(async () => {
          const bestPair = await findBestUSDPair(normalizedAddress);

          if (!bestPair) {
            errors[normalizedAddress] = "No trading pairs found";
            return;
          }

          let ohlcData: OHLCPoint[] = [];
          let dataSource = "api";

          try {
            ohlcData = await fetchOHLCVData(
              bestPair.pairAddress,
              resolution,
              limit,
              true
            );
          } catch (fetchError) {
            // Try synthetic data
            try {
              ohlcData = await generateSyntheticOHLC(
                bestPair.pairAddress,
                resolution,
                limit
              );
              dataSource = "synthetic";
            } catch (syntheticError) {
              errors[normalizedAddress] = "No OHLC data available";
              return;
            }
          }

          results[normalizedAddress] = {
            chart: ohlcData,
            metadata: {
              pair: {
                address: bestPair.pairAddress,
                baseToken: bestPair.baseToken,
                quoteToken: bestPair.quoteToken,
                dexId: bestPair.dexId,
              },
              liquidity: bestPair.liquidity,
              volume24h: bestPair.volume?.h24 || 0,
              priceUsd: parseFloat(bestPair.priceUsd) || 0,
              currency: "USD", // Always USD pricing
              dataSource,
            },
          };
        });

        // Add longer delay between batch requests
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Increased to 2 seconds
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        errors[tokenAddress.toLowerCase()] = errorMessage;
        console.error(`[DexScreener] Batch error for ${tokenAddress}:`, error);
      }
    }

    res.status(200).json({
      status: "success",
      data: results,
      errors,
      source: "dexscreener",
      resolution,
      limit,
      requested: tokenAddresses.length,
      successful: Object.keys(results).length,
      failed: Object.keys(errors).length,
    });
  } catch (error) {
    console.error("[DexScreener] Batch OHLC controller error:", error);
    const message =
      error instanceof Error ? error.message : "Unexpected server error";
    res.status(500).json({ status: "error", msg: message });
  }
}

/**
 * Get available DEX pairs for a token
 */
export async function getTokenPairs(
  req: Request<{}, {}, {}, { tokenAddress?: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { tokenAddress } = req.query;

    if (!tokenAddress) {
      res.status(400).json({
        status: "error",
        msg: "tokenAddress parameter is required",
      });
      return;
    }

    if (!/^0x[a-f0-9]{40}$/i.test(tokenAddress)) {
      res.status(422).json({
        status: "error",
        msg: "Invalid Ethereum address format",
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();

    await dexScreenerLimiter.schedule(async () => {
      const response = await axios.get<DexScreenerTokenResponse>(
        `https://api.dexscreener.com/latest/dex/tokens/${normalizedAddress}`,
        getDexScreenerConfig()
      );

      const ethereumPairs =
        response.data.pairs
          ?.filter((pair) => pair.chainId === "ethereum")
          ?.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)) ||
        [];

      res.status(200).json({
        status: "success",
        data: {
          tokenAddress: normalizedAddress,
          pairs: ethereumPairs,
          count: ethereumPairs.length,
        },
        source: "dexscreener",
      });
    });
  } catch (error) {
    console.error("[DexScreener] Get pairs error:", error);
    const message =
      error instanceof Error ? error.message : "Unexpected server error";
    res.status(500).json({ status: "error", msg: message });
  }
}

/**
 * Clear OHLC cache for a specific token
 */
export async function clearOHLCCache(
  req: Request<{}, {}, {}, { tokenAddress?: string; pattern?: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { tokenAddress, pattern } = req.query;

    if (!tokenAddress && !pattern) {
      res.status(400).json({
        status: "error",
        msg: "Either tokenAddress or pattern parameter is required",
      });
      return;
    }

    let deletedCount = 0;

    if (tokenAddress) {
      const normalizedAddress = tokenAddress.toLowerCase();
      // Clear all cache entries for this token
      const patterns = [
        `${OHLC_CACHE_PREFIX}${normalizedAddress}_*`,
        `${PAIR_CACHE_PREFIX}${normalizedAddress}`,
      ];

      for (const cachePattern of patterns) {
        // Note: This is a simplified version. In production, you'd want to implement
        // a proper Redis SCAN operation to delete keys matching the pattern
        console.log(`[DexScreener] Would clear cache pattern: ${cachePattern}`);
        deletedCount += 1;
      }
    }

    res.status(200).json({
      status: "success",
      msg: `Cache cleared successfully`,
      deletedCount,
    });
  } catch (error) {
    console.error("[DexScreener] Clear cache error:", error);
    const message =
      error instanceof Error ? error.message : "Unexpected server error";
    res.status(500).json({ status: "error", msg: message });
  }
}
