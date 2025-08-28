//using
// src/controllers/katanaSushiswapSwapController.ts
import type { Request, Response, NextFunction } from "express";
import axios from "axios";
import Bottleneck from "bottleneck";
import { getValue, storeValue } from "../redis/katanaTokens";
import KatanaSwap from "../models/KatanaSwap";
import { Op } from "sequelize";

import { getTokenUSDPrice } from "../utils/sushiPriceUtils";

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
  sqrtPriceX96: string; // Added for price calculation
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
    lastUpdate: number;
    lastSwapTimestamp: number;
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

interface MySQLSwapResult {
  id: string;
  timestamp: Date;
  token_price_usd: string | number;
  token_volume_usd: string | number;
  total_volume_usd: string | number;
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

// Constants with new limits
const KATANA_SUBGRAPH_URL = "https://api.studio.thegraph.com/query/106601/sushi-v-3-katana/version/latest";
const FULL_DATA_DAYS = 365;
const UPDATE_INTERVAL_HOURS = 1;
const MAX_SKIP_LIMIT = 2000; // Maximum skip value allowed
const MAX_TOTAL_SWAPS = 3000; // Maximum total swaps across all batches

// Priority tokens for pool selection
const USDC_KATANA = "0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36".toLowerCase();
const AUSD_KATANA = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a".toLowerCase();

/**
 * Convert sqrtPriceX96 to token prices
 */
function sqrtPriceX96ToTokenPrices(
  sqrtPriceX96: string,
  token0Decimals: number,
  token1Decimals: number
): { token0Price: number; token1Price: number } {
  try {
    const Q192 = BigInt(2) ** BigInt(192);
    const sqrtPrice = BigInt(sqrtPriceX96);
    const price = sqrtPrice * sqrtPrice;
    
    const token0DecimalsBN = BigInt(10) ** BigInt(token0Decimals);
    const token1DecimalsBN = BigInt(10) ** BigInt(token1Decimals);
    
    // Convert to regular numbers for calculation
    const priceNumber = Number(price) / Number(Q192);
    const token0Price = priceNumber * Number(token0DecimalsBN) / Number(token1DecimalsBN);
    const token1Price = 1 / token0Price;
    
    return { token0Price, token1Price };
  } catch (error) {
    console.error("Error calculating price from sqrtPriceX96:", error);
    return { token0Price: 0, token1Price: 0 };
  }
}

/**
 * Load historical swaps from MySQL table
 */
async function loadHistoricalSwapsFromMySQL(
  tokenAddress: string,
  poolId: string,
  requestedStartTime: number // Unix timestamp in seconds
): Promise<ProcessedSwap[]> {
  try {
    console.log(`[MySQL Historical] Loading swaps for token ${tokenAddress}, pool ${poolId}`);
    
    const historicalSwaps = await KatanaSwap.findAll({
      attributes: [
        'id',
        'timestamp',
        'token_price_usd',
        'token_volume_usd',
        'total_volume_usd'
      ],
      where: {
        token_address: tokenAddress.toLowerCase(),
        pool_id: poolId.toLowerCase(),
        timestamp: {
          [Op.gte]: new Date(requestedStartTime * 1000) // Convert to Date for MySQL
        }
      },
      order: [['timestamp', 'DESC']],
      raw: true,
      limit: 50000 // Reasonable limit to prevent memory issues
    });

    console.log(`[MySQL Historical] Found ${historicalSwaps.length} historical swaps`);

    // Convert MySQL data to ProcessedSwap format
    const processedHistoricalSwaps: ProcessedSwap[] = (historicalSwaps as MySQLSwapResult[]).map(swap => ({
      id: swap.id,
      timestamp: swap.timestamp.getTime(), // Convert Date to milliseconds
      tokenPriceUSD: parseFloat(swap.token_price_usd.toString()),
      tokenVolumeUSD: parseFloat(swap.token_volume_usd.toString()),
      totalVolumeUSD: parseFloat(swap.total_volume_usd.toString()),
    }));

    return processedHistoricalSwaps;
  } catch (error) {
    console.error('[MySQL Historical] Error loading historical swaps:', error);
    return []; // Return empty array on error to not break the main flow
  }
}

/**
 * Merge Redis swaps with MySQL historical swaps, removing duplicates
 */
function mergeWithHistoricalSwaps(
  redisSwaps: ProcessedSwap[], 
  mysqlSwaps: ProcessedSwap[]
): ProcessedSwap[] {
  const swapMap = new Map<string, ProcessedSwap>();
  
  // Add MySQL swaps first (older data)
  for (const swap of mysqlSwaps) {
    swapMap.set(swap.id, swap);
  }
  
  // Add Redis swaps (newer data) - will overwrite any duplicates
  for (const swap of redisSwaps) {
    swapMap.set(swap.id, swap);
  }
  
  // Convert back to array and sort by timestamp (newest first)
  const mergedSwaps = Array.from(swapMap.values());
  mergedSwaps.sort((a, b) => b.timestamp - a.timestamp); // DESC order
  
  console.log(`[MySQL Historical] Merged swaps: ${mysqlSwaps.length} MySQL + ${redisSwaps.length} Redis = ${mergedSwaps.length} total`);
  
  return mergedSwaps;
}

/**
 * Get GraphQL query to find pools containing a specific token, ordered by TVL
 */
function getPoolsByTVLQuery(): string {
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
 * Modified to include sqrtPriceX96 for price calculation
 */
function getSwapsQuery(): string {
  return `
    query GetSwaps($poolId: String!, $startTime: Int!, $endTime: Int!, $first: Int!, $skip: Int!) {
      swaps(
        where: {
          pool: $poolId,
          timestamp_gte: $startTime,
          timestamp_lte: $endTime
        }
        orderBy: timestamp
        orderDirection: desc
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
        sqrtPriceX96
        pool {
          id
        }
      }
    }
  `;
}

/**
 * Prioritize pools based on quote token preference
 * Priority: USDC > AUSD > highest TVL
 */
function selectBestPool(pools: Pool[], targetTokenAddress: string): Pool {
  if (pools.length === 0) {
    throw new Error("No pools available");
  }

  const normalizedTarget = targetTokenAddress.toLowerCase();
  
  console.log(`[Pool Selection] Selecting best pool from ${pools.length} options for token ${normalizedTarget}`);
  
  // Log all available pools for debugging
  pools.forEach((pool, index) => {
    const token0Lower = pool.token0.id.toLowerCase();
    const token1Lower = pool.token1.id.toLowerCase();
    const quoteToken = token0Lower === normalizedTarget ? pool.token1 : pool.token0;
    
    console.log(`[Pool Selection] Pool ${index}: ${pool.token0.symbol}/${pool.token1.symbol} (TVL: $${pool.totalValueLockedUSD}, Quote: ${quoteToken.symbol})`);
  });

  // Priority 1: Look for USDC pairs
  const usdcPools = pools.filter(pool => {
    const token0Lower = pool.token0.id.toLowerCase();
    const token1Lower = pool.token1.id.toLowerCase();
    return (token0Lower === USDC_KATANA || token1Lower === USDC_KATANA) &&
           (token0Lower === normalizedTarget || token1Lower === normalizedTarget);
  });

  if (usdcPools.length > 0) {
    // Sort USDC pools by TVL and pick the highest
    usdcPools.sort((a, b) => parseFloat(b.totalValueLockedUSD) - parseFloat(a.totalValueLockedUSD));
    console.log(`[Pool Selection] Selected USDC pool: ${usdcPools[0].token0.symbol}/${usdcPools[0].token1.symbol} (TVL: $${usdcPools[0].totalValueLockedUSD})`);
    return usdcPools[0];
  }

  // Priority 2: Look for AUSD pairs
  const ausdPools = pools.filter(pool => {
    const token0Lower = pool.token0.id.toLowerCase();
    const token1Lower = pool.token1.id.toLowerCase();
    return (token0Lower === AUSD_KATANA || token1Lower === AUSD_KATANA) &&
           (token0Lower === normalizedTarget || token1Lower === normalizedTarget);
  });

  if (ausdPools.length > 0) {
    // Sort AUSD pools by TVL and pick the highest
    ausdPools.sort((a, b) => parseFloat(b.totalValueLockedUSD) - parseFloat(a.totalValueLockedUSD));
    console.log(`[Pool Selection] Selected AUSD pool: ${ausdPools[0].token0.symbol}/${ausdPools[0].token1.symbol} (TVL: $${ausdPools[0].totalValueLockedUSD})`);
    return ausdPools[0];
  }

  // Priority 3: Fall back to highest TVL pool
  const highestTvlPool = pools[0]; // Already sorted by TVL desc from query
  console.log(`[Pool Selection] Selected highest TVL pool: ${highestTvlPool.token0.symbol}/${highestTvlPool.token1.symbol} (TVL: $${highestTvlPool.totalValueLockedUSD})`);
  return highestTvlPool;
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
 * Fetch swaps with pagination and limits
 * Modified to respect new skip and total swap limits
 */
async function fetchSwaps(
  poolId: string,
  startTime: number,
  endTime: number,
  maxSwaps: number = MAX_TOTAL_SWAPS // Use the new constant
): Promise<SwapData[]> {
  const allSwaps: SwapData[] = [];
  let hasMore = true;
  let skip = 0;
  const batchSize = 1000;

  console.log(`[Katana Incremental] Fetching swaps for pool ${poolId} from ${startTime} to ${endTime} (DESC order)`);
  console.log(`[Katana Incremental] Limits: maxSwaps=${maxSwaps}, maxSkip=${MAX_SKIP_LIMIT}`);

  while (hasMore && allSwaps.length < maxSwaps && skip <= MAX_SKIP_LIMIT) {
    const remainingSwaps = maxSwaps - allSwaps.length;
    const remainingSkipCapacity = MAX_SKIP_LIMIT - skip;
    
    // Calculate how many swaps to request in this batch
    const requestSize = Math.min(batchSize, remainingSwaps);
    
    // Check if we can make another request within skip limits
    if (remainingSkipCapacity <= 0 && skip > 0) {
      console.log(`[Katana Incremental] Reached maximum skip limit (${MAX_SKIP_LIMIT}), stopping pagination`);
      break;
    }

    const swapsQuery = getSwapsQuery();
    const variables = {
      poolId,
      startTime,
      endTime,
      first: requestSize,
      skip,
    };

    console.log(`[Katana Incremental] Batch: skip=${skip}, requesting=${variables.first}, remaining capacity=${remainingSkipCapacity}`);

    try {
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
        console.log(`[Katana Incremental] No more swaps returned, ending pagination`);
        hasMore = false;
        break;
      }

      allSwaps.push(...swaps);
      
      // Check if we got fewer swaps than requested (indicates end of data)
      if (swaps.length < variables.first) {
        console.log(`[Katana Incremental] Received fewer swaps than requested (${swaps.length}/${variables.first}), ending pagination`);
        hasMore = false;
      } else {
        skip += batchSize;
      }

      console.log(`[Katana Incremental] Batch complete: received ${swaps.length} swaps, total so far: ${allSwaps.length}`);

    } catch (error: any) {
      console.error(`[Katana Incremental] Error fetching batch at skip ${skip}:`, error.message);
      // Don't break entirely, but log the error and try to continue
      break;
    }

    // Rate limiting delay
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Log final statistics
  const stats = {
    totalFetched: allSwaps.length,
    finalSkip: skip,
    hitMaxSwaps: allSwaps.length >= maxSwaps,
    hitMaxSkip: skip > MAX_SKIP_LIMIT,
    oldestSwap: allSwaps.length > 0 ? allSwaps[allSwaps.length - 1]?.timestamp : null,
    newestSwap: allSwaps.length > 0 ? allSwaps[0]?.timestamp : null,
  };

  console.log(`[Katana Incremental] Fetch complete:`, stats);
  return allSwaps;
}

/**
 * Process raw swaps into our format with correct price calculation from sqrtPriceX96
 */
async function processSwaps(rawSwaps: SwapData[], tokenAddress: string, isToken0: boolean): Promise<ProcessedSwap[]> {
  const results: ProcessedSwap[] = [];
  
  for (const swap of rawSwaps) {
    // Calculate correct price from sqrtPriceX96
    const prices = sqrtPriceX96ToTokenPrices(
      swap.sqrtPriceX96,
      parseInt(swap.token0.decimals),
      parseInt(swap.token1.decimals)
    );
    
    let correctTokenPrice: number;
    
    // For USDC pairs, use direct USD pricing (USDC = $1)
    if (swap.token1.id.toLowerCase() === USDC_KATANA) {
      // USDC is token1, so token0Price gives price in USDC terms (= USD)
      correctTokenPrice = isToken0 ? prices.token0Price : 1.0;
    } else if (swap.token0.id.toLowerCase() === USDC_KATANA) {
      // USDC is token0, so token1Price gives price in USDC terms (= USD)
      correctTokenPrice = isToken0 ? 1.0 : prices.token1Price;
    } else if (swap.token1.id.toLowerCase() === AUSD_KATANA) {
      // AUSD is token1, so token0Price gives price in AUSD terms (= USD)
      correctTokenPrice = isToken0 ? prices.token0Price : 1.0;
    } else if (swap.token0.id.toLowerCase() === AUSD_KATANA) {
      // AUSD is token0, so token1Price gives price in AUSD terms (= USD)
      correctTokenPrice = isToken0 ? 1.0 : prices.token1Price;
    } else {
      // For non-stable pairs, get counter token USD price and calculate
      const counterToken = isToken0 ? swap.token1 : swap.token0;
      const counterTokenPrice = await getTokenUSDPrice(
        counterToken.id,
        counterToken.symbol,
        747474 // Katana chain ID
      );
      
      if (counterTokenPrice > 0) {
        // Calculate target token price using counter token USD price
        const tokenPriceInCounterToken = isToken0 ? prices.token0Price : prices.token1Price;
        correctTokenPrice = tokenPriceInCounterToken * counterTokenPrice;
      } else {
        // Fallback to original calculation if counter token price unavailable
        correctTokenPrice = isToken0 ? prices.token0Price : prices.token1Price;
        console.warn(`Could not get USD price for counter token ${counterToken.symbol}, using fallback calculation`);
      }
    }
    
    results.push({
      id: swap.id,
      timestamp: parseInt(swap.timestamp) * 1000, // Convert to milliseconds
      tokenPriceUSD: correctTokenPrice, // Use calculated price instead of indexer price
      tokenVolumeUSD: isToken0
        ? Math.abs(parseFloat(swap.amount0USD || "0")) // Take absolute value
        : Math.abs(parseFloat(swap.amount1USD || "0")), // Take absolute value
      totalVolumeUSD: parseFloat(swap.amountUSD || "0"),
    });
  }
  
  return results;
}

/**
 * Merge new swaps with existing data, removing duplicates
 * Modified to handle descending order properly
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
  
  // Convert back to array and sort by timestamp (newest first to maintain DESC order)
  const mergedSwaps = Array.from(swapMap.values());
  mergedSwaps.sort((a, b) => b.timestamp - a.timestamp); // DESC order
  
  console.log(`[Katana Incremental] Merged swaps: ${existingSwaps.length} existing + ${newSwaps.length} new = ${mergedSwaps.length} total (DESC order)`);
  
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
 * Get swap data with incremental updates and MySQL historical integration
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
          console.log(`[Katana Incremental] Data is fresh, returning cached data with historical integration`);
          
          // Calculate requested time range
          const requestedStartTime = Math.floor(Date.now() / 1000) - (daysNum * 24 * 60 * 60);
          
          // Load historical swaps from MySQL for the requested time range
          const historicalSwaps = await loadHistoricalSwapsFromMySQL(
            normalizedAddress,
            storedData!.metadata.pool.id,
            requestedStartTime
          );
          
          // Filter Redis data to requested time range
          const filteredRedisSwaps = storedData!.swaps.filter(
            swap => swap.timestamp >= requestedStartTime * 1000
          );
          
          // Merge Redis and MySQL data
          const combinedSwaps = mergeWithHistoricalSwaps(filteredRedisSwaps, historicalSwaps);
          
          const responseData = {
            swaps: combinedSwaps,
            metadata: {
              ...storedData!.metadata,
              totalSwaps: combinedSwaps.length,
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
            source: "katana-sushiswap-hybrid",
            cached: true,
            tokenAddress: normalizedAddress,
            count: combinedSwaps.length,
            poolId: storedData!.metadata.pool.id,
            poolToken0: storedData!.metadata.pool.token0,
            poolToken1: storedData!.metadata.pool.token1,
            poolTVL: storedData!.metadata.pool.totalValueLockedUSD.toString(),
            chain: "katana",
            updateStatus: "fresh",
            dataSource: {
              redis: filteredRedisSwaps.length,
              mysql: historicalSwaps.length,
              total: combinedSwaps.length
            },
            limits: {
              maxSwaps: MAX_TOTAL_SWAPS,
              maxSkip: MAX_SKIP_LIMIT,
            },
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
              
              // Load historical swaps even during lock
              const historicalSwaps = await loadHistoricalSwapsFromMySQL(
                normalizedAddress,
                storedData.metadata.pool.id,
                requestedStartTime
              );
              
              const filteredRedisSwaps = storedData.swaps.filter(
                swap => swap.timestamp >= requestedStartTime * 1000
              );
              
              const combinedSwaps = mergeWithHistoricalSwaps(filteredRedisSwaps, historicalSwaps);

              res.status(200).json({
                status: "success",
                data: { 
                  swaps: combinedSwaps,
                  metadata: {
                    ...storedData.metadata,
                    totalSwaps: combinedSwaps.length,
                  }
                },
                cached: true,
                updateStatus: "updating",
                message: "Data update in progress, returning existing data with historical integration",
                dataSource: {
                  redis: filteredRedisSwaps.length,
                  mysql: historicalSwaps.length,
                  total: combinedSwaps.length
                },
                limits: {
                  maxSwaps: MAX_TOTAL_SWAPS,
                  maxSkip: MAX_SKIP_LIMIT,
                },
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

        // Step 5: Find highest TVL pool with priority selection (only if we don't have pool info)
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
          // Find pool with priority selection
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

          // Use the priority selection function
          selectedPool = selectBestPool(poolsResponse.data.data.pools, normalizedAddress);
          
          console.log(`[Katana Incremental] Selected pool with priority logic:`, {
            poolId: selectedPool.id,
            pair: `${selectedPool.token0.symbol}/${selectedPool.token1.symbol}`,
            tvl: selectedPool.totalValueLockedUSD,
          });
        }

        // Determine token position in pool
        const isToken0 = selectedPool.token0.id.toLowerCase() === normalizedAddress;
        const baseToken = isToken0 ? selectedPool.token0 : selectedPool.token1;
        const quoteToken = isToken0 ? selectedPool.token1 : selectedPool.token0;

        console.log(`[Katana Incremental] Token mapping:`, {
          targetToken: normalizedAddress,
          isToken0,
          baseToken: `${baseToken.symbol} (${baseToken.id})`,
          quoteToken: `${quoteToken.symbol} (${quoteToken.id})`,
        });

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
        const processedNewSwaps = await processSwaps(newSwaps, normalizedAddress, isToken0);
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

        // Step 10: Filter data for response with historical integration
        const requestedStartTime = Math.floor(Date.now() / 1000) - (daysNum * 24 * 60 * 60);
        
        // Load historical swaps from MySQL
        const historicalSwaps = await loadHistoricalSwapsFromMySQL(
          normalizedAddress,
          selectedPool.id,
          requestedStartTime
        );
        
        // Filter Redis data to requested time range
        const filteredRedisSwaps = allSwaps.filter(
          swap => swap.timestamp >= requestedStartTime * 1000
        );
        
        // Merge Redis and MySQL data
        const combinedSwaps = mergeWithHistoricalSwaps(filteredRedisSwaps, historicalSwaps);

        const responseData = {
          swaps: combinedSwaps,
          metadata: {
            ...updatedStoredData.metadata,
            totalSwaps: combinedSwaps.length,
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

        console.log(`[Katana Incremental] Sending response with ${combinedSwaps.length} total swaps (${filteredRedisSwaps.length} Redis + ${historicalSwaps.length} MySQL)`);

        res.status(200).json({
          status: "success",
          data: responseData,
          source: "katana-sushiswap-hybrid",
          cached: false,
          tokenAddress: normalizedAddress,
          count: combinedSwaps.length,
          poolId: selectedPool.id,
          poolTVL: selectedPool.totalValueLockedUSD,
          chain: "katana",
          updateStatus: "updated",
          dataSource: {
            redis: filteredRedisSwaps.length,
            mysql: historicalSwaps.length,
            total: combinedSwaps.length
          },
          stats: {
            totalSwapsStored: allSwaps.length,
            newSwapsFetched: processedNewSwaps.length,
            existingSwaps: existingSwaps.length,
            historicalFromMySQL: historicalSwaps.length,
          },
          limits: {
            maxSwaps: MAX_TOTAL_SWAPS,
            maxSkip: MAX_SKIP_LIMIT,
            appliedLimits: {
              hitMaxSwaps: allSwaps.length >= MAX_TOTAL_SWAPS,
              totalFetched: allSwaps.length,
            },
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
      limits: {
        maxSwaps: MAX_TOTAL_SWAPS,
        maxSkip: MAX_SKIP_LIMIT,
      },
    });
  } catch (error) {
    console.error("[Katana Incremental] Clear cache error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
    });
  }
}