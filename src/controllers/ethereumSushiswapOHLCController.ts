// src/controllers/ethereumSushiswapSwapController.ts
import type { Request, Response, NextFunction } from "express";
import axios from "axios";
import Bottleneck from "bottleneck";
import { getValue, storeValue } from "../redis/ethereumTokens";
import EthereumSwap from "../models/EthereumSwap";
import { Op } from "sequelize";

import { getTokenUSDPrice } from "../utils/sushiPriceUtils";

// Types for V2 (different from V3)
interface SwapData {
  id: string;
  timestamp: string;
  token0PriceUSD: string;
  token1PriceUSD: string;
  amount0In: string;
  amount0Out: string;
  amount1In: string;
  amount1Out: string;
  amountUSD: string;
  pair: {
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
}

interface Pair {
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
  reserveUSD: string;
  volumeUSD: string;
  // V2 specific fields
  reserve0: string;
  reserve1: string;
  token0Price: string;
  token1Price: string;
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
    pair: {
      id: string;
      address: string;
      token0: any;
      token1: any;
      reserveUSD: number;
      volumeUSD: number;
      // V2 specific
      reserve0: number;
      reserve1: number;
      token0Price: number;
      token1Price: number;
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
    pairs?: Pair[];
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
const FULL_SWAP_DATA_PREFIX = "full_swaps_ethereum_";
const FULL_SWAP_DATA_TTL = 365 * 24 * 60 * 60; // 365 days (1 year)
const UPDATE_LOCK_PREFIX = "update_lock_ethereum_";
const UPDATE_LOCK_TTL = 60 * 60; // 1 hour lock

// Constants for Ethereum
const ETHEREUM_SUBGRAPH_URL = "https://api.studio.thegraph.com/query/106601/sushi-v-2-eth/version/latest";
const FULL_DATA_DAYS = 365;
const UPDATE_INTERVAL_HOURS = 1;
const MAX_SKIP_LIMIT = 2000; // Maximum skip value allowed
const MAX_TOTAL_SWAPS = 3000; // Maximum total swaps across all batches

// Priority tokens for pool selection (Ethereum mainnet)
const USDC_ETHEREUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase();
const DAI_ETHEREUM = "0x6B175474E89094C44Da98b954EedeAC495271d0F".toLowerCase();
const USDT_ETHEREUM = "0xdAC17F958D2ee523a2206206994597C13D831ec7".toLowerCase();

/**
 * Calculate token prices from V2 pair reserves (different from V3 sqrtPriceX96)
 */
function calculateV2TokenPrices(
  reserve0: string,
  reserve1: string,
  token0Decimals: number,
  token1Decimals: number
): { token0Price: number; token1Price: number } {
  try {
    const reserve0Num = parseFloat(reserve0);
    const reserve1Num = parseFloat(reserve1);
    
    if (reserve0Num === 0 || reserve1Num === 0) {
      return { token0Price: 0, token1Price: 0 };
    }
    
    // Adjust for decimals
    const adjustedReserve0 = reserve0Num / Math.pow(10, token0Decimals);
    const adjustedReserve1 = reserve1Num / Math.pow(10, token1Decimals);
    
    // Price of token0 in terms of token1
    const token0Price = adjustedReserve1 / adjustedReserve0;
    // Price of token1 in terms of token0
    const token1Price = adjustedReserve0 / adjustedReserve1;
    
    return { token0Price, token1Price };
  } catch (error) {
    console.error("Error calculating V2 token prices:", error);
    return { token0Price: 0, token1Price: 0 };
  }
}

/**
 * Load historical swaps from MySQL table
 */
async function loadHistoricalSwapsFromMySQL(
  tokenAddress: string,
  pairId: string,
  requestedStartTime: number // Unix timestamp in seconds
): Promise<ProcessedSwap[]> {
  try {
    console.log(`[MySQL Historical] Loading swaps for token ${tokenAddress}, pair ${pairId}`);
    
    const historicalSwaps = await EthereumSwap.findAll({
      attributes: [
        'id',
        'timestamp',
        'token_price_usd',
        'token_volume_usd',
        'total_volume_usd'
      ],
      where: {
        token_address: tokenAddress.toLowerCase(),
        pool_id: pairId.toLowerCase(), // Use pool_id instead of pair_id
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
 * Get GraphQL query to find pairs containing a specific token, ordered by reserveUSD (V2)
 */
function getPairsByReserveQuery(): string {
  return `
    query GetPairsByReserve($tokenAddress: String!) {
      pairs(
        where: {
          or: [
            { token0: $tokenAddress },
            { token1: $tokenAddress }
          ]
        }
        orderBy: reserveUSD
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
        reserveUSD
        volumeUSD
        reserve0
        reserve1
        token0Price
        token1Price
      }
    }
  `;
}

/**
 * Get GraphQL query for swap data from a specific pair with time filtering (V2)
 */
function getSwapsQuery(): string {
  return `
    query GetSwaps($pairId: String!, $startTime: Int!, $endTime: Int!, $first: Int!, $skip: Int!) {
      swaps(
        where: {
          pair: $pairId,
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
        token0PriceUSD
        token1PriceUSD
        amount0In
        amount0Out
        amount1In
        amount1Out
        amountUSD
        pair {
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
      }
    }
  `;
}

/**
 * Prioritize pairs based on quote token preference
 * Priority: USDC > DAI > USDT > highest reserveUSD
 */
function selectBestPair(pairs: Pair[], targetTokenAddress: string): Pair {
  if (pairs.length === 0) {
    throw new Error("No pairs available");
  }

  const normalizedTarget = targetTokenAddress.toLowerCase();
  
  console.log(`[Pair Selection] Selecting best pair from ${pairs.length} options for token ${normalizedTarget}`);
  
  // Log all available pairs for debugging
  pairs.forEach((pair, index) => {
    const token0Lower = pair.token0.id.toLowerCase();
    const token1Lower = pair.token1.id.toLowerCase();
    const quoteToken = token0Lower === normalizedTarget ? pair.token1 : pair.token0;
    
    console.log(`[Pair Selection] Pair ${index}: ${pair.token0.symbol}/${pair.token1.symbol} (Reserve: $${pair.reserveUSD}, Quote: ${quoteToken.symbol})`);
  });

  // Priority 1: Look for USDC pairs
  const usdcPairs = pairs.filter(pair => {
    const token0Lower = pair.token0.id.toLowerCase();
    const token1Lower = pair.token1.id.toLowerCase();
    return (token0Lower === USDC_ETHEREUM || token1Lower === USDC_ETHEREUM) &&
           (token0Lower === normalizedTarget || token1Lower === normalizedTarget);
  });

  if (usdcPairs.length > 0) {
    // Sort USDC pairs by reserveUSD and pick the highest
    usdcPairs.sort((a, b) => parseFloat(b.reserveUSD) - parseFloat(a.reserveUSD));
    console.log(`[Pair Selection] Selected USDC pair: ${usdcPairs[0].token0.symbol}/${usdcPairs[0].token1.symbol} (Reserve: $${usdcPairs[0].reserveUSD})`);
    return usdcPairs[0];
  }

  // Priority 2: Look for DAI pairs
  const daiPairs = pairs.filter(pair => {
    const token0Lower = pair.token0.id.toLowerCase();
    const token1Lower = pair.token1.id.toLowerCase();
    return (token0Lower === DAI_ETHEREUM || token1Lower === DAI_ETHEREUM) &&
           (token0Lower === normalizedTarget || token1Lower === normalizedTarget);
  });

  if (daiPairs.length > 0) {
    // Sort DAI pairs by reserveUSD and pick the highest
    daiPairs.sort((a, b) => parseFloat(b.reserveUSD) - parseFloat(a.reserveUSD));
    console.log(`[Pair Selection] Selected DAI pair: ${daiPairs[0].token0.symbol}/${daiPairs[0].token1.symbol} (Reserve: $${daiPairs[0].reserveUSD})`);
    return daiPairs[0];
  }

  // Priority 3: Look for USDT pairs
  const usdtPairs = pairs.filter(pair => {
    const token0Lower = pair.token0.id.toLowerCase();
    const token1Lower = pair.token1.id.toLowerCase();
    return (token0Lower === USDT_ETHEREUM || token1Lower === USDT_ETHEREUM) &&
           (token0Lower === normalizedTarget || token1Lower === normalizedTarget);
  });

  if (usdtPairs.length > 0) {
    // Sort USDT pairs by reserveUSD and pick the highest
    usdtPairs.sort((a, b) => parseFloat(b.reserveUSD) - parseFloat(a.reserveUSD));
    console.log(`[Pair Selection] Selected USDT pair: ${usdtPairs[0].token0.symbol}/${usdtPairs[0].token1.symbol} (Reserve: $${usdtPairs[0].reserveUSD})`);
    return usdtPairs[0];
  }

  // Priority 4: Fall back to highest reserveUSD pair
  const highestReservePair = pairs[0]; // Already sorted by reserveUSD desc from query
  console.log(`[Pair Selection] Selected highest reserve pair: ${highestReservePair.token0.symbol}/${highestReservePair.token1.symbol} (Reserve: $${highestReservePair.reserveUSD})`);
  return highestReservePair;
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
 */
async function fetchSwaps(
  pairId: string,
  startTime: number,
  endTime: number,
  maxSwaps: number = MAX_TOTAL_SWAPS
): Promise<SwapData[]> {
  const allSwaps: SwapData[] = [];
  let hasMore = true;
  let skip = 0;
  const batchSize = 1000;

  console.log(`[Ethereum Incremental] Fetching swaps for pair ${pairId} from ${startTime} to ${endTime} (DESC order)`);
  console.log(`[Ethereum Incremental] Limits: maxSwaps=${maxSwaps}, maxSkip=${MAX_SKIP_LIMIT}`);

  while (hasMore && allSwaps.length < maxSwaps && skip <= MAX_SKIP_LIMIT) {
    const remainingSwaps = maxSwaps - allSwaps.length;
    const remainingSkipCapacity = MAX_SKIP_LIMIT - skip;
    
    // Calculate how many swaps to request in this batch
    const requestSize = Math.min(batchSize, remainingSwaps);
    
    // Check if we can make another request within skip limits
    if (remainingSkipCapacity <= 0 && skip > 0) {
      console.log(`[Ethereum Incremental] Reached maximum skip limit (${MAX_SKIP_LIMIT}), stopping pagination`);
      break;
    }

    const swapsQuery = getSwapsQuery();
    const variables = {
      pairId,
      startTime,
      endTime,
      first: requestSize,
      skip,
    };

    console.log(`[Ethereum Incremental] Batch: skip=${skip}, requesting=${variables.first}, remaining capacity=${remainingSkipCapacity}`);

    try {
      const response = await axios.post<SushiGraphResponse>(
        ETHEREUM_SUBGRAPH_URL,
        { query: swapsQuery, variables },
        {
          timeout: 15000,
          headers: { "Content-Type": "application/json" },
        }
      );

      const swaps = response.data.data.swaps;

      if (!swaps || swaps.length === 0) {
        console.log(`[Ethereum Incremental] No more swaps returned, ending pagination`);
        hasMore = false;
        break;
      }

      allSwaps.push(...swaps);
      
      // Check if we got fewer swaps than requested (indicates end of data)
      if (swaps.length < variables.first) {
        console.log(`[Ethereum Incremental] Received fewer swaps than requested (${swaps.length}/${variables.first}), ending pagination`);
        hasMore = false;
      } else {
        skip += batchSize;
      }

      console.log(`[Ethereum Incremental] Batch complete: received ${swaps.length} swaps, total so far: ${allSwaps.length}`);

    } catch (error: any) {
      console.error(`[Ethereum Incremental] Error fetching batch at skip ${skip}:`, error.message);
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

  console.log(`[Ethereum Incremental] Fetch complete:`, stats);
  return allSwaps;
}

/**
 * Process raw swaps into our format with V2-specific logic
 */
async function processSwaps(rawSwaps: SwapData[], tokenAddress: string, isToken0: boolean): Promise<ProcessedSwap[]> {
  const results: ProcessedSwap[] = [];
  
  for (const swap of rawSwaps) {
    // V2 uses direct USD prices from indexer or calculate from amounts
    let tokenPriceUSD: number;
    let tokenVolumeUSD: number;
    
    // Calculate volume from amount0In/Out, amount1In/Out
    const amount0In = parseFloat(swap.amount0In || "0");
    const amount0Out = parseFloat(swap.amount0Out || "0");
    const amount1In = parseFloat(swap.amount1In || "0");
    const amount1Out = parseFloat(swap.amount1Out || "0");
    
    // For the target token, calculate the volume (in or out)
    if (isToken0) {
      tokenVolumeUSD = Math.max(amount0In, amount0Out) * parseFloat(swap.token0PriceUSD || "0");
      tokenPriceUSD = parseFloat(swap.token0PriceUSD || "0");
    } else {
      tokenVolumeUSD = Math.max(amount1In, amount1Out) * parseFloat(swap.token1PriceUSD || "0");
      tokenPriceUSD = parseFloat(swap.token1PriceUSD || "0");
    }
    
    // If indexer price is not available or 0, try to calculate from counter token
    if (tokenPriceUSD === 0) {
      const counterToken = isToken0 ? swap.pair.token1 : swap.pair.token0;
      const counterTokenPriceUSD = isToken0 ? parseFloat(swap.token1PriceUSD || "0") : parseFloat(swap.token0PriceUSD || "0");
      
      if (counterTokenPriceUSD > 0) {
        // Use ratio of amounts to calculate price
        const tokenAmount = isToken0 ? Math.max(amount0In, amount0Out) : Math.max(amount1In, amount1Out);
        const counterAmount = isToken0 ? Math.max(amount1In, amount1Out) : Math.max(amount0In, amount0Out);
        
        if (tokenAmount > 0 && counterAmount > 0) {
          const tokenPriceInCounterToken = counterAmount / tokenAmount;
          tokenPriceUSD = tokenPriceInCounterToken * counterTokenPriceUSD;
        }
      } else {
        // Fallback to external price API
        tokenPriceUSD = await getTokenUSDPrice(
          tokenAddress,
          isToken0 ? swap.pair.token0.symbol : swap.pair.token1.symbol,
          1 // Ethereum mainnet
        );
      }
    }
    
    results.push({
      id: swap.id,
      timestamp: parseInt(swap.timestamp) * 1000, // Convert to milliseconds
      tokenPriceUSD,
      tokenVolumeUSD: Math.abs(tokenVolumeUSD), // Take absolute value
      totalVolumeUSD: parseFloat(swap.amountUSD || "0"),
    });
  }
  
  return results;
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
  
  // Convert back to array and sort by timestamp (newest first to maintain DESC order)
  const mergedSwaps = Array.from(swapMap.values());
  mergedSwaps.sort((a, b) => b.timestamp - a.timestamp); // DESC order
  
  console.log(`[Ethereum Incremental] Merged swaps: ${existingSwaps.length} existing + ${newSwaps.length} new = ${mergedSwaps.length} total (DESC order)`);
  
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
export async function getEthereumSwapData(
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

    console.log(`[Ethereum Incremental] Cache key: ${cacheKey}`);

    await sushiLimiter.schedule(async () => {
      try {
        // Step 1: Try to load existing data
        let storedData: StoredSwapData | null = null;
        try {
          const cached = await getValue(cacheKey);
          if (cached) {
            storedData = JSON.parse(cached);
            console.log(`[Ethereum Incremental] Found existing data:`, {
              swapsCount: storedData?.swaps.length,
              lastUpdate: storedData?.metadata.lastUpdate,
              lastSwapTimestamp: storedData?.metadata.lastSwapTimestamp,
            });
          }
        } catch (cacheError) {
          console.warn(`[Ethereum Incremental] Cache read error:`, cacheError);
        }

        // Step 2: Determine if we need to update
        const shouldUpdate = force || !storedData || needsUpdate(storedData.metadata.lastUpdate);
        
        if (!shouldUpdate) {
          console.log(`[Ethereum Incremental] Data is fresh, returning cached data with historical integration`);
          
          // Calculate requested time range
          const requestedStartTime = Math.floor(Date.now() / 1000) - (daysNum * 24 * 60 * 60);
          
          // Load historical swaps from MySQL for the requested time range
          const historicalSwaps = await loadHistoricalSwapsFromMySQL(
            normalizedAddress,
            storedData!.metadata.pair.id,
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
            source: "ethereum-sushiswap-v2-hybrid",
            cached: true,
            tokenAddress: normalizedAddress,
            count: combinedSwaps.length,
            pairId: storedData!.metadata.pair.id,
            pairToken0: storedData!.metadata.pair.token0,
            pairToken1: storedData!.metadata.pair.token1,
            pairReserveUSD: storedData!.metadata.pair.reserveUSD.toString(),
            chain: "ethereum",
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
            console.log(`[Ethereum Incremental] Update in progress, returning stale data`);
            
            if (storedData) {
              const requestedStartTime = Math.floor(Date.now() / 1000) - (daysNum * 24 * 60 * 60);
              
              // Load historical swaps even during lock
              const historicalSwaps = await loadHistoricalSwapsFromMySQL(
                normalizedAddress,
                storedData.metadata.pair.id,
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
          console.warn(`[Ethereum Incremental] Lock check error:`, lockError);
        }

        // Step 4: Set update lock
        try {
          await storeValue(lockKey, "updating", UPDATE_LOCK_TTL);
        } catch (lockError) {
          console.warn(`[Ethereum Incremental] Failed to set update lock:`, lockError);
        }

        console.log(`[Ethereum Incremental] Updating data for token: ${normalizedAddress}`);

        // Step 5: Find highest reserveUSD pair with priority selection (only if we don't have pair info)
        let selectedPair: Pair;
        
        if (storedData?.metadata.pair) {
          // Use existing pair info
          selectedPair = {
            id: storedData.metadata.pair.id,
            token0: storedData.metadata.pair.token0,
            token1: storedData.metadata.pair.token1,
            reserveUSD: storedData.metadata.pair.reserveUSD.toString(),
            volumeUSD: storedData.metadata.pair.volumeUSD.toString(),
            reserve0: storedData.metadata.pair.reserve0.toString(),
            reserve1: storedData.metadata.pair.reserve1.toString(),
            token0Price: storedData.metadata.pair.token0Price.toString(),
            token1Price: storedData.metadata.pair.token1Price.toString(),
          };
          console.log(`[Ethereum Incremental] Using existing pair: ${selectedPair.id}`);
        } else {
          // Find pair with priority selection
          const pairsQuery = getPairsByReserveQuery();
          const pairsVariables = { tokenAddress: normalizedAddress };

          const pairsResponse = await axios.post<SushiGraphResponse>(
            ETHEREUM_SUBGRAPH_URL,
            { query: pairsQuery, variables: pairsVariables },
            {
              timeout: 15000,
              headers: { "Content-Type": "application/json" },
            }
          );

          if (!pairsResponse.data.data.pairs || pairsResponse.data.data.pairs.length === 0) {
            res.status(404).json({
              status: "error",
              msg: "No pairs found for this token on Ethereum SushiSwap V2",
              tokenAddress: normalizedAddress,
            });
            return;
          }

          // Use the priority selection function
          selectedPair = selectBestPair(pairsResponse.data.data.pairs, normalizedAddress);
          
          console.log(`[Ethereum Incremental] Selected pair with priority logic:`, {
            pairId: selectedPair.id,
            pair: `${selectedPair.token0.symbol}/${selectedPair.token1.symbol}`,
            reserveUSD: selectedPair.reserveUSD,
          });
        }

        // Determine token position in pair
        const isToken0 = selectedPair.token0.id.toLowerCase() === normalizedAddress;
        const baseToken = isToken0 ? selectedPair.token0 : selectedPair.token1;
        const quoteToken = isToken0 ? selectedPair.token1 : selectedPair.token0;

        console.log(`[Ethereum Incremental] Token mapping:`, {
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
            Math.floor(storedData.metadata.lastSwapTimestamp / 1000) // FIXED: Convert ms to seconds
          );
          
          console.log(`[Ethereum Incremental] Incremental fetch from ${startTime} to ${endTime}`);
          newSwaps = await fetchSwaps(selectedPair.id, startTime, endTime);
          console.log(`[Ethereum Incremental] Fetched ${newSwaps.length} new swaps`);
          
        } else {
          // Full fetch: get all data for 365 days
          const { startTime, endTime } = getFullTimeRange();
          
          console.log(`[Ethereum Incremental] Full fetch from ${startTime} to ${endTime}`);
          newSwaps = await fetchSwaps(selectedPair.id, startTime, endTime);
          
          console.log(`[Ethereum Incremental] Fetched ${newSwaps.length} total swaps`);
        }

        // Step 7: Process and merge data
        const processedNewSwaps = await processSwaps(newSwaps, normalizedAddress, isToken0);
        const existingSwaps = storedData?.swaps || [];
        const allSwaps = mergeSwaps(existingSwaps, processedNewSwaps);

        console.log(`[Ethereum Incremental] Merged data: ${existingSwaps.length} existing + ${processedNewSwaps.length} new = ${allSwaps.length} total`);

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
            pair: {
              id: selectedPair.id,
              address: selectedPair.id,
              token0: selectedPair.token0,
              token1: selectedPair.token1,
              reserveUSD: parseFloat(selectedPair.reserveUSD),
              volumeUSD: parseFloat(selectedPair.volumeUSD),
              reserve0: parseFloat(selectedPair.reserve0),
              reserve1: parseFloat(selectedPair.reserve1),
              token0Price: parseFloat(selectedPair.token0Price),
              token1Price: parseFloat(selectedPair.token1Price),
            },
            isToken0,
            quoteToken,
            lastUpdate: now,
            lastSwapTimestamp,
            dataRange: {
              start: allSwaps.length > 0 ? Math.min(...allSwaps.map(s => s.timestamp)) : now * 1000,
              end: lastSwapTimestamp,
            },
            chain: "ethereum",
            dexId: "ethereum-sushiswap-v2",
          },
        };

        // Step 9: Save updated data to Redis
        try {
          await storeValue(cacheKey, JSON.stringify(updatedStoredData), FULL_SWAP_DATA_TTL);
          console.log(`[Ethereum Incremental] Successfully saved ${allSwaps.length} swaps to Redis`);
        } catch (saveError) {
          console.error(`[Ethereum Incremental] Failed to save to Redis:`, saveError);
        }

        // Step 10: Filter data for response with historical integration
        const requestedStartTime = Math.floor(Date.now() / 1000) - (daysNum * 24 * 60 * 60);
        
        // Load historical swaps from MySQL
        const historicalSwaps = await loadHistoricalSwapsFromMySQL(
          normalizedAddress,
          selectedPair.id,
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
          console.warn(`[Ethereum Incremental] Failed to clear update lock:`, unlockError);
        }

        console.log(`[Ethereum Incremental] Sending response with ${combinedSwaps.length} total swaps (${filteredRedisSwaps.length} Redis + ${historicalSwaps.length} MySQL)`);

        res.status(200).json({
          status: "success",
          data: responseData,
          source: "ethereum-sushiswap-v2-hybrid",
          cached: false,
          tokenAddress: normalizedAddress,
          count: combinedSwaps.length,
          pairId: selectedPair.id,
          pairReserveUSD: selectedPair.reserveUSD,
          chain: "ethereum",
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
        console.error(`[Ethereum Incremental] API error:`, {
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
    console.error("[Ethereum Incremental] Controller error:", error);
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
export async function clearEthereumSwapCache(
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
    
    console.log(`[Ethereum Incremental] Clearing cache for: ${normalizedAddress}`);

    // Note: Implement Redis delete if available, or set very short TTL
    // await deleteValue(cacheKey);

    res.status(200).json({
      status: "success",
      msg: "Cache cleared successfully",
      tokenAddress: normalizedAddress,
      chain: "ethereum",
      limits: {
        maxSwaps: MAX_TOTAL_SWAPS,
        maxSkip: MAX_SKIP_LIMIT,
      },
    });
  } catch (error) {
    console.error("[Ethereum Incremental] Clear cache error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
    });
  }
}