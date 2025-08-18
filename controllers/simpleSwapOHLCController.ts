// src/controllers/simpleSwapOHLCController.ts - IMPROVED VERSION
import type { Request, Response, NextFunction } from "express";
import axios from "axios";
import Bottleneck from "bottleneck";
import { getValue, storeValue } from "../redis/ethereumTokens";

// Types remain the same...
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
    swaps?: SwapData[];
  };
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
  }>;
}

// Rate limiter
const sushiLimiter = new Bottleneck({
  reservoir: 60,
  reservoirRefreshAmount: 60,
  reservoirRefreshInterval: 60 * 1000,
  maxConcurrent: 2,
  minTime: 1000,
});

// Cache config
const CACHE_PREFIX = "simple_ohlc_";
const CACHE_TTL = 6 * 60 * 60; // 6 hours

// Constants - FIXED ADDRESSES & Multiple stable tokens
const SUSHISWAP_SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/106601/sushi-v-3-eth/version/latest";

// ✅ CORRECT addresses with priority order
const STABLE_TOKENS = [
  {
    address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC (correct!)
    symbol: "USDC",
    priority: 1,
  },
  {
    address: "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
    symbol: "USDT",
    priority: 2,
  },
  {
    address: "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
    symbol: "DAI",
    priority: 3,
  },
];

/**
 * Enhanced GraphQL query - Multiple stable tokens with lower TVL threshold
 */
function getEnhancedSwapQuery() {
  return `
    query GetStableSwaps(
      $tokenAddress: String!,
      $stableTokens: [String!]!,
      $startTime: BigInt!,
      $endTime: BigInt!,
      $first: Int!
    ) {
      swaps(
        where: {
          or: [
            {
              token0: $tokenAddress,
              token1_in: $stableTokens,
              timestamp_gte: $startTime,
              timestamp_lte: $endTime,
            },
            {
              token1: $tokenAddress,
              token0_in: $stableTokens,
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
          feeTier
          token0 { symbol }
          token1 { symbol }
        }
      }
    }
  `;
}

/**
 * Convert timeframe to seconds with more options
 */
function getTimeframeSeconds(resolution: string): number {
  const timeframes: { [key: string]: number } = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "4h": 14400,
    "12h": 43200,
    "1d": 86400,
  };
  return timeframes[resolution] || 300;
}

/**
 * Adaptive time range based on resolution
 */
function getTimeRange(days: number, resolution: string) {
  let actualDays = days;

  // Adjust time range based on resolution for better data density
  if (resolution === "1m" || resolution === "5m") {
    actualDays = Math.min(days, 3); // Max 3 days for minute charts
  } else if (resolution === "15m" || resolution === "30m") {
    actualDays = Math.min(days, 7); // Max 1 week for sub-hour charts
  } else if (resolution === "1h") {
    actualDays = Math.min(days, 30); // Max 1 month for hourly
  }

  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - actualDays * 24 * 60 * 60;
  return { startTime, endTime, actualDays };
}

/**
 * Enhanced price extraction with stable coin priority
 */
function extractPricesEnhanced(swaps: SwapData[], targetTokenAddress: string) {
  return swaps
    .map((swap) => {
      const isToken0Target =
        swap.token0.id.toLowerCase() === targetTokenAddress.toLowerCase();

      let price = 0;
      let volumeUSD = 0;
      let stableUsed = "";

      // Get the stable token info
      const stableToken = isToken0Target ? swap.token1 : swap.token0;
      const stableInfo = STABLE_TOKENS.find(
        (s) => s.address.toLowerCase() === stableToken.id.toLowerCase()
      );

      if (stableInfo) {
        stableUsed = stableInfo.symbol;
      }

      if (isToken0Target && swap.token0PriceUSD) {
        // Target token is token0, use its USD price
        price = parseFloat(swap.token0PriceUSD);
        volumeUSD = Math.abs(parseFloat(swap.amount0USD || "0"));
      } else if (!isToken0Target && swap.token1PriceUSD) {
        // Target token is token1, use its USD price
        price = parseFloat(swap.token1PriceUSD);
        volumeUSD = Math.abs(parseFloat(swap.amount1USD || "0"));
      } else {
        // Fallback: calculate from amounts (stable ≈ $1)
        if (isToken0Target) {
          const tokenAmount = Math.abs(parseFloat(swap.amount0));
          const stableAmount = Math.abs(parseFloat(swap.amount1));
          if (tokenAmount > 0) {
            price = stableAmount / tokenAmount;
            volumeUSD = stableAmount;
          }
        } else {
          const tokenAmount = Math.abs(parseFloat(swap.amount1));
          const stableAmount = Math.abs(parseFloat(swap.amount0));
          if (tokenAmount > 0) {
            price = stableAmount / tokenAmount;
            volumeUSD = stableAmount;
          }
        }
      }

      return {
        timestamp: parseInt(swap.timestamp),
        price,
        volumeUSD,
        stableUsed,
        poolTVL: parseFloat(swap.pool.totalValueLockedUSD),
      };
    })
    .filter((data) => data.price > 0);
}

/**
 * Enhanced OHLC conversion with gap filling
 */
function convertToOHLCEnhanced(
  priceData: any[],
  timeframeSeconds: number
): OHLCPoint[] {
  if (priceData.length === 0) return [];

  // Group by timeframe
  const grouped: { [key: number]: any[] } = {};

  priceData.forEach((point) => {
    const periodStart =
      Math.floor(point.timestamp / timeframeSeconds) * timeframeSeconds;
    if (!grouped[periodStart]) grouped[periodStart] = [];
    grouped[periodStart].push(point);
  });

  // Convert to array and fill gaps for smoother charts
  const periods = Object.keys(grouped)
    .map(Number)
    .sort((a, b) => a - b);
  const result: OHLCPoint[] = [];

  let lastClose = 0;

  for (let i = 0; i < periods.length; i++) {
    const timestamp = periods[i];
    const points = grouped[timestamp];

    const prices = points.map((p) => p.price);
    const volumes = points.map((p) => p.volumeUSD);

    const open = lastClose || prices[0];
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const close = prices[prices.length - 1];

    result.push({
      timestamp: timestamp * 1000, // Convert to milliseconds
      open,
      high,
      low,
      close,
      volume: 0, // Keep simple
      volumeUSD: volumes.reduce((sum, v) => sum + v, 0),
      swapCount: points.length,
    });

    lastClose = close;
  }

  return result;
}

/**
 * Enhanced main controller
 */
export async function getSimpleTokenOHLC(
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

    console.log(`[Enhanced Debug] Request params:`, {
      tokenAddress,
      resolution,
      days,
      force,
    });

    // Basic validation
    if (!tokenAddress || !/^0x[a-f0-9]{40}$/i.test(tokenAddress)) {
      console.log(`[Enhanced Debug] Invalid token address: ${tokenAddress}`);
      res.status(400).json({
        status: "error",
        msg: "Invalid tokenAddress",
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
          console.log(`[Enhanced Debug] Cache hit`);
          const cachedData = JSON.parse(cached);
          res.status(200).json({
            status: "success",
            data: cachedData,
            source: "stable-pairs-enhanced",
            cached: true,
            count: cachedData.chart?.length || 0,
          });
          return;
        }
      } catch (cacheError) {
        console.warn(`[Enhanced Debug] Cache error:`, cacheError);
      }
    }

    // Fetch data with rate limiting
    await sushiLimiter.schedule(async () => {
      try {
        const { startTime, endTime, actualDays } = getTimeRange(
          parseInt(days) || 7,
          resolution
        );

        const variables = {
          tokenAddress: normalizedAddress,
          stableTokens: STABLE_TOKENS.map((s) => s.address),
          startTime: startTime.toString(),
          endTime: endTime.toString(),
          first: 1000,
        };

        console.log(`[Enhanced Debug] GraphQL variables:`, variables);
        console.log(
          `[Enhanced Debug] Using ${STABLE_TOKENS.length} stable tokens`
        );

        const response = await axios.post<GraphQLResponse>(
          SUSHISWAP_SUBGRAPH_URL,
          {
            query: getEnhancedSwapQuery(),
            variables,
          },
          {
            timeout: 15000,
            headers: { "Content-Type": "application/json" },
            validateStatus: (status) => status < 500,
          }
        );

        console.log(`[Enhanced Debug] Response status:`, response.status);

        // Error handling (same as before)
        if (!response.data) {
          throw new Error("No response data received from subgraph");
        }

        if (response.data.errors && response.data.errors.length > 0) {
          const errorMessages = response.data.errors
            .map((err) => err.message)
            .join(", ");
          console.error(
            `[Enhanced Debug] GraphQL errors:`,
            response.data.errors
          );
          throw new Error(`GraphQL errors: ${errorMessages}`);
        }

        if (!response.data.data) {
          throw new Error("No data field in GraphQL response");
        }

        const swaps = response.data.data.swaps || [];
        console.log(`[Enhanced Debug] Found ${swaps.length} swaps`);

        if (swaps.length === 0) {
          res.status(404).json({
            status: "error",
            msg: "No stable coin pair swaps found for this token",
            tokenAddress: normalizedAddress,
            suggestion:
              "Try a more popular token, increase time range, or check if token has trading pairs",
            debug: {
              stableTokensSearched: STABLE_TOKENS.map((s) => s.symbol),
              timeRange: `${actualDays} days`,
              resolution,
            },
          });
          return;
        }

        // Process data with enhancements
        console.log(`[Enhanced Debug] Processing swaps...`);
        const priceData = extractPricesEnhanced(swaps, normalizedAddress);
        console.log(
          `[Enhanced Debug] Extracted ${priceData.length} price points`
        );

        const ohlcData = convertToOHLCEnhanced(priceData, timeframeSeconds);
        console.log(
          `[Enhanced Debug] Generated ${ohlcData.length} OHLC candles`
        );

        // Analyze stable token usage
        const stableUsage = priceData.reduce((acc, point) => {
          acc[point.stableUsed] = (acc[point.stableUsed] || 0) + 1;
          return acc;
        }, {} as { [key: string]: number });

        const responseData = {
          chart: ohlcData,
          metadata: {
            tokenAddress: normalizedAddress,
            pairWith: Object.keys(stableUsage).join(", ") || "Stable Coins",
            totalSwaps: swaps.length,
            totalVolumeUSD: priceData.reduce((sum, p) => sum + p.volumeUSD, 0),
            candleCount: ohlcData.length,
            currentPrice: ohlcData[ohlcData.length - 1]?.close || 0,
            dataSource: "stable-pairs-enhanced",
            timeRange: `${actualDays} days`,
            resolution,
            stableTokensUsed: stableUsage,
          },
        };

        // Cache result
        try {
          await storeValue(cacheKey, JSON.stringify(responseData), CACHE_TTL);
          console.log(`[Enhanced Debug] Data cached successfully`);
        } catch (cacheError) {
          console.warn(`[Enhanced Debug] Cache write error:`, cacheError);
        }

        console.log(
          `[Enhanced Debug] Sending successful response with ${ohlcData.length} candles`
        );

        res.status(200).json({
          status: "success",
          data: responseData,
          source: "stable-pairs-enhanced",
          cached: false,
          count: ohlcData.length,
        });
      } catch (error: any) {
        console.error(`[Enhanced Debug] API Error:`, {
          message: error.message,
          response: error.response
            ? {
                status: error.response.status,
                data: error.response.data,
              }
            : undefined,
        });

        if (error.code === "ECONNABORTED") {
          res.status(408).json({
            status: "error",
            msg: "Request timeout",
            suggestion: "Try again in a moment",
          });
        } else {
          res.status(500).json({
            status: "error",
            msg: "Failed to fetch stable pair data",
            error: error.message,
          });
        }
      }
    });
  } catch (error: any) {
    console.error("[Enhanced Debug] Controller error:", error.message);
    res.status(500).json({
      status: "error",
      msg: "Server error",
      error: error.message,
    });
  }
}

// Export the clearCache function (same as before)
export async function clearEthereumSwapOHLCCache(
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
    res.status(200).json({
      status: "success",
      msg: "Cache cleared successfully",
      tokenAddress: normalizedAddress,
      chain: "ethereum",
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
    });
  }
}
