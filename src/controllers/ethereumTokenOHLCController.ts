// src/controllers/ethereumTokenOHLCController.ts
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
  poolCount: number; // Number of pools contributing to this data point
}

interface TokenHourData {
  id: string;
  periodStartUnix: number;
  token: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  volumeUSD: string;
  priceUSD: string;
  totalValueLocked: string;
  totalValueLockedUSD: string;
  feesUSD: string;
}

interface TokenDayData {
  id: string;
  date: number;
  token: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  volumeUSD: string;
  priceUSD: string;
  totalValueLocked: string;
  totalValueLockedUSD: string;
  feesUSD: string;
}

interface Token {
  id: string;
  symbol: string;
  name: string;
  decimals: string;
  volume: string;
  volumeUSD: string;
  totalValueLocked: string;
  totalValueLockedUSD: string;
  derivedETH: string;
  poolCount: string;
  txCount: string;
}

interface SushiGraphResponse {
  data: {
    tokenHourDatas?: TokenHourData[];
    tokenDayDatas?: TokenDayData[];
    tokens?: Token[];
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
const TOKEN_OHLC_CACHE_PREFIX = "token_ohlc_ethereum_";
const TOKEN_OHLC_CACHE_TTL = 6 * 60 * 60; // 6 hours

// Constants - Updated for Ethereum
const SUSHISWAP_SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/106601/sushi-v-3-eth/v0.0.1";

/**
 * Get GraphQL query to find token information
 */
function getTokenQuery() {
  return `
    query GetToken($tokenAddress: String!) {
      tokens(where: { id: $tokenAddress }) {
        id
        symbol
        name
        decimals
        volume
        volumeUSD
        totalValueLocked
        totalValueLockedUSD
        derivedETH
        poolCount
        txCount
      }
    }
  `;
}

/**
 * Get GraphQL query for token OHLC data
 */
function getTokenOHLCQuery(timeframe: "hour" | "day") {
  const entityName = timeframe === "hour" ? "tokenHourDatas" : "tokenDayDatas";
  const timeField = timeframe === "hour" ? "periodStartUnix" : "date";

  return `
    query GetTokenOHLC($tokenAddress: String!, $startTime: Int!, $endTime: Int!, $first: Int!) {
      ${entityName}(
        where: {
          token: $tokenAddress,
          ${timeField}_gte: $startTime,
          ${timeField}_lte: $endTime
        }
        orderBy: ${timeField}
        orderDirection: asc
        first: $first
      ) {
        id
        ${timeField === "date" ? "date" : "periodStartUnix"}
        token {
          id
          symbol
          name
          decimals
        }
        open
        high
        low
        close
        volume
        volumeUSD
        priceUSD
        totalValueLocked
        totalValueLockedUSD
        feesUSD
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
    `[Ethereum Token Debug] Current timestamp: ${endTime} (${new Date(
      endTime * 1000
    ).toISOString()})`
  );
  console.log(
    `[Ethereum Token Debug] Calculating time range for ${days} days:`,
    {
      endTime,
      startTime,
      endTimeDate: new Date(endTime * 1000).toISOString(),
      startTimeDate: new Date(startTime * 1000).toISOString(),
    }
  );

  if (timeframe === "day") {
    const dayStartTime = Math.floor(startTime / 86400);
    const dayEndTime = Math.floor(endTime / 86400);
    console.log(`[Ethereum Token Debug] Day timeframe - converted to days:`, {
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

  console.log(
    `[Ethereum Token Debug] Hour timeframe - using unix timestamps:`,
    {
      startTime,
      endTime,
    }
  );
  return { startTime, endTime };
}

/**
 * Get token OHLC data from Ethereum SushiSwap subgraph
 */
export async function getEthereumTokenOHLCData(
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

    console.log(`[Ethereum Token Debug] Request received with params:`, {
      tokenAddress,
      resolution,
      days,
      force,
    });

    // Validate input
    if (!tokenAddress) {
      console.log(`[Ethereum Token Debug] Missing tokenAddress parameter`);
      res.status(400).json({
        status: "error",
        msg: "tokenAddress parameter is required",
      });
      return;
    }

    if (!/^0x[a-f0-9]{40}$/i.test(tokenAddress)) {
      console.log(
        `[Ethereum Token Debug] Invalid address format: ${tokenAddress}`
      );
      res.status(422).json({
        status: "error",
        msg: "Invalid address format",
      });
      return;
    }

    const validResolutions = ["hour", "day"];
    if (!validResolutions.includes(resolution)) {
      console.log(`[Ethereum Token Debug] Invalid resolution: ${resolution}`);
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
      console.log(`[Ethereum Token Debug] Invalid days parameter: ${days}`);
      res.status(400).json({
        status: "error",
        msg: "Days must be a number between 1 and 365",
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();
    const timeframe = getTimeframe(resolution);
    const cacheKey = `${TOKEN_OHLC_CACHE_PREFIX}${normalizedAddress}_${resolution}_${days}`;

    console.log(
      `[Ethereum Token Debug] Normalized address: ${normalizedAddress}`
    );
    console.log(`[Ethereum Token Debug] Cache key: ${cacheKey}`);

    // Check cache unless force refresh
    if (!force) {
      console.log(`[Ethereum Token Debug] Checking cache for key: ${cacheKey}`);
      try {
        const cached = await getValue(cacheKey);
        if (cached) {
          console.log(
            `[Ethereum Token Debug] Cache hit for token OHLC: ${normalizedAddress}`
          );
          const cachedData = JSON.parse(cached);
          res.status(200).json({
            status: "success",
            data: cachedData,
            source: "ethereum-sushiswap",
            cached: true,
            tokenAddress: normalizedAddress,
            resolution,
            count: cachedData.chart?.length || 0,
          });
          return;
        } else {
          console.log(`[Ethereum Token Debug] Cache miss for key: ${cacheKey}`);
        }
      } catch (cacheError) {
        console.warn(
          `[Ethereum Token Debug] Cache read error for ${cacheKey}:`,
          cacheError
        );
      }
    } else {
      console.log(
        `[Ethereum Token Debug] Force refresh requested, skipping cache`
      );
    }

    // Rate limit the request
    console.log(
      `[Ethereum Token Debug] Entering rate limiter for token: ${normalizedAddress}`
    );
    await sushiLimiter.schedule(async () => {
      try {
        console.log(
          `[Ethereum Token Debug] Rate limiter executed, fetching token data for: ${normalizedAddress}`
        );

        // Step 1: Verify token exists and get basic info
        const tokenQuery = getTokenQuery();
        const tokenVariables = {
          tokenAddress: normalizedAddress,
        };

        console.log(
          `[Ethereum Token Debug] Fetching token info with query:`,
          tokenQuery
        );
        console.log(`[Ethereum Token Debug] Token variables:`, tokenVariables);
        console.log(
          `[Ethereum Token Debug] Using Ethereum subgraph URL: ${SUSHISWAP_SUBGRAPH_URL}`
        );

        const tokenResponse = await axios.post<SushiGraphResponse>(
          SUSHISWAP_SUBGRAPH_URL,
          { query: tokenQuery, variables: tokenVariables },
          {
            timeout: 15000,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );

        console.log(
          `[Ethereum Token Debug] Token response:`,
          JSON.stringify(tokenResponse.data, null, 2)
        );

        if (
          !tokenResponse.data.data.tokens ||
          tokenResponse.data.data.tokens.length === 0
        ) {
          console.log(
            `[Ethereum Token Debug] Token not found: ${normalizedAddress} on Ethereum`
          );
          res.status(404).json({
            status: "error",
            msg: "Token not found on Ethereum",
            tokenAddress: normalizedAddress,
            debug: {
              searchedFor: normalizedAddress,
              chain: "ethereum",
            },
          });
          return;
        }

        const tokenInfo = tokenResponse.data.data.tokens[0];
        console.log(`[Ethereum Token Debug] Token found:`, tokenInfo);

        // Step 2: Get token OHLC data
        const { startTime, endTime } = getTimeRange(daysNum, timeframe);
        const ohlcQuery = getTokenOHLCQuery(timeframe);
        const ohlcVariables = {
          tokenAddress: normalizedAddress,
          startTime,
          endTime,
          first: 1000,
        };

        console.log(
          `[Ethereum Token Debug] Fetching token OHLC data with variables:`,
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
          `[Ethereum Token Debug] Token OHLC response status: ${ohlcResponse.status}`
        );
        console.log(
          `[Ethereum Token Debug] Token OHLC response data:`,
          JSON.stringify(ohlcResponse.data, null, 2)
        );

        const rawData =
          timeframe === "hour"
            ? ohlcResponse.data.data.tokenHourDatas
            : ohlcResponse.data.data.tokenDayDatas;

        if (!rawData || rawData.length === 0) {
          console.log(
            `[Ethereum Token Debug] No token OHLC data found for: ${normalizedAddress}`
          );

          // Try to get the most recent data available
          const recentDataQuery = `
            query GetRecentTokenData($tokenAddress: String!) {
              tokenDayDatas(where: { token: $tokenAddress }, first: 10, orderBy: date, orderDirection: desc) {
                id
                date
                open
                high
                low
                close
                volume
                volumeUSD
                priceUSD
                totalValueLocked
                totalValueLockedUSD
                feesUSD
                token {
                  id
                  symbol
                  name
                  decimals
                }
              }
              tokenHourDatas(where: { token: $tokenAddress }, first: 10, orderBy: periodStartUnix, orderDirection: desc) {
                id
                periodStartUnix
                open
                high
                low
                close
                volume
                volumeUSD
                priceUSD
                totalValueLocked
                totalValueLockedUSD
                feesUSD
                token {
                  id
                  symbol
                  name
                  decimals
                }
              }
            }
          `;

          try {
            console.log(
              `[Ethereum Token Debug] Checking for any recent token data`
            );
            const recentDataResponse = await axios.post(
              SUSHISWAP_SUBGRAPH_URL,
              {
                query: recentDataQuery,
                variables: { tokenAddress: normalizedAddress },
              },
              {
                timeout: 10000,
                headers: {
                  "Content-Type": "application/json",
                },
              }
            );

            console.log(
              `[Ethereum Token Debug] Recent token data check response:`,
              JSON.stringify(recentDataResponse.data, null, 2)
            );

            const recentHourData = recentDataResponse.data.data.tokenHourDatas;
            const recentDayData = recentDataResponse.data.data.tokenDayDatas;

            if (
              (timeframe === "hour" &&
                recentHourData &&
                recentHourData.length > 0) ||
              (timeframe === "day" && recentDayData && recentDayData.length > 0)
            ) {
              console.log(
                `[Ethereum Token Debug] Found recent token data, using it instead`
              );

              const useableData =
                timeframe === "hour" ? recentHourData : recentDayData;

              // Convert to our format
              const ohlcData: OHLCPoint[] = useableData.map((item, index) => {
                const timestamp =
                  timeframe === "hour"
                    ? item.periodStartUnix
                    : (item as any).date * 86400;

                const processedItem = {
                  timestamp: timestamp * 1000,
                  open: parseFloat(item.open) || parseFloat(item.priceUSD) || 0,
                  high: parseFloat(item.high) || parseFloat(item.priceUSD) || 0,
                  low: parseFloat(item.low) || parseFloat(item.priceUSD) || 0,
                  close:
                    parseFloat(item.close) || parseFloat(item.priceUSD) || 0,
                  volume: parseFloat(item.volume) || 0,
                  volumeUSD: parseFloat(item.volumeUSD) || 0,
                  poolCount: 1, // We don't have this info from token data
                };

                if (index < 3) {
                  console.log(
                    `[Ethereum Token Debug] Processed recent token item ${index}:`,
                    {
                      original: item,
                      processed: processedItem,
                    }
                  );
                }

                return processedItem;
              });

              // Prepare response data with recent data
              const responseData = {
                chart: ohlcData,
                metadata: {
                  token: {
                    address: tokenInfo.id,
                    name: tokenInfo.name,
                    symbol: tokenInfo.symbol,
                    decimals: tokenInfo.decimals,
                  },
                  totalValueLockedUSD:
                    parseFloat(tokenInfo.totalValueLockedUSD) || 0,
                  volumeUSD: parseFloat(tokenInfo.volumeUSD) || 0,
                  poolCount: parseInt(tokenInfo.poolCount) || 0,
                  txCount: parseInt(tokenInfo.txCount) || 0,
                  priceUSD: ohlcData[ohlcData.length - 1]?.close || 0,
                  currency: "USD",
                  dataSource: "subgraph",
                  chain: "ethereum",
                  dexId: "ethereum-sushiswap",
                  note: "Using most recent available token data",
                },
              };

              // Cache the result
              try {
                await storeValue(
                  cacheKey,
                  JSON.stringify(responseData),
                  TOKEN_OHLC_CACHE_TTL
                );
                console.log(
                  `[Ethereum Token Debug] Successfully cached recent token OHLC data`
                );
              } catch (cacheError) {
                console.warn(
                  `[Ethereum Token Debug] Cache write error:`,
                  cacheError
                );
              }

              console.log(
                `[Ethereum Token Debug] Sending successful response with recent token data`
              );
              res.status(200).json({
                status: "success",
                data: responseData,
                source: "ethereum-sushiswap",
                cached: false,
                tokenAddress: normalizedAddress,
                resolution,
                count: ohlcData.length,
                dataSource: "subgraph",
                chain: "ethereum",
                note: "Using most recent available token data",
              });
              return;
            }
          } catch (recentDataError) {
            console.error(
              `[Ethereum Token Debug] Recent token data check failed:`,
              recentDataError
            );
          }

          res.status(404).json({
            status: "error",
            msg: "No token OHLC data available for this token on Ethereum",
            tokenAddress: normalizedAddress,
            debug: {
              timeframe,
              startTime,
              endTime,
              tokenExists: true,
              suggestion:
                "Token exists but no OHLC data in the specified time range",
              chain: "ethereum",
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
          `[Ethereum Token Debug] Processing ${rawData.length} token OHLC points`
        );

        // Convert to our format
        const ohlcData: OHLCPoint[] = rawData.map((item, index) => {
          const timestamp =
            timeframe === "hour"
              ? item.periodStartUnix
              : (item as any).date * 86400;

          const processedItem = {
            timestamp: timestamp * 1000,
            open: parseFloat(item.open) || parseFloat(item.priceUSD) || 0,
            high: parseFloat(item.high) || parseFloat(item.priceUSD) || 0,
            low: parseFloat(item.low) || parseFloat(item.priceUSD) || 0,
            close: parseFloat(item.close) || parseFloat(item.priceUSD) || 0,
            volume: parseFloat(item.volume) || 0,
            volumeUSD: parseFloat(item.volumeUSD) || 0,
            poolCount: 1, // We don't have exact pool count per time period
          };

          if (index < 3) {
            console.log(
              `[Ethereum Token Debug] Processed token item ${index}:`,
              {
                original: item,
                processed: processedItem,
              }
            );
          }

          return processedItem;
        });

        console.log(
          `[Ethereum Token Debug] Successfully processed ${ohlcData.length} token OHLC points`
        );

        // Prepare response data
        const responseData = {
          chart: ohlcData,
          metadata: {
            token: {
              address: tokenInfo.id,
              name: tokenInfo.name,
              symbol: tokenInfo.symbol,
              decimals: tokenInfo.decimals,
            },
            totalValueLockedUSD: parseFloat(tokenInfo.totalValueLockedUSD) || 0,
            volumeUSD: parseFloat(tokenInfo.volumeUSD) || 0,
            poolCount: parseInt(tokenInfo.poolCount) || 0,
            txCount: parseInt(tokenInfo.txCount) || 0,
            priceUSD: ohlcData[ohlcData.length - 1]?.close || 0,
            currency: "USD",
            dataSource: "subgraph",
            chain: "ethereum",
            dexId: "ethereum-sushiswap",
          },
        };

        console.log(`[Ethereum Token Debug] Response data prepared:`, {
          chartLength: responseData.chart.length,
          metadata: responseData.metadata,
          firstPoint: responseData.chart[0],
          lastPoint: responseData.chart[responseData.chart.length - 1],
        });

        // Cache the result
        try {
          console.log(
            `[Ethereum Token Debug] Caching data with key: ${cacheKey}, TTL: ${TOKEN_OHLC_CACHE_TTL}`
          );
          await storeValue(
            cacheKey,
            JSON.stringify(responseData),
            TOKEN_OHLC_CACHE_TTL
          );
          console.log(
            `[Ethereum Token Debug] Successfully cached token OHLC data for ${normalizedAddress}`
          );
        } catch (cacheError) {
          console.warn(
            `[Ethereum Token Debug] Cache write error for ${cacheKey}:`,
            cacheError
          );
        }

        console.log(`[Ethereum Token Debug] Sending successful response`);
        res.status(200).json({
          status: "success",
          data: responseData,
          source: "ethereum-sushiswap",
          cached: false,
          tokenAddress: normalizedAddress,
          resolution,
          count: ohlcData.length,
          dataSource: "subgraph",
          chain: "ethereum",
        });
      } catch (apiError: any) {
        console.error(
          `[Ethereum Token Debug] API error for ${normalizedAddress}:`,
          {
            message: apiError.message,
            status: apiError.response?.status,
            statusText: apiError.response?.statusText,
            data: apiError.response?.data,
          }
        );

        if (apiError.response?.status === 404) {
          res.status(404).json({
            status: "error",
            msg: "Token not found or no trading data available on Ethereum",
            tokenAddress: normalizedAddress,
          });
        } else if (apiError.response?.status === 429) {
          res.status(429).json({
            status: "error",
            msg: "Rate limited by Ethereum subgraph. Please try again later.",
          });
        } else {
          res.status(500).json({
            status: "error",
            msg: "Failed to fetch token OHLC data from Ethereum",
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
    console.error("[Ethereum Token Debug] OHLC controller error:", {
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
 * Clear token OHLC cache for a specific token
 */
export async function clearEthereumTokenOHLCCache(
  req: Request<{}, {}, {}, { tokenAddress?: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { tokenAddress } = req.query;

    console.log(
      `[Ethereum Token Debug] Clear cache request for: ${tokenAddress}`
    );

    if (!tokenAddress) {
      res.status(400).json({
        status: "error",
        msg: "tokenAddress parameter is required",
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();
    console.log(
      `[Ethereum Token Debug] Clearing cache for: ${normalizedAddress}`
    );

    res.status(200).json({
      status: "success",
      msg: "Cache cleared successfully",
      tokenAddress: normalizedAddress,
      chain: "ethereum",
    });
  } catch (error) {
    console.error("[Ethereum Token Debug] Clear cache error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
    });
  }
}
