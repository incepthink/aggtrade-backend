import type { Request, Response, NextFunction } from "express";
import axios from "axios";
import Bottleneck from "bottleneck";
import { getValue, storeValue } from "../redis/ethereumTokens";

// Types
interface OHLCPoint {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface OneInchCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface OneInchCandlesResponse {
  data: OneInchCandle[];
}

// Rate limiter for 1inch API
const oneInchLimiter = new Bottleneck({
  reservoir: 120,
  reservoirRefreshAmount: 120,
  reservoirRefreshInterval: 60 * 1000, // per minute
  maxConcurrent: 3,
  minTime: 500,
});

// Cache configuration
const OHLC_CACHE_PREFIX = "ohlc_1inch_";
const OHLC_CACHE_TTL = 5 * 60; // 5 minutes

// Constants
const ONEINCH_API_KEY = process.env.ONEINCH_KEY;
const USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ETHEREUM_CHAIN_ID = 1;

/**
 * Get 1inch API configuration
 */
const getOneInchConfig = () => ({
  timeout: 15000,
  headers: {
    Accept: "application/json",
    ...(ONEINCH_API_KEY && { Authorization: `Bearer ${ONEINCH_API_KEY}` }),
  },
});

/**
 * Convert resolution to seconds
 */
function resolutionToSeconds(resolution: string): number {
  switch (resolution) {
    case "minute":
      return 60;
    case "hour":
      return 3600;
    case "day":
      return 86400;
    default:
      return 3600; // Default to hour
  }
}

/**
 * Get OHLC data from 1inch charts API
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
    const seconds = resolutionToSeconds(resolution);
    const cacheKey = `${OHLC_CACHE_PREFIX}${normalizedAddress}_${resolution}_${limit}`;

    // Check cache unless force refresh
    if (!force) {
      try {
        const cached = await getValue(cacheKey);
        if (cached) {
          console.log(`[1inch] Cache hit for OHLC: ${normalizedAddress}`);
          const cachedData = JSON.parse(cached);
          res.status(200).json({
            status: "success",
            data: cachedData,
            source: "1inch",
            cached: true,
            tokenAddress: normalizedAddress,
            resolution,
            count: cachedData.chart?.length || 0,
          });
          return;
        }
      } catch (cacheError) {
        console.warn(`[1inch] Cache read error for ${cacheKey}:`, cacheError);
      }
    }

    // Rate limit the request
    await oneInchLimiter.schedule(async () => {
      try {
        console.log(
          `[1inch] Fetching OHLC data: ${normalizedAddress}, resolution: ${resolution}, seconds: ${seconds}`
        );

        // Call 1inch charts API
        const response = await axios.get<OneInchCandlesResponse>(
          `https://api.1inch.dev/charts/v1.0/chart/aggregated/candle/${normalizedAddress}/${USDC_ADDRESS}/${seconds}/${ETHEREUM_CHAIN_ID}`,
          getOneInchConfig()
        );

        if (!response.data?.data || !Array.isArray(response.data.data)) {
          res.status(404).json({
            status: "error",
            msg: "No OHLC data available for this token",
            tokenAddress: normalizedAddress,
          });
          return;
        }

        // Convert 1inch candles to our format
        let ohlcData: OHLCPoint[] = response.data.data.map((candle) => ({
          timestamp: candle.time * 1000, // Convert to milliseconds
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: 0, // 1inch charts don't provide volume data
        }));

        if (ohlcData.length === 0) {
          res.status(404).json({
            status: "error",
            msg: "No OHLC data available for this token",
            tokenAddress: normalizedAddress,
          });
          return;
        }

        // Prepare response data
        const responseData = {
          chart: ohlcData,
          metadata: {
            pair: {
              address: `${normalizedAddress}-${USDC_ADDRESS}`,
              baseToken: {
                address: normalizedAddress,
                name: "Unknown Token",
                symbol: "TOKEN",
              },
              quoteToken: {
                address: USDC_ADDRESS,
                name: "USD Coin",
                symbol: "USDC",
              },
              dexId: "1inch",
              url: `https://app.1inch.io/#/${ETHEREUM_CHAIN_ID}/unified/${normalizedAddress}`,
            },
            liquidity: {
              usd: 0,
              base: 0,
              quote: 0,
            },
            volume24h: 0,
            fdv: 0,
            marketCap: 0,
            priceUsd: ohlcData[ohlcData.length - 1]?.close || 0,
            currency: "USD",
            dataSource: "api",
          },
        };

        // Cache the result
        try {
          await storeValue(
            cacheKey,
            JSON.stringify(responseData),
            OHLC_CACHE_TTL
          );
          console.log(`[1inch] Cached OHLC data for ${normalizedAddress}`);
        } catch (cacheError) {
          console.warn(
            `[1inch] Cache write error for ${cacheKey}:`,
            cacheError
          );
        }

        res.status(200).json({
          status: "success",
          data: responseData,
          source: "1inch",
          cached: false,
          tokenAddress: normalizedAddress,
          resolution,
          count: ohlcData.length,
          dataSource: "api",
        });
      } catch (apiError: any) {
        console.error(`[1inch] API error for ${normalizedAddress}:`, apiError);

        if (apiError.response?.status === 404) {
          res.status(404).json({
            status: "error",
            msg: "Token not found or no trading data available",
            tokenAddress: normalizedAddress,
          });
        } else if (apiError.response?.status === 401) {
          res.status(401).json({
            status: "error",
            msg: "1inch API authentication required",
          });
        } else if (apiError.response?.status === 429) {
          res.status(429).json({
            status: "error",
            msg: "Rate limited by 1inch API. Please try again later.",
          });
        } else {
          res.status(500).json({
            status: "error",
            msg: "Failed to fetch OHLC data from 1inch",
          });
        }
      }
    });
  } catch (error: any) {
    console.error("[1inch] OHLC controller error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
    });
  }
}

/**
 * Get multiple OHLC data for batch requests
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
    const seconds = resolutionToSeconds(resolution);

    // Process each token with rate limiting
    for (const tokenAddress of tokenAddresses) {
      try {
        const normalizedAddress = tokenAddress.toLowerCase();

        await oneInchLimiter.schedule(async () => {
          try {
            const response = await axios.get<OneInchCandlesResponse>(
              `https://api.1inch.dev/charts/v1.0/chart/aggregated/candle/${normalizedAddress}/${USDC_ADDRESS}/${seconds}/${ETHEREUM_CHAIN_ID}`,
              getOneInchConfig()
            );

            if (!response.data?.data || !Array.isArray(response.data.data)) {
              errors[normalizedAddress] = "No OHLC data available";
              return;
            }

            const ohlcData: OHLCPoint[] = response.data.data
              .slice(-limit)
              .map((candle) => ({
                timestamp: candle.time * 1000,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: 0,
              }));

            results[normalizedAddress] = {
              chart: ohlcData,
              metadata: {
                pair: {
                  address: `${normalizedAddress}-${USDC_ADDRESS}`,
                  baseToken: {
                    address: normalizedAddress,
                    name: "Unknown Token",
                    symbol: "TOKEN",
                  },
                  quoteToken: {
                    address: USDC_ADDRESS,
                    name: "USD Coin",
                    symbol: "USDC",
                  },
                  dexId: "1inch",
                },
                liquidity: { usd: 0, base: 0, quote: 0 },
                volume24h: 0,
                priceUsd: ohlcData[ohlcData.length - 1]?.close || 0,
                currency: "USD",
                dataSource: "api",
              },
            };
          } catch (error: any) {
            errors[normalizedAddress] =
              error.response?.status === 404
                ? "No trading data available"
                : "API error";
          }
        });

        // Add delay between batch requests
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        errors[tokenAddress.toLowerCase()] = errorMessage;
        console.error(`[1inch] Batch error for ${tokenAddress}:`, error);
      }
    }

    res.status(200).json({
      status: "success",
      data: results,
      errors,
      source: "1inch",
      resolution,
      limit,
      requested: tokenAddresses.length,
      successful: Object.keys(results).length,
      failed: Object.keys(errors).length,
    });
  } catch (error) {
    console.error("[1inch] Batch OHLC controller error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
    });
  }
}

/**
 * Clear OHLC cache for a specific token
 */
export async function clearOHLCCache(
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

    const normalizedAddress = tokenAddress.toLowerCase();
    console.log(`[1inch] Clearing cache for: ${normalizedAddress}`);

    res.status(200).json({
      status: "success",
      msg: "Cache cleared successfully",
      tokenAddress: normalizedAddress,
    });
  } catch (error) {
    console.error("[1inch] Clear cache error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
    });
  }
}
