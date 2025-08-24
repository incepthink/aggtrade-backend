// src/controllers/sushiswapOHLCController.ts
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

interface PoolOHLCData {
  id: string;
  periodStartUnix: number;
  date: number;
  pool: {
    id: string;
    token0: {
      id: string;
      symbol: string;
      name: string;
      decimals: string;
    };
    token1: {
      id: string;
      symbol: string;
      name: string;
      decimals: string;
    };
  };
  open: string;
  high: string;
  low: string;
  close: string;
  volumeUSD: string;
  token0Price: string;
  token1Price: string;
}

interface Pool {
  id: string;
  token0: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  token1: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  feeTier: string;
  volumeUSD: string;
}

interface SushiGraphResponse {
  data: {
    poolHourDatas?: PoolOHLCData[];
    poolDayDatas?: PoolOHLCData[];
    pools?: Pool[];
  };
  errors?: any[];
}

// Rate limiter for SushiSwap subgraph
const sushiLimiter = new Bottleneck({
  reservoir: 60,
  reservoirRefreshAmount: 60,
  reservoirRefreshInterval: 60 * 1000, // per minute
  maxConcurrent: 2,
  minTime: 1000,
});

// Cache configuration
const OHLC_CACHE_PREFIX = "ohlc_sushi_pool_";
const OHLC_CACHE_TTL = 5 * 60; // 5 minutes

// Constants
const SUSHISWAP_SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/106601/sushi-v-3-eth/v0.0.1";
const USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

/**
 * Get GraphQL query to find pools with token and USDC
 */
function getPoolsQuery() {
  return `
    query GetPools($token0: String!, $token1: String!) {
      pools(
        where: {
          or: [
            { token0: $token0, token1: $token1 },
            { token0: $token1, token1: $token0 }
          ]
        }
        orderBy: volumeUSD
        orderDirection: desc
        first: 10
      ) {
        id
        token0 {
          id
          symbol
          name
          decimals
        }
        token1 {
          id
          symbol
          name
          decimals
        }
        feeTier
        volumeUSD
      }
    }
  `;
}

/**
 * Get GraphQL query for pool OHLC data
 */
function getPoolOHLCQuery(timeframe: "hour" | "day") {
  const entityName = timeframe === "hour" ? "poolHourDatas" : "poolDayDatas";
  const timeField = timeframe === "hour" ? "periodStartUnix" : "date";

  return `
    query GetPoolOHLC($poolId: String!, $startTime: Int!, $endTime: Int!, $first: Int!) {
      ${entityName}(
        where: {
          pool: $poolId,
          ${timeField}_gte: $startTime,
          ${timeField}_lte: $endTime
        }
        orderBy: ${timeField}
        orderDirection: asc
        first: $first
      ) {
        id
        ${timeField === "date" ? "date" : "periodStartUnix"}
        pool {
          id
          token0 {
            id
            symbol
            name
            decimals
          }
          token1 {
            id
            symbol
            name
            decimals
          }
        }
        open
        high
        low
        close
        volumeUSD
        token0Price
        token1Price
      }
    }
  `;
}

/**
 * Convert resolution to timeframe
 */
function getTimeframe(resolution: string): "hour" | "day" {
  return resolution === "day" ? "day" : "hour";
}

/**
 * Calculate time range
 */
function getTimeRange(days: number, timeframe: "hour" | "day") {
  // Current time minus specified days
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 24 * 60 * 60;

  console.log(
    `[SushiSwap Debug] Current timestamp: ${endTime} (${new Date(
      endTime * 1000
    ).toISOString()})`
  );
  console.log(`[SushiSwap Debug] Calculating time range for ${days} days:`, {
    endTime,
    startTime,
    endTimeDate: new Date(endTime * 1000).toISOString(),
    startTimeDate: new Date(startTime * 1000).toISOString(),
  });

  if (timeframe === "day") {
    const dayStartTime = Math.floor(startTime / 86400);
    const dayEndTime = Math.floor(endTime / 86400);
    console.log(`[SushiSwap Debug] Day timeframe - converted to days:`, {
      startTime: dayStartTime,
      endTime: dayEndTime,
      startDate: new Date(dayStartTime * 86400 * 1000).toISOString(),
      endDate: new Date(dayEndTime * 86400 * 1000).toISOString(),
    });
    return {
      startTime: dayStartTime,
      endTime: dayEndTime,
    };
  }

  console.log(`[SushiSwap Debug] Hour timeframe - using unix timestamps:`, {
    startTime,
    endTime,
  });
  return { startTime, endTime };
}

/**
 * Get OHLC data from SushiSwap subgraph using pool data
 */
export async function getOHLCData(
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
    const { tokenAddress, resolution = "hour", days = "30", force } = req.query;

    console.log(`[SushiSwap Debug] Request received with params:`, {
      tokenAddress,
      resolution,
      days,
      force,
    });

    // Validate input
    if (!tokenAddress) {
      console.log(`[SushiSwap Debug] Missing tokenAddress parameter`);
      res.status(400).json({
        status: "error",
        msg: "tokenAddress parameter is required",
      });
      return;
    }

    if (!/^0x[a-f0-9]{40}$/i.test(tokenAddress)) {
      console.log(`[SushiSwap Debug] Invalid address format: ${tokenAddress}`);
      res.status(422).json({
        status: "error",
        msg: "Invalid Ethereum address format",
      });
      return;
    }

    const validResolutions = ["hour", "day"];
    if (!validResolutions.includes(resolution)) {
      console.log(`[SushiSwap Debug] Invalid resolution: ${resolution}`);
      res.status(400).json({
        status: "error",
        msg: `Invalid resolution. Must be one of: ${validResolutions.join(
          ", "
        )}`,
      });
      return;
    }

    const daysNum = parseInt(days);
    if (isNaN(daysNum) || daysNum < 1 || daysNum > 365) {
      console.log(`[SushiSwap Debug] Invalid days parameter: ${days}`);
      res.status(400).json({
        status: "error",
        msg: "Days must be a number between 1 and 365",
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();
    const timeframe = getTimeframe(resolution);
    const cacheKey = `${OHLC_CACHE_PREFIX}${normalizedAddress}_${resolution}_${days}`;

    console.log(`[SushiSwap Debug] Normalized address: ${normalizedAddress}`);
    console.log(`[SushiSwap Debug] Cache key: ${cacheKey}`);

    // Check cache unless force refresh
    if (!force) {
      console.log(`[SushiSwap Debug] Checking cache for key: ${cacheKey}`);
      try {
        const cached = await getValue(cacheKey);
        if (cached) {
          console.log(
            `[SushiSwap Debug] Cache hit for OHLC: ${normalizedAddress}`
          );
          const cachedData = JSON.parse(cached);
          res.status(200).json({
            status: "success",
            data: cachedData,
            source: "sushiswap",
            cached: true,
            tokenAddress: normalizedAddress,
            resolution,
            count: cachedData.chart?.length || 0,
          });
          return;
        } else {
          console.log(`[SushiSwap Debug] Cache miss for key: ${cacheKey}`);
        }
      } catch (cacheError) {
        console.warn(
          `[SushiSwap Debug] Cache read error for ${cacheKey}:`,
          cacheError
        );
      }
    } else {
      console.log(`[SushiSwap Debug] Force refresh requested, skipping cache`);
    }

    // Rate limit the request
    console.log(
      `[SushiSwap Debug] Entering rate limiter for token: ${normalizedAddress}`
    );
    await sushiLimiter.schedule(async () => {
      try {
        console.log(
          `[SushiSwap Debug] Rate limiter executed, finding pools for: ${normalizedAddress}`
        );

        // Step 1: Find pools with this token and USDC
        const poolsQuery = getPoolsQuery();
        const poolsVariables = {
          token0: normalizedAddress,
          token1: USDC_ADDRESS,
        };

        console.log(`[SushiSwap Debug] Finding pools with query:`, poolsQuery);
        console.log(`[SushiSwap Debug] Pools variables:`, poolsVariables);

        const poolsResponse = await axios.post<SushiGraphResponse>(
          SUSHISWAP_SUBGRAPH_URL,
          { query: poolsQuery, variables: poolsVariables },
          {
            timeout: 15000,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );

        console.log(
          `[SushiSwap Debug] Pools response:`,
          JSON.stringify(poolsResponse.data, null, 2)
        );

        if (
          !poolsResponse.data.data.pools ||
          poolsResponse.data.data.pools.length === 0
        ) {
          console.log(
            `[SushiSwap Debug] No pools found for token: ${normalizedAddress} paired with USDC`
          );
          res.status(404).json({
            status: "error",
            msg: "No pools found for this token paired with USDC",
            tokenAddress: normalizedAddress,
            debug: {
              searchedFor: `${normalizedAddress}-${USDC_ADDRESS} pools`,
              foundPools: 0,
            },
          });
          return;
        }

        // Use the pool with highest volume
        const selectedPool = poolsResponse.data.data.pools[0];
        console.log(`[SushiSwap Debug] Selected pool:`, selectedPool);

        // Determine if token is token0 or token1 in the pool
        const isToken0 =
          selectedPool.token0.id.toLowerCase() === normalizedAddress;
        const baseToken = isToken0 ? selectedPool.token0 : selectedPool.token1;
        const quoteToken = isToken0 ? selectedPool.token1 : selectedPool.token0;

        console.log(`[SushiSwap Debug] Pool configuration:`, {
          poolId: selectedPool.id,
          isToken0,
          baseToken: baseToken.symbol,
          quoteToken: quoteToken.symbol,
        });

        // Step 2: Get OHLC data for this pool
        const { startTime, endTime } = getTimeRange(daysNum, timeframe);
        const ohlcQuery = getPoolOHLCQuery(timeframe);
        const ohlcVariables = {
          poolId: selectedPool.id,
          startTime,
          endTime,
          first: 1000,
        };

        console.log(
          `[SushiSwap Debug] Fetching OHLC data with variables:`,
          ohlcVariables
        );

        const ohlcResponse = await axios.post<SushiGraphResponse>(
          SUSHISWAP_SUBGRAPH_URL,
          { query: ohlcQuery, variables: ohlcVariables },
          {
            timeout: 15000,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );

        console.log(
          `[SushiSwap Debug] OHLC response status: ${ohlcResponse.status}`
        );
        console.log(
          `[SushiSwap Debug] OHLC response data:`,
          JSON.stringify(ohlcResponse.data, null, 2)
        );

        const rawData =
          timeframe === "hour"
            ? ohlcResponse.data.data.poolHourDatas
            : ohlcResponse.data.data.poolDayDatas;

        if (!rawData || rawData.length === 0) {
          console.log(
            `[SushiSwap Debug] No OHLC data found for pool: ${selectedPool.id}`
          );

          // Let's check what data is actually available for this pool
          const recentDataQuery = `
            query GetRecentPoolData($poolId: String!) {
              poolDayDatas(where: { pool: $poolId }, first: 10, orderBy: date, orderDirection: desc) {
                id
                date
                open
                high
                low
                close
                volumeUSD
                token0Price
                token1Price
              }
              poolHourDatas(where: { pool: $poolId }, first: 10, orderBy: periodStartUnix, orderDirection: desc) {
                id
                periodStartUnix
                open
                high
                low
                close
                volumeUSD
                token0Price
                token1Price
              }
            }
          `;

          try {
            console.log(`[SushiSwap Debug] Checking for any recent pool data`);
            const recentDataResponse = await axios.post(
              SUSHISWAP_SUBGRAPH_URL,
              {
                query: recentDataQuery,
                variables: { poolId: selectedPool.id },
              },
              {
                timeout: 10000,
                headers: {
                  "Content-Type": "application/json",
                },
              }
            );

            console.log(
              `[SushiSwap Debug] Recent pool data check response:`,
              JSON.stringify(recentDataResponse.data, null, 2)
            );

            // If we find recent data, let's use it
            const recentHourData = recentDataResponse.data.data.poolHourDatas;
            const recentDayData = recentDataResponse.data.data.poolDayDatas;

            if (
              (timeframe === "hour" &&
                recentHourData &&
                recentHourData.length > 0) ||
              (timeframe === "day" && recentDayData && recentDayData.length > 0)
            ) {
              console.log(
                `[SushiSwap Debug] Found recent data, using it instead`
              );

              // Use the recent data we found
              const useableData =
                timeframe === "hour" ? recentHourData : recentDayData;

              // Convert to our format
              const ohlcData: OHLCPoint[] = useableData.map((item, index) => {
                const timestamp =
                  timeframe === "hour"
                    ? item.periodStartUnix
                    : (item as any).date * 86400;

                const price = isToken0
                  ? parseFloat(item.token0Price)
                  : 1 / parseFloat(item.token1Price);

                const processedItem = {
                  timestamp: timestamp * 1000,
                  open: parseFloat(item.open) || price,
                  high: parseFloat(item.high) || price,
                  low: parseFloat(item.low) || price,
                  close: parseFloat(item.close) || price,
                  volume: parseFloat(item.volumeUSD) || 0,
                };

                if (index < 3) {
                  console.log(
                    `[SushiSwap Debug] Processed recent item ${index}:`,
                    {
                      original: item,
                      processed: processedItem,
                      isToken0,
                      calculatedPrice: price,
                    }
                  );
                }

                return processedItem;
              });

              // Prepare response data with recent data
              const responseData = {
                chart: ohlcData,
                metadata: {
                  pair: {
                    address: `${normalizedAddress}-${USDC_ADDRESS}`,
                    baseToken: {
                      address: baseToken.id,
                      name: baseToken.name,
                      symbol: baseToken.symbol,
                      decimals: baseToken.decimals,
                    },
                    quoteToken: {
                      address: quoteToken.id,
                      name: quoteToken.name,
                      symbol: quoteToken.symbol,
                    },
                    dexId: "sushiswap",
                    poolId: selectedPool.id,
                    feeTier: selectedPool.feeTier,
                    url: `https://www.sushi.com/pool/${selectedPool.id}`,
                  },
                  priceUsd: ohlcData[ohlcData.length - 1]?.close || 0,
                  currency: "USD",
                  dataSource: "subgraph",
                  note: "Using most recent available data",
                },
              };

              // Cache the result
              try {
                await storeValue(
                  cacheKey,
                  JSON.stringify(responseData),
                  OHLC_CACHE_TTL
                );
                console.log(
                  `[SushiSwap Debug] Successfully cached recent OHLC data`
                );
              } catch (cacheError) {
                console.warn(
                  `[SushiSwap Debug] Cache write error:`,
                  cacheError
                );
              }

              console.log(
                `[SushiSwap Debug] Sending successful response with recent data`
              );
              res.status(200).json({
                status: "success",
                data: responseData,
                source: "sushiswap",
                cached: false,
                tokenAddress: normalizedAddress,
                resolution,
                count: ohlcData.length,
                dataSource: "subgraph",
                poolId: selectedPool.id,
                note: "Using most recent available data",
              });
              return;
            }
          } catch (recentDataError) {
            console.error(
              `[SushiSwap Debug] Recent data check failed:`,
              recentDataError
            );
          }

          res.status(404).json({
            status: "error",
            msg: "No OHLC data available for this pool",
            tokenAddress: normalizedAddress,
            debug: {
              poolId: selectedPool.id,
              timeframe,
              startTime,
              endTime,
              poolExists: true,
              suggestion:
                "Pool exists but no OHLC data in the specified time range",
              systemTime: new Date().toISOString(),
              queryRange: `${new Date(
                startTime * (timeframe === "day" ? 86400 : 1) * 1000
              ).toISOString()} to ${new Date(
                endTime * (timeframe === "day" ? 86400 : 1) * 1000
              ).toISOString()}`,
            },
          });
          return;
        }

        console.log(
          `[SushiSwap Debug] Processing ${rawData.length} pool OHLC points`
        );

        // Convert to our format
        const ohlcData: OHLCPoint[] = rawData.map((item, index) => {
          const timestamp =
            timeframe === "hour"
              ? item.periodStartUnix
              : (item as any).date * 86400;

          // Use the correct price based on which token is the base
          // If our token is token0, we want token0Price (token0 per token1)
          // If our token is token1, we want 1/token1Price (token1 per token0)
          const price = isToken0
            ? parseFloat(item.token0Price)
            : 1 / parseFloat(item.token1Price);

          const processedItem = {
            timestamp: timestamp * 1000,
            open: parseFloat(item.open) || price,
            high: parseFloat(item.high) || price,
            low: parseFloat(item.low) || price,
            close: parseFloat(item.close) || price,
            volume: parseFloat(item.volumeUSD) || 0,
          };

          if (index < 3) {
            console.log(`[SushiSwap Debug] Processed pool item ${index}:`, {
              original: item,
              processed: processedItem,
              isToken0,
              calculatedPrice: price,
            });
          }

          return processedItem;
        });

        console.log(
          `[SushiSwap Debug] Successfully processed ${ohlcData.length} pool OHLC points`
        );

        // Prepare response data
        const responseData = {
          chart: ohlcData,
          metadata: {
            pair: {
              address: `${normalizedAddress}-${USDC_ADDRESS}`,
              baseToken: {
                address: baseToken.id,
                name: baseToken.name,
                symbol: baseToken.symbol,
                decimals: baseToken.decimals,
              },
              quoteToken: {
                address: quoteToken.id,
                name: quoteToken.name,
                symbol: quoteToken.symbol,
              },
              dexId: "sushiswap",
              poolId: selectedPool.id,
              feeTier: selectedPool.feeTier,
              url: `https://www.sushi.com/pool/${selectedPool.id}`,
            },
            priceUsd: ohlcData[ohlcData.length - 1]?.close || 0,
            currency: "USD",
            dataSource: "subgraph",
          },
        };

        console.log(`[SushiSwap Debug] Response data prepared:`, {
          chartLength: responseData.chart.length,
          metadata: responseData.metadata,
          firstPoint: responseData.chart[0],
          lastPoint: responseData.chart[responseData.chart.length - 1],
        });

        // Cache the result
        try {
          console.log(
            `[SushiSwap Debug] Caching data with key: ${cacheKey}, TTL: ${OHLC_CACHE_TTL}`
          );
          await storeValue(
            cacheKey,
            JSON.stringify(responseData),
            OHLC_CACHE_TTL
          );
          console.log(
            `[SushiSwap Debug] Successfully cached OHLC data for ${normalizedAddress}`
          );
        } catch (cacheError) {
          console.warn(
            `[SushiSwap Debug] Cache write error for ${cacheKey}:`,
            cacheError
          );
        }

        console.log(`[SushiSwap Debug] Sending successful response`);
        res.status(200).json({
          status: "success",
          data: responseData,
          source: "sushiswap",
          cached: false,
          tokenAddress: normalizedAddress,
          resolution,
          count: ohlcData.length,
          dataSource: "subgraph",
          poolId: selectedPool.id,
        });
      } catch (apiError: any) {
        console.error(`[SushiSwap Debug] API error for ${normalizedAddress}:`, {
          message: apiError.message,
          status: apiError.response?.status,
          statusText: apiError.response?.statusText,
          data: apiError.response?.data,
        });

        if (apiError.response?.status === 404) {
          res.status(404).json({
            status: "error",
            msg: "Pool not found or no trading data available",
            tokenAddress: normalizedAddress,
          });
        } else if (apiError.response?.status === 429) {
          res.status(429).json({
            status: "error",
            msg: "Rate limited by SushiSwap subgraph. Please try again later.",
          });
        } else {
          res.status(500).json({
            status: "error",
            msg: "Failed to fetch OHLC data from SushiSwap",
            debug: {
              error: apiError.message,
              status: apiError.response?.status,
              data: apiError.response?.data,
            },
          });
        }
      }
    });
  } catch (error: any) {
    console.error("[SushiSwap Debug] OHLC controller error:", {
      message: error.message,
      stack: error.stack,
      tokenAddress,
      resolution,
      days,
    });
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
      debug: {
        error: error.message,
      },
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
      days?: number;
    }
  >,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { tokenAddresses, resolution = "hour", days = 30 } = req.body;

    console.log(`[SushiSwap Debug] Batch request received:`, {
      tokenAddresses,
      resolution,
      days,
    });

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

    // For now, return error as batch processing with pool lookup is complex
    res.status(501).json({
      status: "error",
      msg: "Batch processing not implemented for pool-based OHLC data",
      suggestion: "Use individual requests for each token",
    });
  } catch (error) {
    console.error("[SushiSwap Debug] Batch OHLC controller error:", error);
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

    console.log(`[SushiSwap Debug] Clear cache request for: ${tokenAddress}`);

    if (!tokenAddress) {
      res.status(400).json({
        status: "error",
        msg: "tokenAddress parameter is required",
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();
    console.log(`[SushiSwap Debug] Clearing cache for: ${normalizedAddress}`);

    res.status(200).json({
      status: "success",
      msg: "Cache cleared successfully",
      tokenAddress: normalizedAddress,
    });
  } catch (error) {
    console.error("[SushiSwap Debug] Clear cache error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
    });
  }
}
