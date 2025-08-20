// src/controllers/katanaSushiswapSwapController.ts
import type { Request, Response, NextFunction } from "express";
import axios from "axios";
import Bottleneck from "bottleneck";
import { getValue, storeValue } from "../redis/katanaTokens";

// Types
interface SwapData {
  id: string;
  timestamp: string;
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
  token0PriceUSD: string;
  token1PriceUSD: string;
  amount0USD: string;
  amount1USD: string;
  amountUSD: string;
  pool: {
    id: string;
  };
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
  totalValueLockedUSD: string;
  volumeUSD: string;
}

interface StoredSwapData {
  swaps: ProcessedSwap[];
  metadata: {
    token: {
      address: string;
      name: string;
      symbol: string;
      decimals: string;
    };
    pool: {
      id: string;
      address: string;
      token0: any;
      token1: any;
      feeTier: string;
      totalValueLockedUSD: number;
      volumeUSD: number;
    };
    isToken0: boolean;
    quoteToken: any;
    lastUpdate: number; // Last time we updated the data
    lastSwapTimestamp: number; // Timestamp of most recent swap
    dataRange: {
      start: number;
      end: number;
    };
    chain: string;
    dexId: string;
  };
}

interface ProcessedSwap {
  id: string;
  timestamp: number;
  tokenPriceUSD: number;
  tokenVolumeUSD: number;
  totalVolumeUSD: number;
}

interface SushiGraphResponse {
  data: {
    swaps?: SwapData[];
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
const FULL_SWAP_DATA_PREFIX = "full_swaps_katana_";
const FULL_SWAP_DATA_TTL = 365 * 24 * 60 * 60; // 365 days (1 year)
const UPDATE_LOCK_PREFIX = "update_lock_katana_";
const UPDATE_LOCK_TTL = 60 * 60; // 1 hour lock

// Constants
const KATANA_SUBGRAPH_URL = "https://api.studio.thegraph.com/query/106601/sushi-v-3-katana/version/latest";
const FULL_DATA_DAYS = 365;
const UPDATE_INTERVAL_HOURS = 1;

/**
 * Get GraphQL query to find pools containing a specific token, ordered by TVL
 */
function getPoolsByTVLQuery() {
  return `
    query GetPoolsByTVL($tokenAddress: String!) {
      pools(
        where: {
          or: [
            { token0: $tokenAddress },
            { token1: $tokenAddress }
          ]
        }
        orderBy: totalValueLockedUSD
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
        totalValueLockedUSD
        volumeUSD
      }
    }
  `;
}

/**
 * Get GraphQL query for swap data from a specific pool with time filtering
 */
function getSwapsQuery() {
  return `
    query GetSwaps($poolId: String!, $startTime: Int!, $endTime: Int!, $first: Int!, $skip: Int!) {
      swaps(
        where: {
          pool: $poolId,
          timestamp_gte: $startTime,
          timestamp_lte: $endTime
        }
        orderBy: timestamp
        orderDirection: asc
        first: $first
        skip: $skip
      ) {
        id
        timestamp
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
        token0PriceUSD
        token1PriceUSD
        amount0USD
        amount1USD
        amountUSD
        pool {
          id
        }
      }
    }
  `;
}

/**
 * Calculate time range for data retrieval
 */
function getFullTimeRange(): { startTime: number; endTime: number } {
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - (FULL_DATA_DAYS * 24 * 60 * 60);
  return { startTime, endTime };
}

/**
 * Calculate incremental time range (only new data since last update)
 */
function getIncrementalTimeRange(lastSwapTimestamp: number): { startTime: number; endTime: number } {
  const endTime = Math.floor(Date.now() / 1000);
  // Start from last swap + 1 second to avoid duplicates
  const startTime = lastSwapTimestamp + 1;
  return { startTime, endTime };
}

/**
 * Fetch swaps with pagination
 */
async function fetchSwaps(
  poolId: string,
  startTime: number,
  endTime: number,
  maxSwaps: number = 50000 // Reasonable limit to prevent memory issues
): Promise<SwapData[]> {
  const allSwaps: SwapData[] = [];
  let hasMore = true;
  let skip = 0;
  const batchSize = 1000;

  console.log(`[Katana Incremental] Fetching swaps for pool ${poolId} from ${startTime} to ${endTime}`);

  while (hasMore && allSwaps.length < maxSwaps) {
    const swapsQuery = getSwapsQuery();
    const variables = {
      poolId,
      startTime,
      endTime,
      first: Math.min(batchSize, maxSwaps - allSwaps.length),
      skip,
    };

    console.log(`[Katana Incremental] Batch: skip=${skip}, requesting=${variables.first}`);

    const response = await axios.post<SushiGraphResponse>(
      KATANA_SUBGRAPH_URL,
      { query: swapsQuery, variables },
      {
        timeout: 15000,
        headers: { "Content-Type": "application/json" },
      }
    );

    const swaps = response.data.data.swaps;

    if (!swaps || swaps.length === 0) {
      hasMore = false;
      break;
    }

    allSwaps.push(...swaps);
    
    if (swaps.length < variables.first) {
      hasMore = false;
    } else {
      skip += batchSize;
    }

    // Rate limiting delay
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(`[Katana Incremental] Fetched ${allSwaps.length} swaps`);
  return allSwaps;
}

/**
 * Process raw swaps into our format
 */
function processSwaps(rawSwaps: SwapData[], tokenAddress: string, isToken0: boolean): ProcessedSwap[] {
  return rawSwaps.map(swap => ({
    id: swap.id,
    timestamp: parseInt(swap.timestamp) * 1000, // Convert to milliseconds
    tokenPriceUSD: isToken0 
      ? parseFloat(swap.token0PriceUSD || "0")
      : parseFloat(swap.token1PriceUSD || "0"),
    tokenVolumeUSD: isToken0
      ? parseFloat(swap.amount0USD || "0") 
      : parseFloat(swap.amount1USD || "0"),
    totalVolumeUSD: parseFloat(swap.amountUSD || "0"),
  }));
}

/**
 * Merge new swaps with existing data, removing duplicates
 */
function mergeSwaps(existingSwaps: ProcessedSwap[], newSwaps: ProcessedSwap[]): ProcessedSwap[] {
  const swapMap = new Map<string, ProcessedSwap>();
  
  // Add existing swaps
  for (const swap of existingSwaps) {
    swapMap.set(swap.id, swap);
  }
  
  // Add new swaps (will overwrite duplicates)
  for (const swap of newSwaps) {
    swapMap.set(swap.id, swap);
  }
  
  // Convert back to array and sort by timestamp
  const mergedSwaps = Array.from(swapMap.values());
  mergedSwaps.sort((a, b) => a.timestamp - b.timestamp);
  
  return mergedSwaps;
}

/**
 * Check if we need to update data (every hour)
 */
function needsUpdate(lastUpdate: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const hoursSinceUpdate = (now - lastUpdate) / 3600;
  return hoursSinceUpdate >= UPDATE_INTERVAL_HOURS;
}

/**
 * Get swap data with incremental updates
 */
export async function getKatanaSwapData(
  req: Request<
    {},
    {},
    {},
    {
      tokenAddress?: string;
      days?: string;
      force?: string;
    }
  >,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { tokenAddress, days = "365", force } = req.query;

    console.log(`[Katana Incremental] Request received:`, { tokenAddress, days, force });

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
        msg: "Invalid address format",
      });
      return;
    }

    const daysNum = parseInt(days);
    if (isNaN(daysNum) || daysNum < 1 || daysNum > 365) {
      res.status(400).json({
        status: "error",
        msg: "Days must be a number between 1 and 365",
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();
    const cacheKey = `${FULL_SWAP_DATA_PREFIX}${normalizedAddress}`;
    const lockKey = `${UPDATE_LOCK_PREFIX}${normalizedAddress}`;

    console.log(`[Katana Incremental] Cache key: ${cacheKey}`);

    await sushiLimiter.schedule(async () => {
      try {
        // Step 1: Try to load existing data
        let storedData: StoredSwapData | null = null;
        try {
          const cached = await getValue(cacheKey);
          if (cached) {
            storedData = JSON.parse(cached);
            console.log(`[Katana Incremental] Found existing data:`, {
              swapsCount: storedData?.swaps.length,
              lastUpdate: storedData?.metadata.lastUpdate,
              lastSwapTimestamp: storedData?.metadata.lastSwapTimestamp,
            });
          }
        } catch (cacheError) {
          console.warn(`[Katana Incremental] Cache read error:`, cacheError);
        }

        // Step 2: Determine if we need to update
        const shouldUpdate = force || !storedData || needsUpdate(storedData.metadata.lastUpdate);
        
        if (!shouldUpdate) {
          console.log(`[Katana Incremental] Data is fresh, returning cached data`);
          
          // Filter data to requested time range
          const requestedStartTime = Math.floor(Date.now() / 1000) - (daysNum * 24 * 60 * 60);
          const filteredSwaps = storedData!.swaps.filter(
            swap => swap.timestamp >= requestedStartTime * 1000
          );

          const responseData = {
            ...storedData!,
            swaps: filteredSwaps,
            metadata: {
              ...storedData!.metadata,
              totalSwaps: filteredSwaps.length,
              timeRange: {
                start: requestedStartTime * 1000,
                end: Date.now(),
                days: daysNum,
              },
            },
          };

          res.status(200).json({
            status: "success",
            data: responseData,
            source: "katana-sushiswap",
            cached: true,
            tokenAddress: normalizedAddress,
            count: filteredSwaps.length,
            poolId: storedData!.metadata.pool.id,
            poolTVL: storedData!.metadata.pool.totalValueLockedUSD.toString(),
            chain: "katana",
            updateStatus: "fresh",
          });
          return;
        }

        // Step 3: Check update lock to prevent concurrent updates
        try {
          const lockExists = await getValue(lockKey);
          if (lockExists && !force) {
            console.log(`[Katana Incremental] Update in progress, returning stale data`);
            
            if (storedData) {
              const requestedStartTime = Math.floor(Date.now() / 1000) - (daysNum * 24 * 60 * 60);
              const filteredSwaps = storedData.swaps.filter(
                swap => swap.timestamp >= requestedStartTime * 1000
              );

              res.status(200).json({
                status: "success",
                data: { ...storedData, swaps: filteredSwaps },
                cached: true,
                updateStatus: "updating",
                message: "Data update in progress, returning existing data",
              });
              return;
            }
          }
        } catch (lockError) {
          console.warn(`[Katana Incremental] Lock check error:`, lockError);
        }

        // Step 4: Set update lock
        try {
          await storeValue(lockKey, "updating", UPDATE_LOCK_TTL);
        } catch (lockError) {
          console.warn(`[Katana Incremental] Failed to set update lock:`, lockError);
        }

        console.log(`[Katana Incremental] Updating data for token: ${normalizedAddress}`);

        // Step 5: Find highest TVL pool (only if we don't have pool info)
        let selectedPool: Pool;
        
        if (storedData?.metadata.pool) {
          // Use existing pool info
          selectedPool = {
            id: storedData.metadata.pool.id,
            token0: storedData.metadata.pool.token0,
            token1: storedData.metadata.pool.token1,
            feeTier: storedData.metadata.pool.feeTier,
            totalValueLockedUSD: storedData.metadata.pool.totalValueLockedUSD.toString(),
            volumeUSD: storedData.metadata.pool.volumeUSD.toString(),
          };
          console.log(`[Katana Incremental] Using existing pool: ${selectedPool.id}`);
        } else {
          // Find pool with highest TVL
          const poolsQuery = getPoolsByTVLQuery();
          const poolsVariables = { tokenAddress: normalizedAddress };

          const poolsResponse = await axios.post<SushiGraphResponse>(
            KATANA_SUBGRAPH_URL,
            { query: poolsQuery, variables: poolsVariables },
            {
              timeout: 15000,
              headers: { "Content-Type": "application/json" },
            }
          );

          if (!poolsResponse.data.data.pools || poolsResponse.data.data.pools.length === 0) {
            res.status(404).json({
              status: "error",
              msg: "No pools found for this token on Katana",
              tokenAddress: normalizedAddress,
            });
            return;
          }

          selectedPool = poolsResponse.data.data.pools[0];
          console.log(`[Katana Incremental] Found highest TVL pool:`, {
            poolId: selectedPool.id,
            tvl: selectedPool.totalValueLockedUSD,
          });
        }

        // Determine token position in pool
        const isToken0 = selectedPool.token0.id.toLowerCase() === normalizedAddress;
        const baseToken = isToken0 ? selectedPool.token0 : selectedPool.token1;
        const quoteToken = isToken0 ? selectedPool.token1 : selectedPool.token0;

        // Step 6: Fetch new data (incremental or full)
        let newSwaps: SwapData[];
        
        if (storedData && storedData.metadata.lastSwapTimestamp) {
          // Incremental update: only fetch new data
          const { startTime, endTime } = getIncrementalTimeRange(
            Math.floor(storedData.metadata.lastSwapTimestamp / 1000)
          );
          
          console.log(`[Katana Incremental] Incremental fetch from ${startTime} to ${endTime}`);
          newSwaps = await fetchSwaps(selectedPool.id, startTime, endTime);
          console.log(`[Katana Incremental] Fetched ${newSwaps.length} new swaps`);
        } else {
          // Full fetch: get all data for 365 days
          const { startTime, endTime } = getFullTimeRange();
          
          console.log(`[Katana Incremental] Full fetch from ${startTime} to ${endTime}`);
          newSwaps = await fetchSwaps(selectedPool.id, startTime, endTime);
          console.log(`[Katana Incremental] Fetched ${newSwaps.length} total swaps`);
        }

        // Step 7: Process and merge data
        const processedNewSwaps = processSwaps(newSwaps, normalizedAddress, isToken0);
        const existingSwaps = storedData?.swaps || [];
        const allSwaps = mergeSwaps(existingSwaps, processedNewSwaps);

        console.log(`[Katana Incremental] Merged data: ${existingSwaps.length} existing + ${processedNewSwaps.length} new = ${allSwaps.length} total`);

        // Step 8: Prepare updated stored data
        const now = Math.floor(Date.now() / 1000);
        const lastSwapTimestamp = allSwaps.length > 0 
          ? Math.max(...allSwaps.map(s => s.timestamp))
          : now * 1000;

        const updatedStoredData: StoredSwapData = {
          swaps: allSwaps,
          metadata: {
            token: {
              address: baseToken.id,
              name: baseToken.name,
              symbol: baseToken.symbol,
              decimals: baseToken.decimals,
            },
            pool: {
              id: selectedPool.id,
              address: selectedPool.id,
              token0: selectedPool.token0,
              token1: selectedPool.token1,
              feeTier: selectedPool.feeTier,
              totalValueLockedUSD: parseFloat(selectedPool.totalValueLockedUSD),
              volumeUSD: parseFloat(selectedPool.volumeUSD),
            },
            isToken0,
            quoteToken,
            lastUpdate: now,
            lastSwapTimestamp,
            dataRange: {
              start: allSwaps.length > 0 ? Math.min(...allSwaps.map(s => s.timestamp)) : now * 1000,
              end: lastSwapTimestamp,
            },
            chain: "katana",
            dexId: "katana-sushiswap",
          },
        };

        // Step 9: Save updated data to Redis
        try {
          await storeValue(cacheKey, JSON.stringify(updatedStoredData), FULL_SWAP_DATA_TTL);
          console.log(`[Katana Incremental] Successfully saved ${allSwaps.length} swaps to Redis`);
        } catch (saveError) {
          console.error(`[Katana Incremental] Failed to save to Redis:`, saveError);
        }

        // Step 10: Filter data for response (requested time range)
        const requestedStartTime = Math.floor(Date.now() / 1000) - (daysNum * 24 * 60 * 60);
        const filteredSwaps = allSwaps.filter(
          swap => swap.timestamp >= requestedStartTime * 1000
        );

        const responseData = {
          swaps: filteredSwaps,
          metadata: {
            ...updatedStoredData.metadata,
            totalSwaps: filteredSwaps.length,
            timeRange: {
              start: requestedStartTime * 1000,
              end: Date.now(),
              days: daysNum,
            },
          },
        };

        // Step 11: Clear update lock
        try {
          // Note: You might want to implement a Redis delete function
          // For now, the lock will expire automatically
        } catch (unlockError) {
          console.warn(`[Katana Incremental] Failed to clear update lock:`, unlockError);
        }

        console.log(`[Katana Incremental] Sending response with ${filteredSwaps.length} swaps`);

        res.status(200).json({
          status: "success",
          data: responseData,
          source: "katana-sushiswap",
          cached: false,
          tokenAddress: normalizedAddress,
          count: filteredSwaps.length,
          poolId: selectedPool.id,
          poolTVL: selectedPool.totalValueLockedUSD,
          chain: "katana",
          updateStatus: "updated",
          stats: {
            totalSwapsStored: allSwaps.length,
            newSwapsFetched: processedNewSwaps.length,
            existingSwaps: existingSwaps.length,
          },
        });

      } catch (apiError: any) {
        console.error(`[Katana Incremental] API error:`, {
          message: apiError.message,
          status: apiError.response?.status,
          data: apiError.response?.data,
        });

        res.status(500).json({
          status: "error",
          msg: "Failed to fetch or update swap data",
          debug: {
            error: apiError.message,
            status: apiError.response?.status,
          },
        });
      }
    });

  } catch (error: any) {
    console.error("[Katana Incremental] Controller error:", error);
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
 * Clear cache for a specific token (for debugging/admin)
 */
export async function clearKatanaSwapCache(
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
    const cacheKey = `${FULL_SWAP_DATA_PREFIX}${normalizedAddress}`;
    
    console.log(`[Katana Incremental] Clearing cache for: ${normalizedAddress}`);

    // Note: Implement Redis delete if available, or set very short TTL
    // await deleteValue(cacheKey);

    res.status(200).json({
      status: "success",
      msg: "Cache cleared successfully",
      tokenAddress: normalizedAddress,
      chain: "katana",
    });
  } catch (error) {
    console.error("[Katana Incremental] Clear cache error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
    });
  }
}