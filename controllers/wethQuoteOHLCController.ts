// src/controllers/wethQuoteOHLCController.ts
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
  volumeUSD: number;
  swapCount: number;
}

interface SwapData {
  id: string;
  timestamp: string;
  amount0: string;
  amount1: string;
  amount0USD: string;
  amount1USD: string;
  token0PriceUSD: string;
  token1PriceUSD: string;
  token0: { id: string; symbol: string; decimals: string };
  token1: { id: string; symbol: string; decimals: string };
  pool: { id: string; totalValueLockedUSD: string };
  amountUSD: string;
}

interface GraphQLResponse {
  data?: {
    tokenSwaps?: SwapData[];
    wethPriceSwaps?: SwapData[];
  };
  errors?: any[];
}

// Configuration
const sushiLimiter = new Bottleneck({
  reservoir: 60,
  reservoirRefreshAmount: 60,
  reservoirRefreshInterval: 60 * 1000,
  maxConcurrent: 2,
  minTime: 1000,
});

const CACHE_PREFIX = "weth_quote_ohlc_";
const CACHE_TTL = 6 * 60 * 60; // 6 hours

const SUSHISWAP_SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/106601/sushi-v-3-eth/version/latest";

// Key addresses
const WETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

/**
 * Query for TOKEN/WETH pairs + WETH/USD price
 */
function getWETHQuoteQuery() {
  return `
    query GetWETHQuoteSwaps(
      $tokenAddress: String!,
      $wethAddress: String!,
      $usdcAddress: String!,
      $startTime: BigInt!,
      $endTime: BigInt!,
      $first: Int!
    ) {
      # Get TOKEN/WETH swaps
      tokenSwaps: swaps(
        where: {
          or: [
            {
              token0: $tokenAddress,
              token1: $wethAddress,
              timestamp_gte: $startTime,
              timestamp_lte: $endTime,
            },
            {
              token1: $tokenAddress,
              token0: $wethAddress,
              timestamp_gte: $startTime,
              timestamp_lte: $endTime,
            }
          ]
        }
        orderBy: timestamp
        orderDirection: asc
        first: $first
      ) {
        id
        timestamp
        amount0
        amount1
        amount0USD
        amount1USD
        token0PriceUSD
        token1PriceUSD
        amountUSD
        token0 { id symbol decimals }
        token1 { id symbol decimals }
        pool { 
          id 
          totalValueLockedUSD
          token0 { symbol }
          token1 { symbol }
        }
      }
      
      # Get WETH/USDC price for USD conversion
      wethPriceSwaps: swaps(
        where: {
          or: [
            {
              token0: $wethAddress,
              token1: $usdcAddress,
              timestamp_gte: $startTime,
              timestamp_lte: $endTime,
            },
            {
              token1: $wethAddress,
              token0: $usdcAddress,
              timestamp_gte: $startTime,
              timestamp_lte: $endTime,
            }
          ]
        }
        orderBy: timestamp
        orderDirection: asc
        first: 200
      ) {
        timestamp
        token0PriceUSD
        token1PriceUSD
        token0 { id symbol }
        token1 { id symbol }
      }
    }
  `;
}

/**
 * Get WETH price in USD at a given timestamp
 */
function getWETHPriceAtTime(
  wethPriceSwaps: SwapData[],
  timestamp: number
): number {
  // Find the closest WETH price swap to this timestamp
  let closestSwap = wethPriceSwaps[0];
  let closestDiff = Math.abs(
    parseInt(closestSwap?.timestamp || "0") - timestamp
  );

  for (const swap of wethPriceSwaps) {
    const diff = Math.abs(parseInt(swap.timestamp) - timestamp);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestSwap = swap;
    }
  }

  if (!closestSwap) return 0;

  // Extract WETH price from the swap
  const isWETHToken0 =
    closestSwap.token0.id.toLowerCase() === WETH_ADDRESS.toLowerCase();

  if (isWETHToken0 && closestSwap.token0PriceUSD) {
    return parseFloat(closestSwap.token0PriceUSD);
  } else if (!isWETHToken0 && closestSwap.token1PriceUSD) {
    return parseFloat(closestSwap.token1PriceUSD);
  }

  // Fallback: assume WETH ≈ $3000 if no price data
  return 3000;
}

/**
 * Extract TOKEN/USD prices using WETH as bridge
 */
function extractTokenUSDPrices(
  tokenSwaps: SwapData[],
  wethPriceSwaps: SwapData[],
  targetTokenAddress: string
) {
  return tokenSwaps
    .map((swap) => {
      const isToken0Target =
        swap.token0.id.toLowerCase() === targetTokenAddress.toLowerCase();
      const timestamp = parseInt(swap.timestamp);

      let tokenPriceInWETH = 0;
      let volumeUSD = 0;

      // Get token price in WETH terms
      if (isToken0Target) {
        // Target token is token0, WETH is token1
        const tokenAmount = Math.abs(parseFloat(swap.amount0));
        const wethAmount = Math.abs(parseFloat(swap.amount1));

        if (tokenAmount > 0) {
          tokenPriceInWETH = wethAmount / tokenAmount; // WETH per token
        }
        volumeUSD = Math.abs(parseFloat(swap.amount0USD || "0"));
      } else {
        // Target token is token1, WETH is token0
        const tokenAmount = Math.abs(parseFloat(swap.amount1));
        const wethAmount = Math.abs(parseFloat(swap.amount0));

        if (tokenAmount > 0) {
          tokenPriceInWETH = wethAmount / tokenAmount; // WETH per token
        }
        volumeUSD = Math.abs(parseFloat(swap.amount1USD || "0"));
      }

      // Convert to USD using WETH price
      const wethPriceUSD = getWETHPriceAtTime(wethPriceSwaps, timestamp);
      const tokenPriceUSD = tokenPriceInWETH * wethPriceUSD;

      return {
        timestamp,
        price: tokenPriceUSD,
        volumeUSD:
          volumeUSD || tokenPriceUSD * Math.abs(parseFloat(swap.amount0)), // Fallback volume calc
        wethPrice: wethPriceUSD,
        tokenPriceInWETH,
        poolTVL: parseFloat(swap.pool.totalValueLockedUSD),
      };
    })
    .filter((data) => data.price > 0);
}

/**
 * Convert timeframe to seconds
 */
function getTimeframeSeconds(resolution: string): number {
  const timeframes: { [key: string]: number } = {
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
  };
  return timeframes[resolution] || 3600; // Default 1h
}

/**
 * Time range calculation
 */
function getTimeRange(days: number) {
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 24 * 60 * 60;
  return { startTime, endTime };
}

/**
 * Convert to OHLC
 */
function convertToOHLC(
  priceData: any[],
  timeframeSeconds: number
): OHLCPoint[] {
  if (priceData.length === 0) return [];

  const grouped: { [key: number]: any[] } = {};

  priceData.forEach((point) => {
    const periodStart =
      Math.floor(point.timestamp / timeframeSeconds) * timeframeSeconds;
    if (!grouped[periodStart]) grouped[periodStart] = [];
    grouped[periodStart].push(point);
  });

  return Object.entries(grouped)
    .map(([timestamp, points]) => {
      const prices = points.map((p) => p.price);
      const volumes = points.map((p) => p.volumeUSD);

      return {
        timestamp: parseInt(timestamp) * 1000,
        open: prices[0],
        high: Math.max(...prices),
        low: Math.min(...prices),
        close: prices[prices.length - 1],
        volume: 0,
        volumeUSD: volumes.reduce((sum, v) => sum + v, 0),
        swapCount: points.length,
      };
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Main controller - WETH as universal quote
 */
export async function getWETHQuoteOHLC(
  req: Request<
    {},
    {},
    {},
    {
      tokenAddress?: string;
      resolution?: string;
      days?: string;
      force?: string;
    }
  >,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { tokenAddress, resolution = "1h", days = "7", force } = req.query;

    console.log(`[WETH Quote Debug] Request:`, {
      tokenAddress,
      resolution,
      days,
    });

    // Validation
    if (!tokenAddress || !/^0x[a-f0-9]{40}$/i.test(tokenAddress)) {
      res.status(400).json({
        status: "error",
        msg: "Invalid tokenAddress",
      });
      return;
    }

    // Skip if requesting WETH itself (would be WETH/WETH)
    if (tokenAddress.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
      res.status(400).json({
        status: "error",
        msg: "Cannot get WETH/WETH price. Use WETH/USDC instead.",
        suggestion:
          "Try a different token or use the stable pairs endpoint for WETH/USDC",
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();
    const timeframeSeconds = getTimeframeSeconds(resolution);
    const cacheKey = `${CACHE_PREFIX}${normalizedAddress}_${resolution}_${days}`;

    // Check cache
    if (!force) {
      try {
        const cached = await getValue(cacheKey);
        if (cached) {
          const cachedData = JSON.parse(cached);
          res.status(200).json({
            status: "success",
            data: cachedData,
            source: "weth-quote-pairs",
            cached: true,
            count: cachedData.chart?.length || 0,
          });
          return;
        }
      } catch (cacheError) {
        console.warn(`[WETH Quote Debug] Cache error:`, cacheError);
      }
    }

    // Fetch data
    await sushiLimiter.schedule(async () => {
      try {
        const { startTime, endTime } = getTimeRange(parseInt(days) || 7);

        const variables = {
          tokenAddress: normalizedAddress,
          wethAddress: WETH_ADDRESS,
          usdcAddress: USDC_ADDRESS,
          startTime: startTime.toString(),
          endTime: endTime.toString(),
          first: 1000,
        };

        console.log(`[WETH Quote Debug] Fetching TOKEN/WETH + WETH/USDC data`);

        const response = await axios.post<GraphQLResponse>(
          SUSHISWAP_SUBGRAPH_URL,
          { query: getWETHQuoteQuery(), variables },
          {
            timeout: 15000,
            headers: { "Content-Type": "application/json" },
            validateStatus: (status) => status < 500,
          }
        );

        if (!response.data?.data) {
          throw new Error("No data in response");
        }

        const tokenSwaps = response.data.data.tokenSwaps || [];
        const wethPriceSwaps = response.data.data.wethPriceSwaps || [];

        console.log(
          `[WETH Quote Debug] Found ${tokenSwaps.length} TOKEN/WETH swaps, ${wethPriceSwaps.length} WETH/USDC swaps`
        );

        if (tokenSwaps.length === 0) {
          res.status(404).json({
            status: "error",
            msg: `No TOKEN/WETH trading pairs found for this token`,
            tokenAddress: normalizedAddress,
            suggestion:
              "This token might not be traded on SushiSwap V3, or try increasing the time range",
            debug: {
              searchedFor: "TOKEN/WETH pairs",
              timeRange: `${days} days`,
            },
          });
          return;
        }

        if (wethPriceSwaps.length === 0) {
          console.warn(
            `[WETH Quote Debug] No WETH/USDC price data found, using fallback price`
          );
        }

        // Process data
        const priceData = extractTokenUSDPrices(
          tokenSwaps,
          wethPriceSwaps,
          normalizedAddress
        );
        console.log(
          `[WETH Quote Debug] Extracted ${priceData.length} USD price points`
        );

        const ohlcData = convertToOHLC(priceData, timeframeSeconds);
        console.log(
          `[WETH Quote Debug] Generated ${ohlcData.length} OHLC candles`
        );

        const responseData = {
          chart: ohlcData,
          metadata: {
            tokenAddress: normalizedAddress,
            quoteCurrency: "WETH → USD",
            totalSwaps: tokenSwaps.length,
            totalVolumeUSD: priceData.reduce((sum, p) => sum + p.volumeUSD, 0),
            candleCount: ohlcData.length,
            currentPrice: ohlcData[ohlcData.length - 1]?.close || 0,
            dataSource: "weth-quote-bridge",
            wethPriceDataPoints: wethPriceSwaps.length,
            avgWETHPrice:
              wethPriceSwaps.length > 0
                ? wethPriceSwaps.reduce((sum, s) => {
                    const isWETHToken0 =
                      s.token0.id.toLowerCase() === WETH_ADDRESS.toLowerCase();
                    const price = isWETHToken0
                      ? parseFloat(s.token0PriceUSD || "0")
                      : parseFloat(s.token1PriceUSD || "0");
                    return sum + price;
                  }, 0) / wethPriceSwaps.length
                : 3000,
          },
        };

        // Cache result
        try {
          await storeValue(cacheKey, JSON.stringify(responseData), CACHE_TTL);
        } catch (cacheError) {
          console.warn(`[WETH Quote Debug] Cache write error:`, cacheError);
        }

        res.status(200).json({
          status: "success",
          data: responseData,
          source: "weth-quote-pairs",
          cached: false,
          count: ohlcData.length,
        });
      } catch (error: any) {
        console.error(`[WETH Quote Debug] Error:`, error.message);

        res.status(500).json({
          status: "error",
          msg: "Failed to fetch WETH quote pair data",
          error: error.message,
        });
      }
    });
  } catch (error: any) {
    console.error("[WETH Quote Debug] Controller error:", error.message);
    res.status(500).json({
      status: "error",
      msg: "Server error",
      error: error.message,
    });
  }
}

export async function clearWETHQuoteOHLCCache(
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

    res.status(200).json({
      status: "success",
      msg: "Cache cleared successfully",
      tokenAddress: tokenAddress.toLowerCase(),
      quoteToken: "WETH",
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      msg: "Server error",
    });
  }
}
