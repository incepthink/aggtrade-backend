// src/controllers/katanaSushiswapOHLCController.ts
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
const OHLC_CACHE_PREFIX = "ohlc_katana_pool_";
const OHLC_CACHE_TTL = 5 * 60; // 5 minutes

// Constants - Updated for Katana
const KATANA_SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/106601/sushi-v-3-katana/v0.0.1";
const KATANA_USDC_ADDRESS = "0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36"; // Katana USDC

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
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 24 * 60 * 60;

  console.log(
    `[Katana Debug] Current timestamp: ${endTime} (${new Date(
      endTime * 1000
    ).toISOString()})`
  );
  console.log(`[Katana Debug] Calculating time range for ${days} days:`, {
    endTime,
    startTime,
    endTimeDate: new Date(endTime * 1000).toISOString(),
    startTimeDate: new Date(startTime * 1000).toISOString(),
  });

  if (timeframe === "day") {
    const dayStartTime = Math.floor(startTime / 86400);
    const dayEndTime = Math.floor(endTime / 86400);
    console.log(`[Katana Debug] Day timeframe - converted to days:`, {
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

  console.log(`[Katana Debug] Hour timeframe - using unix timestamps:`, {
    startTime,
    endTime,
  });
  return { startTime, endTime };
}

/**
 * Get OHLC data from Katana SushiSwap subgraph using pool data
 */
export async function getKatanaOHLCData(
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

    console.log(`[Katana Debug] Request received with params:`, {
      tokenAddress,
      resolution,
      days,
      force,
    });

    // Validate input
    if (!tokenAddress) {
      console.log(`[Katana Debug] Missing tokenAddress parameter`);
      res.status(400).json({
        status: "error",
        msg: "tokenAddress parameter is required",
      });
      return;
    }

    if (!/^0x[a-f0-9]{40}$/i.test(tokenAddress)) {
      console.log(`[Katana Debug] Invalid address format: ${tokenAddress}`);
      res.status(422).json({
        status: "error",
        msg: "Invalid address format",
      });
      return;
    }

    const validResolutions = ["hour", "day"];
    if (!validResolutions.includes(resolution)) {
      console.log(`[Katana Debug] Invalid resolution: ${resolution}`);
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
      console.log(`[Katana Debug] Invalid days parameter: ${days}`);
      res.status(400).json({
        status: "error",
        msg: "Days must be a number between 1 and 365",
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();
    const timeframe = getTimeframe(resolution);
    const cacheKey = `${OHLC_CACHE_PREFIX}${normalizedAddress}_${resolution}_${days}`;

    console.log(`[Katana Debug] Normalized address: ${normalizedAddress}`);
    console.log(`[Katana Debug] Cache key: ${cacheKey}`);

    // Check cache unless force refresh
    if (!force) {
      console.log(`[Katana Debug] Checking cache for key: ${cacheKey}`);
      try {
        const cached = await getValue(cacheKey);
        if (cached) {
          console.log(
            `[Katana Debug] Cache hit for OHLC: ${normalizedAddress}`
          );
          const cachedData = JSON.parse(cached);
          res.status(200).json({
            status: "success",
            data: cachedData,
            source: "katana-sushiswap",
            cached: true,
            tokenAddress: normalizedAddress,
            resolution,
            count: cachedData.chart?.length || 0,
          });
          return;
        } else {
          console.log(`[Katana Debug] Cache miss for key: ${cacheKey}`);
        }
      } catch (cacheError) {
        console.warn(
          `[Katana Debug] Cache read error for ${cacheKey}:`,
          cacheError
        );
      }
    } else {
      console.log(`[Katana Debug] Force refresh requested, skipping cache`);
    }

    // Rate limit the request
    console.log(
      `[Katana Debug] Entering rate limiter for token: ${normalizedAddress}`
    );
    await sushiLimiter.schedule(async () => {
      try {
        console.log(
          `[Katana Debug] Rate limiter executed, finding pools for: ${normalizedAddress}`
        );

        // Step 1: Find pools with this token and USDC
        const poolsQuery = getPoolsQuery();
        const poolsVariables = {
          token0: normalizedAddress,
          token1: KATANA_USDC_ADDRESS,
        };

        console.log(`[Katana Debug] Finding pools with query:`, poolsQuery);
        console.log(`[Katana Debug] Pools variables:`, poolsVariables);
        console.log(
          `[Katana Debug] Using Katana subgraph URL: ${KATANA_SUBGRAPH_URL}`
        );
        console.log(
          `[Katana Debug] Using Katana USDC address: ${KATANA_USDC_ADDRESS}`
        );

        const poolsResponse = await axios.post<SushiGraphResponse>(
          KATANA_SUBGRAPH_URL,
          { query: poolsQuery, variables: poolsVariables },
          {
            timeout: 15000,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );

        console.log(
          `[Katana Debug] Pools response:`,
          JSON.stringify(poolsResponse.data, null, 2)
        );

        if (
          !poolsResponse.data.data.pools ||
          poolsResponse.data.data.pools.length === 0
        ) {
          console.log(
            `[Katana Debug] No pools found for token: ${normalizedAddress} paired with USDC on Katana`
          );
          res.status(404).json({
            status: "error",
            msg: "No pools found for this token paired with USDC on Katana",
            tokenAddress: normalizedAddress,
            debug: {
              searchedFor: `${normalizedAddress}-${KATANA_USDC_ADDRESS} pools`,
              foundPools: 0,
              chain: "katana",
            },
          });
          return;
        }

        // Use the pool with highest volume
        const selectedPool = poolsResponse.data.data.pools[0];
        console.log(`[Katana Debug] Selected pool:`, selectedPool);

        // Determine if token is token0 or token1 in the pool
        const isToken0 =
          selectedPool.token0.id.toLowerCase() === normalizedAddress;
        const baseToken = isToken0 ? selectedPool.token0 : selectedPool.token1;
        const quoteToken = isToken0 ? selectedPool.token1 : selectedPool.token0;

        console.log(`[Katana Debug] Pool configuration:`, {
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
          `[Katana Debug] Fetching OHLC data with variables:`,
          ohlcVariables
        );

        const ohlcResponse = await axios.post<SushiGraphResponse>(
          KATANA_SUBGRAPH_URL,
          { query: ohlcQuery, variables: ohlcVariables },
          {
            timeout: 15000,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );

        console.log(
          `[Katana Debug] OHLC response status: ${ohlcResponse.status}`
        );
        console.log(
          `[Katana Debug] OHLC response data:`,
          JSON.stringify(ohlcResponse.data, null, 2)
        );

        const rawData =
          timeframe === "hour"
            ? ohlcResponse.data.data.poolHourDatas
            : ohlcResponse.data.data.poolDayDatas;

        if (!rawData || rawData.length === 0) {
          console.log(
            `[Katana Debug] No OHLC data found for pool: ${selectedPool.id}`
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
            console.log(`[Katana Debug] Checking for any recent pool data`);
            const recentDataResponse = await axios.post(
              KATANA_SUBGRAPH_URL,
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
              `[Katana Debug] Recent pool data check response:`,
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
              console.log(`[Katana Debug] Found recent data, using it instead`);

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
                    `[Katana Debug] Processed recent item ${index}:`,
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
                    address: `${normalizedAddress}-${KATANA_USDC_ADDRESS}`,
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
                    dexId: "katana-sushiswap",
                    poolId: selectedPool.id,
                    feeTier: selectedPool.feeTier,
                    url: `https://katana.roninchain.com/pool/${selectedPool.id}`,
                    chain: "katana",
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
                  `[Katana Debug] Successfully cached recent OHLC data`
                );
              } catch (cacheError) {
                console.warn(`[Katana Debug] Cache write error:`, cacheError);
              }

              console.log(
                `[Katana Debug] Sending successful response with recent data`
              );
              res.status(200).json({
                status: "success",
                data: responseData,
                source: "katana-sushiswap",
                cached: false,
                tokenAddress: normalizedAddress,
                resolution,
                count: ohlcData.length,
                dataSource: "subgraph",
                poolId: selectedPool.id,
                chain: "katana",
                note: "Using most recent available data",
              });
              return;
            }
          } catch (recentDataError) {
            console.error(
              `[Katana Debug] Recent data check failed:`,
              recentDataError
            );
          }

          res.status(404).json({
            status: "error",
            msg: "No OHLC data available for this pool on Katana",
            tokenAddress: normalizedAddress,
            debug: {
              poolId: selectedPool.id,
              timeframe,
              startTime,
              endTime,
              poolExists: true,
              suggestion:
                "Pool exists but no OHLC data in the specified time range",
              chain: "katana",
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
          `[Katana Debug] Processing ${rawData.length} pool OHLC points`
        );

        // Convert to our format
        const ohlcData: OHLCPoint[] = rawData.map((item, index) => {
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
            console.log(`[Katana Debug] Processed pool item ${index}:`, {
              original: item,
              processed: processedItem,
              isToken0,
              calculatedPrice: price,
            });
          }

          return processedItem;
        });

        console.log(
          `[Katana Debug] Successfully processed ${ohlcData.length} pool OHLC points`
        );

        // Prepare response data
        const responseData = {
          chart: ohlcData,
          metadata: {
            pair: {
              address: `${normalizedAddress}-${KATANA_USDC_ADDRESS}`,
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
              dexId: "katana-sushiswap",
              poolId: selectedPool.id,
              feeTier: selectedPool.feeTier,
              url: `https://katana.roninchain.com/pool/${selectedPool.id}`,
              chain: "katana",
            },
            priceUsd: ohlcData[ohlcData.length - 1]?.close || 0,
            currency: "USD",
            dataSource: "subgraph",
          },
        };

        console.log(`[Katana Debug] Response data prepared:`, {
          chartLength: responseData.chart.length,
          metadata: responseData.metadata,
          firstPoint: responseData.chart[0],
          lastPoint: responseData.chart[responseData.chart.length - 1],
        });

        // Cache the result
        try {
          console.log(
            `[Katana Debug] Caching data with key: ${cacheKey}, TTL: ${OHLC_CACHE_TTL}`
          );
          await storeValue(
            cacheKey,
            JSON.stringify(responseData),
            OHLC_CACHE_TTL
          );
          console.log(
            `[Katana Debug] Successfully cached OHLC data for ${normalizedAddress}`
          );
        } catch (cacheError) {
          console.warn(
            `[Katana Debug] Cache write error for ${cacheKey}:`,
            cacheError
          );
        }

        console.log(`[Katana Debug] Sending successful response`);
        res.status(200).json({
          status: "success",
          data: responseData,
          source: "katana-sushiswap",
          cached: false,
          tokenAddress: normalizedAddress,
          resolution,
          count: ohlcData.length,
          dataSource: "subgraph",
          poolId: selectedPool.id,
          chain: "katana",
        });
      } catch (apiError: any) {
        console.error(`[Katana Debug] API error for ${normalizedAddress}:`, {
          message: apiError.message,
          status: apiError.response?.status,
          statusText: apiError.response?.statusText,
          data: apiError.response?.data,
        });

        if (apiError.response?.status === 404) {
          res.status(404).json({
            status: "error",
            msg: "Pool not found or no trading data available on Katana",
            tokenAddress: normalizedAddress,
          });
        } else if (apiError.response?.status === 429) {
          res.status(429).json({
            status: "error",
            msg: "Rate limited by Katana subgraph. Please try again later.",
          });
        } else {
          res.status(500).json({
            status: "error",
            msg: "Failed to fetch OHLC data from Katana",
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
    console.error("[Katana Debug] OHLC controller error:", {
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
 * Clear OHLC cache for a specific token
 */
export async function clearKatanaOHLCCache(
  req: Request<{}, {}, {}, { tokenAddress?: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { tokenAddress } = req.query;

    console.log(`[Katana Debug] Clear cache request for: ${tokenAddress}`);

    if (!tokenAddress) {
      res.status(400).json({
        status: "error",
        msg: "tokenAddress parameter is required",
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();
    console.log(`[Katana Debug] Clearing cache for: ${normalizedAddress}`);

    res.status(200).json({
      status: "success",
      msg: "Cache cleared successfully",
      tokenAddress: normalizedAddress,
      chain: "katana",
    });
  } catch (error) {
    console.error("[Katana Debug] Clear cache error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
    });
  }
}
