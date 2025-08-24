//using
// src/controllers/katanaSushiswapSqrtPriceController.ts
import type { Request, Response, NextFunction } from "express";
import axios from "axios";
import Bottleneck from "bottleneck";
import { getValue, storeValue } from "../../redis/katanaTokens";

// Types
interface SwapDataWithSqrt {
  id: string;
  timestamp: string;
  sqrtPriceX96: string;
  tick: string;
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
  token0Price: string;
  token1Price: string;
  sqrtPrice: string;
  tick: string;
}

interface ProcessedSwap {
  id: string;
  timestamp: number;
  poolPrice: number; // Scaled USD price
  rawPoolPrice: number; // Original pool ratio
  tokenVolumeUSD: number;
  totalVolumeUSD: number;
  sqrtPriceX96: string;
  tick: number;
}

interface FetchProgress {
  lastFetchedTimestamp: number;
  totalBatches: number;
  completedBatches: number;
  isComplete: boolean;
  failedRanges: Array<{start: number, end: number, error: string}>;
  lastBatchSize: number;
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
      currentPoolPrice: number;
      currentSushiPrice: number;
      scalingFactor: number;
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
    // New partial fetch tracking
    fetchProgress: FetchProgress;
  };
}

interface SushiGraphResponse {
  data: {
    swaps?: SwapDataWithSqrt[];
    pools?: Pool[];
  };
  errors?: any[];
}

// Rate limiter for SushiSwap subgraph
const sushiLimiter = new Bottleneck({
  reservoir: 60,
  reservoirRefreshAmount: 60,
  reservoirRefreshInterval: 60 * 1000,
  maxConcurrent: 2,
  minTime: 1000,
});

// Cache configuration
const SQRT_PRICE_DATA_PREFIX = "sqrt_price_katana_";
const SQRT_PRICE_DATA_TTL = 365 * 24 * 60 * 60;
const UPDATE_LOCK_PREFIX = "sqrt_update_lock_katana_";
const UPDATE_LOCK_TTL = 60 * 60;

// Constants
const KATANA_SUBGRAPH_URL = "https://api.studio.thegraph.com/query/106601/sushi-v-3-katana/version/latest";
const SUSHI_API_BASE = "https://api.sushi.com/price/v1";
const KATANA_CHAIN_ID = 747474;
const FULL_DATA_DAYS = 365;
const UPDATE_INTERVAL_HOURS = 1;
const SAVE_PROGRESS_EVERY_N_BATCHES = 5; // Save progress every 5 batches

/**
 * Save partial progress to cache with safe metadata handling
 */
async function savePartialProgress(
  cacheKey: string,
  partialData: StoredSwapData,
  batchNumber: number,
  lastFetchedTimestamp: number,
  isComplete: boolean = false
): Promise<void> {
  try {
    // Ensure fetchProgress exists
    if (!partialData.metadata.fetchProgress) {
      partialData.metadata.fetchProgress = {
        lastFetchedTimestamp: lastFetchedTimestamp,
        totalBatches: Math.ceil(50000 / 1000), // Default estimate
        completedBatches: 0,
        isComplete: false,
        failedRanges: [],
        lastBatchSize: 1000,
      };
    }
    
    // Update fetch progress safely
    partialData.metadata.fetchProgress.lastFetchedTimestamp = lastFetchedTimestamp;
    partialData.metadata.fetchProgress.completedBatches = batchNumber;
    partialData.metadata.fetchProgress.isComplete = isComplete;
    
    await storeValue(cacheKey, JSON.stringify(partialData), SQRT_PRICE_DATA_TTL);
    console.log(`[Katana SqrtPrice] Saved partial progress: ${batchNumber} batches, ${partialData.swaps.length} swaps, lastTimestamp: ${lastFetchedTimestamp}`);
  } catch (error) {
    console.error(`[Katana SqrtPrice] Failed to save partial progress:`, error);
  }
}

/**
 * Fetch current token price from Sushi API
 */
async function fetchSushiPrice(tokenAddress: string): Promise<number | null> {
  try {
    console.log(`[Katana SqrtPrice] Fetching Sushi API price for token: ${tokenAddress}`);
    
    const { data } = await axios.get(
      `${SUSHI_API_BASE}/${KATANA_CHAIN_ID}/${tokenAddress}`,
      {
        timeout: 10000,
      }
    );

    console.log(`[Katana SqrtPrice] Sushi API response:`, data);
    return data || null;
  } catch (error) {
    console.error(`[Katana SqrtPrice] Failed to fetch Sushi price:`, error);
    return null;
  }
}

/**
 * Get GraphQL query to find pools by TVL (any pair)
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
        token0Price
        token1Price
        sqrtPrice
        tick
      }
    }
  `;
}

/**
 * Calculate pool price ratio from sqrtPriceX96
 */
function calculatePoolRatioFromSqrtPriceX96(
  sqrtPriceX96: string,
  token0Decimals: number,
  token1Decimals: number,
  isToken0: boolean
): number {
  try {
    const sqrtPrice = BigInt(sqrtPriceX96);
    
    // Convert to decimal (sqrtPriceX96 / 2^96)
    const Q96 = BigInt(2) ** BigInt(96);
    const sqrtPriceDecimal = Number(sqrtPrice) / Number(Q96);
    
    // Square to get the actual price ratio
    const priceRatio = sqrtPriceDecimal * sqrtPriceDecimal;
    
    // Adjust for token decimals
    const decimalAdjustment = Math.pow(10, token1Decimals - token0Decimals);
    const adjustedPrice = priceRatio * decimalAdjustment;
    
    // Return price based on token position
    if (isToken0) {
      // We want price of token0 in terms of token1
      return 1 / adjustedPrice;
    } else {
      // We want price of token1 in terms of token0
      return adjustedPrice;
    }
  } catch (error) {
    console.error('Error calculating pool ratio from sqrtPriceX96:', error);
    return 0;
  }
}

/**
 * Calculate current pool ratio from pool state
 */
function calculateCurrentPoolRatio(pool: Pool, isToken0: boolean): number {
  if (pool.sqrtPrice && pool.sqrtPrice !== "0") {
    const token0Decimals = parseInt(pool.token0.decimals);
    const token1Decimals = parseInt(pool.token1.decimals);
    
    return calculatePoolRatioFromSqrtPriceX96(
      pool.sqrtPrice,
      token0Decimals,
      token1Decimals,
      isToken0
    );
  }
  
  // Fallback to token0Price/token1Price if available
  if (isToken0) {
    return parseFloat(pool.token1Price || "0");
  } else {
    return parseFloat(pool.token0Price || "0");
  }
}

/**
 * Get GraphQL query for swap data with sqrtPriceX96
 */
function getSwapsWithSqrtPriceQuery() {
  return `
    query GetSwapsWithSqrtPrice($poolId: String!, $startTime: Int!, $endTime: Int!, $first: Int!, $skip: Int!) {
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
        sqrtPriceX96
        tick
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
  const startTime = lastSwapTimestamp + 1;
  return { startTime, endTime };
}

/**
 * Calculate resume time range from partial fetch
 */
function getResumeTimeRange(lastFetchedTimestamp: number): { startTime: number; endTime: number } {
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = lastFetchedTimestamp + 1;
  return { startTime, endTime };
}

/**
 * Fetch swaps with pagination, error handling, and partial persistence
 * Uses skip-based pagination until limit (5000), then switches to timestamp-based
 */
async function fetchSwapsWithPartialPersistence(
  poolId: string,
  startTime: number,
  endTime: number,
  cacheKey: string,
  existingData: StoredSwapData | null,
  scalingFactor: number,
  tokenAddress: string,
  isToken0: boolean,
  maxSwaps: number = 50000
): Promise<SwapDataWithSqrt[]> {
  const allSwaps: SwapDataWithSqrt[] = [];
  let hasMore = true;
  let skip = 0;
  const batchSize = 1000;
  const maxSkip = 5000; // The Graph's skip limit
  let batchNumber = 0;
  let lastProcessedTimestamp = startTime;
  let currentStartTime = startTime;
  let useTimestampPagination = false;

  // Initialize or resume from existing progress
  let partialData: StoredSwapData = existingData ? {
    ...existingData,
    // Ensure fetchProgress exists and has safe defaults
    metadata: {
      ...existingData.metadata,
      fetchProgress: existingData.metadata.fetchProgress || {
        lastFetchedTimestamp: startTime,
        totalBatches: Math.ceil(maxSwaps / batchSize),
        completedBatches: 0,
        isComplete: false,
        failedRanges: [],
        lastBatchSize: batchSize,
      }
    }
  } : {
    swaps: [],
    metadata: {
      token: {} as any,
      pool: {} as any,
      isToken0,
      quoteToken: {} as any,
      lastUpdate: Math.floor(Date.now() / 1000),
      lastSwapTimestamp: startTime * 1000,
      dataRange: { start: startTime * 1000, end: endTime * 1000 },
      chain: "katana",
      dexId: "katana-sushiswap",
      fetchProgress: {
        lastFetchedTimestamp: startTime,
        totalBatches: Math.ceil(maxSwaps / batchSize),
        completedBatches: 0,
        isComplete: false,
        failedRanges: [],
        lastBatchSize: batchSize,
      },
    },
  };

  console.log(`[Katana SqrtPrice] Starting fetch with partial persistence for pool ${poolId} from ${startTime} to ${endTime}`);
  
  if (existingData?.metadata.fetchProgress) {
    console.log(`[Katana SqrtPrice] Resuming from previous progress:`, existingData.metadata.fetchProgress);
    // If resuming, we should already be in timestamp mode if we had previous failures
    if (existingData.metadata.fetchProgress.lastFetchedTimestamp > startTime) {
      useTimestampPagination = true;
      currentStartTime = existingData.metadata.fetchProgress.lastFetchedTimestamp + 1;
      skip = 0;
      console.log(`[Katana SqrtPrice] Resuming with timestamp pagination from ${currentStartTime}`);
    }
  } else if (existingData) {
    console.log(`[Katana SqrtPrice] Existing data found but no fetchProgress, initializing...`);
  }

  while (hasMore && allSwaps.length < maxSwaps) {
    // Check if we need to switch to timestamp-based pagination
    if (!useTimestampPagination && skip >= maxSkip) {
      console.log(`[Katana SqrtPrice] Switching to timestamp-based pagination at skip ${skip}`);
      useTimestampPagination = true;
      skip = 0;
      // Use the timestamp from the last processed swap + 1 second to avoid duplicates
      currentStartTime = lastProcessedTimestamp + 1;
    }

    const swapsQuery = getSwapsWithSqrtPriceQuery();
    const variables = {
      poolId,
      startTime: currentStartTime, // Use current start time (updated for timestamp pagination)
      endTime,
      first: Math.min(batchSize, maxSwaps - allSwaps.length),
      skip: useTimestampPagination ? 0 : skip, // Always 0 for timestamp pagination
    };

    console.log(`[Katana SqrtPrice] Batch ${batchNumber + 1}: ${useTimestampPagination ? 'timestamp' : 'skip'} mode, startTime=${currentStartTime}, skip=${variables.skip}, requesting=${variables.first}`);

    try {
      const response = await axios.post<SushiGraphResponse>(
        KATANA_SUBGRAPH_URL,
        { query: swapsQuery, variables },
        {
          timeout: 50000,
          headers: { "Content-Type": "application/json" },
        }
      );

      // Check if response is valid
      if (!response || !response.data || !response.data.data) {
        throw new Error(`Invalid response structure: ${JSON.stringify(response?.data)}`);
      }

      const swaps = response.data.data.swaps;

      if (!swaps || swaps.length === 0) {
        console.log(`[Katana SqrtPrice] No more swaps found in batch ${batchNumber + 1}`);
        hasMore = false;
        break;
      }

      // Filter out duplicates based on swap ID (extra safety)
      const newSwaps = swaps.filter(swap => 
        !allSwaps.some(existing => existing.id === swap.id)
      );

      if (newSwaps.length === 0) {
        console.log(`[Katana SqrtPrice] No new swaps in batch ${batchNumber + 1}, all were duplicates`);
        if (useTimestampPagination) {
          // If we're in timestamp mode and getting no new swaps, we might be done
          hasMore = false;
          break;
        }
      }

      allSwaps.push(...newSwaps);
      
      // Update last processed timestamp from the newest swap in this batch
      if (newSwaps.length > 0) {
        const sortedSwaps = newSwaps.sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp));
        const newestSwap = sortedSwaps[sortedSwaps.length - 1];
        lastProcessedTimestamp = parseInt(newestSwap.timestamp);
        
        console.log(`[Katana SqrtPrice] Updated lastProcessedTimestamp to ${lastProcessedTimestamp} from swap ${newestSwap.id}`);
      }
      
      batchNumber++;

      // Save progress every N batches or if this might be the last batch
      if (batchNumber % SAVE_PROGRESS_EVERY_N_BATCHES === 0 || swaps.length < variables.first) {
        // Process accumulated swaps
        const processedSwaps = processSwapsWithHybridScaling(
          allSwaps,
          tokenAddress,
          isToken0,
          scalingFactor
        );

        // Merge with existing swaps (remove duplicates by ID)
        const mergedSwaps = mergeSwaps(partialData.swaps, processedSwaps);
        partialData.swaps = mergedSwaps;

        // Update metadata
        if (mergedSwaps.length > 0) {
          partialData.metadata.lastSwapTimestamp = Math.max(...mergedSwaps.map(s => s.timestamp));
          partialData.metadata.dataRange.end = partialData.metadata.lastSwapTimestamp;
        }

        // Save partial progress
        const isComplete = swaps.length < variables.first; // Last batch if we got fewer than requested
        await savePartialProgress(cacheKey, partialData, batchNumber, lastProcessedTimestamp, isComplete);
        
        // Clear accumulated swaps since they're now saved
        allSwaps.length = 0;
      }
      
      if (swaps.length < variables.first) {
        hasMore = false;
      } else {
        if (useTimestampPagination) {
          // For timestamp pagination, move the start time forward
          // Use lastProcessedTimestamp + 1 to avoid getting the same swap again
          currentStartTime = lastProcessedTimestamp + 1;
          skip = 0; // Always keep skip at 0 for timestamp mode
        } else {
          // For skip pagination, increment skip
          skip += batchSize;
        }
      }

      // Rate limiting delay
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (error: any) {
      console.error(`[Katana SqrtPrice] Error in batch ${batchNumber + 1}:`, error.message);
      
      // Record failed range
      const failedRange = {
        start: currentStartTime,
        end: Math.min(currentStartTime + (batchSize * 60), endTime), // Estimate end time based on typical swap frequency
        error: error.message,
      };
      
      partialData.metadata.fetchProgress.failedRanges.push(failedRange);
      
      // Save progress with error info
      await savePartialProgress(cacheKey, partialData, batchNumber, lastProcessedTimestamp, false);
      
      // If we've had too many failures, break
      if (partialData.metadata.fetchProgress.failedRanges.length >= 5) {
        console.error(`[Katana SqrtPrice] Too many batch failures, stopping fetch`);
        break;
      }
      
      // Handle skip limit errors by switching to timestamp pagination
      if (error.message.includes('skip') && error.message.includes('5000') && !useTimestampPagination) {
        console.log(`[Katana SqrtPrice] Skip limit reached, switching to timestamp pagination`);
        useTimestampPagination = true;
        currentStartTime = lastProcessedTimestamp + 1;
        skip = 0;
      } else if (useTimestampPagination) {
        // For timestamp pagination errors, advance time to skip problematic period
        currentStartTime = lastProcessedTimestamp + 3600; // Skip ahead 1 hour
        skip = 0;
      } else {
        // For skip pagination, just increment skip
        skip += batchSize;
      }
      
      batchNumber++;
      
      // Longer delay after error
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // Final save if there are remaining swaps
  if (allSwaps.length > 0) {
    const processedSwaps = processSwapsWithHybridScaling(
      allSwaps,
      tokenAddress,
      isToken0,
      scalingFactor
    );

    const mergedSwaps = mergeSwaps(partialData.swaps, processedSwaps);
    partialData.swaps = mergedSwaps;

    if (mergedSwaps.length > 0) {
      partialData.metadata.lastSwapTimestamp = Math.max(...mergedSwaps.map(s => s.timestamp));
      partialData.metadata.dataRange.end = partialData.metadata.lastSwapTimestamp;
    }

    await savePartialProgress(cacheKey, partialData, batchNumber, lastProcessedTimestamp, true);
  }

  console.log(`[Katana SqrtPrice] Fetch completed: ${batchNumber} batches processed, ${partialData.swaps.length} total swaps saved`);
  
  // Return empty array since all data is saved in partialData
  return [];
}

/**
 * Process swaps with hybrid scaling approach
 */
function processSwapsWithHybridScaling(
  rawSwaps: SwapDataWithSqrt[], 
  tokenAddress: string, 
  isToken0: boolean,
  scalingFactor: number
): ProcessedSwap[] {
  return rawSwaps
    .filter(swap => swap.sqrtPriceX96 && swap.sqrtPriceX96 !== "0")
    .map(swap => {
      const token0Decimals = parseInt(swap.token0.decimals);
      const token1Decimals = parseInt(swap.token1.decimals);
      
      // Calculate raw pool ratio
      const rawPoolPrice = calculatePoolRatioFromSqrtPriceX96(
        swap.sqrtPriceX96,
        token0Decimals,
        token1Decimals,
        isToken0
      );

      // Apply scaling factor to get USD price
      const scaledUSDPrice = rawPoolPrice * scalingFactor;

      return {
        id: swap.id,
        timestamp: parseInt(swap.timestamp) * 1000,
        poolPrice: scaledUSDPrice, // Scaled USD price
        rawPoolPrice: rawPoolPrice, // Original pool ratio
        tokenVolumeUSD: isToken0
          ? Math.abs(parseFloat(swap.amount0USD || "0"))
          : Math.abs(parseFloat(swap.amount1USD || "0")),
        totalVolumeUSD: parseFloat(swap.amountUSD || "0"),
        sqrtPriceX96: swap.sqrtPriceX96,
        tick: parseInt(swap.tick || "0"),
      };
    })
    .filter(swap => swap.poolPrice > 0); // Filter out invalid prices
}

/**
 * Scale existing swaps with new scaling factor
 */
function rescaleExistingSwaps(swaps: ProcessedSwap[], newScalingFactor: number): ProcessedSwap[] {
  return swaps.map(swap => ({
    ...swap,
    poolPrice: swap.rawPoolPrice * newScalingFactor, // Recalculate USD price with new factor
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
 * Get swap data with hybrid sqrtPrice + Sushi API pricing
 */
export async function getKatanaSqrtPriceData(
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
    let { tokenAddress, days = "365", force } = req.query;

    console.log(`[Katana SqrtPrice] Request received:`, { tokenAddress, days, force });

    // Parse force parameter properly
    const shouldForce = force === 'true' || force === '1' || force === 'yes';

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
    const cacheKey = `${SQRT_PRICE_DATA_PREFIX}${normalizedAddress}`;
    const lockKey = `${UPDATE_LOCK_PREFIX}${normalizedAddress}`;

    console.log(`[Katana SqrtPrice] Cache key: ${cacheKey}, Force: ${shouldForce}`);

    await sushiLimiter.schedule(async () => {
      try {
        // Step 1: Try to load existing data
        let storedData: StoredSwapData | null = null;
        try {
          const cached = await getValue(cacheKey);
          if (cached) {
            storedData = JSON.parse(cached);
            console.log(`[Katana SqrtPrice] Found existing data:`, {
              swapsCount: storedData?.swaps.length,
              lastUpdate: storedData?.metadata.lastUpdate,
              lastSwapTimestamp: storedData?.metadata.lastSwapTimestamp,
              fetchProgress: storedData?.metadata.fetchProgress,
            });
          }
        } catch (cacheError) {
          console.warn(`[Katana SqrtPrice] Cache read error:`, cacheError);
        }

        // Step 2: Fetch current Sushi API price
        const currentSushiPrice = await fetchSushiPrice(normalizedAddress);
        console.log(`[Katana SqrtPrice] Current Sushi API price: ${currentSushiPrice}`);

        // Step 3: Check if we have incomplete fetch
        const hasIncompleteData = storedData && 
          storedData.metadata.fetchProgress && 
          !storedData.metadata.fetchProgress.isComplete;

        // Step 4: Determine if we need to update
        const shouldUpdate = shouldForce || 
          !storedData || 
          hasIncompleteData ||
          needsUpdate(storedData.metadata.lastUpdate);
        
        if (!shouldUpdate && storedData && currentSushiPrice) {
          console.log(`[Katana SqrtPrice] Data is fresh, but checking if rescaling needed`);
          
          // Ensure fetchProgress exists for response
          if (!storedData.metadata.fetchProgress) {
            storedData.metadata.fetchProgress = {
              lastFetchedTimestamp: Math.floor(storedData.metadata.lastSwapTimestamp / 1000),
              totalBatches: 0,
              completedBatches: 0,
              isComplete: true,
              failedRanges: [],
              lastBatchSize: 1000,
            };
          }
          
          // Check if we need to rescale due to price change
          const priceDifference = Math.abs(currentSushiPrice - storedData.metadata.pool.currentSushiPrice);
          const priceChangePercentage = (priceDifference / storedData.metadata.pool.currentSushiPrice) * 100;
          
          console.log(`[Katana SqrtPrice] Price change: ${priceChangePercentage.toFixed(2)}%`);
          
          if (priceChangePercentage > 5) { // Rescale if price changed more than 5%
            console.log(`[Katana SqrtPrice] Rescaling due to significant price change`);
            
            // Calculate new scaling factor
            const currentPoolRatio = calculateCurrentPoolRatio(
              storedData.metadata.pool as any, 
              storedData.metadata.isToken0
            );
            const newScalingFactor = currentSushiPrice / currentPoolRatio;
            
            // Rescale existing data
            const rescaledSwaps = rescaleExistingSwaps(storedData.swaps, newScalingFactor);
            
            // Update stored data with new scaling
            storedData.swaps = rescaledSwaps;
            storedData.metadata.pool.currentSushiPrice = currentSushiPrice;
            storedData.metadata.pool.scalingFactor = newScalingFactor;
            
            // Save rescaled data
            await storeValue(cacheKey, JSON.stringify(storedData), SQRT_PRICE_DATA_TTL);
            console.log(`[Katana SqrtPrice] Data rescaled and saved`);
          }
          
          // Filter data to requested time range
          const requestedStartTime = Math.floor(Date.now() / 1000) - (daysNum * 24 * 60 * 60);
          const filteredSwaps = storedData.swaps.filter(
            swap => swap.timestamp >= requestedStartTime * 1000
          );

          const responseData = {
            swaps: filteredSwaps,
            metadata: {
              ...storedData.metadata,
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
            source: "katana-sqrtprice",
            cached: true,
            tokenAddress: normalizedAddress,
            count: filteredSwaps.length,
            poolId: storedData.metadata.pool.id,
            poolTVL: storedData.metadata.pool.totalValueLockedUSD.toString(),
            currentPoolPrice: currentSushiPrice,
            scalingFactor: storedData.metadata.pool.scalingFactor,
            chain: "katana",
            updateStatus: priceChangePercentage > 5 ? "rescaled" : "fresh",
            fetchProgress: storedData.metadata.fetchProgress,
          });
          return;
        }

        if (!currentSushiPrice) {
          res.status(503).json({
            status: "error",
            msg: "Unable to fetch current token price from Sushi API",
            tokenAddress: normalizedAddress,
          });
          return;
        }

        // Step 5: Check update lock (but allow resuming incomplete fetches)
        if (!hasIncompleteData) {
          try {
            const lockExists = await getValue(lockKey);
            if (lockExists && !shouldForce) {
              console.log(`[Katana SqrtPrice] Update in progress, returning stale data`);
              
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
                  fetchProgress: storedData.metadata.fetchProgress,
                });
                return;
              }
            }
          } catch (lockError) {
            console.warn(`[Katana SqrtPrice] Lock check error:`, lockError);
          }
        }

        // Step 6: Set update lock
        try {
          await storeValue(lockKey, "updating", UPDATE_LOCK_TTL);
        } catch (lockError) {
          console.warn(`[Katana SqrtPrice] Failed to set update lock:`, lockError);
        }

        console.log(`[Katana SqrtPrice] ${hasIncompleteData ? 'Resuming incomplete' : 'Starting new'} data fetch for token: ${normalizedAddress}`);

        // Step 7: Find highest TVL pool (any pair)
        let selectedPool: Pool;
        
        if (storedData?.metadata.pool) {
          // Refresh pool data
          const poolsQuery = getPoolsByTVLQuery();
          const poolsVariables = { tokenAddress: normalizedAddress };

          const poolsResponse = await axios.post<SushiGraphResponse>(
            KATANA_SUBGRAPH_URL,
            { query: poolsQuery, variables: poolsVariables },
            {
              timeout: 25000,
              headers: { "Content-Type": "application/json" },
            }
          );

          if (poolsResponse.data.data.pools && poolsResponse.data.data.pools.length > 0) {
            selectedPool = poolsResponse.data.data.pools.find(p => 
              p.id === storedData!.metadata.pool.id
            ) || poolsResponse.data.data.pools[0];
          } else {
            throw new Error("No pools found for this token");
          }
          
          console.log(`[Katana SqrtPrice] Refreshed pool data: ${selectedPool.id}`);
        } else {
          // Find highest TVL pool
          const poolsQuery = getPoolsByTVLQuery();
          const poolsVariables = { tokenAddress: normalizedAddress };

          const poolsResponse = await axios.post<SushiGraphResponse>(
            KATANA_SUBGRAPH_URL,
            { query: poolsQuery, variables: poolsVariables },
            {
              timeout: 25000,
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
          console.log(`[Katana SqrtPrice] Found highest TVL pool:`, {
            poolId: selectedPool.id,
            tvl: selectedPool.totalValueLockedUSD,
            token0: selectedPool.token0.symbol,
            token1: selectedPool.token1.symbol,
          });
        }

        // Determine token position in pool
        const isToken0 = selectedPool.token0.id.toLowerCase() === normalizedAddress;
        const baseToken = isToken0 ? selectedPool.token0 : selectedPool.token1;
        const quoteToken = isToken0 ? selectedPool.token1 : selectedPool.token0;

        // Calculate current pool ratio and scaling factor
        const currentPoolRatio = calculateCurrentPoolRatio(selectedPool, isToken0);
        const scalingFactor = currentSushiPrice / currentPoolRatio;
        
        console.log(`[Katana SqrtPrice] Scaling calculation:`, {
          currentSushiPrice,
          currentPoolRatio,
          scalingFactor,
        });

        // Step 8: Determine fetch strategy based on existing data
        let fetchStartTime: number;
        let fetchEndTime: number;
        
        if (hasIncompleteData) {
          // Resume from where we left off
          const resumeRange = getResumeTimeRange(storedData!.metadata.fetchProgress.lastFetchedTimestamp);
          fetchStartTime = resumeRange.startTime;
          fetchEndTime = resumeRange.endTime;
          console.log(`[Katana SqrtPrice] Resuming incomplete fetch from ${fetchStartTime} to ${fetchEndTime}`);
        } else if (storedData && storedData.metadata.lastSwapTimestamp) {
          // Incremental update from last successful fetch
          const incrementalRange = getIncrementalTimeRange(
            Math.floor(storedData.metadata.lastSwapTimestamp / 1000)
          );
          fetchStartTime = incrementalRange.startTime;
          fetchEndTime = incrementalRange.endTime;
          console.log(`[Katana SqrtPrice] Incremental fetch from ${fetchStartTime} to ${fetchEndTime}`);
        } else {
          // Full fetch for new token
          const fullRange = getFullTimeRange();
          fetchStartTime = fullRange.startTime;
          fetchEndTime = fullRange.endTime;
          console.log(`[Katana SqrtPrice] Full fetch from ${fetchStartTime} to ${fetchEndTime}`);
        }

        // Step 9: Fetch data with partial persistence
        await fetchSwapsWithPartialPersistence(
          selectedPool.id,
          fetchStartTime,
          fetchEndTime,
          cacheKey,
          storedData,
          scalingFactor,
          normalizedAddress,
          isToken0
        );

        // Step 10: Load the final saved data
        let finalStoredData: StoredSwapData | null = null;
        try {
          const finalCached = await getValue(cacheKey);
          if (finalCached) {
            finalStoredData = JSON.parse(finalCached);
          }
        } catch (error) {
          console.error(`[Katana SqrtPrice] Failed to load final data:`, error);
        }

        if (!finalStoredData) {
          res.status(500).json({
            status: "error",
            msg: "Failed to save or retrieve processed data",
            tokenAddress: normalizedAddress,
          });
          return;
        }

        // Step 11: Update final metadata
        const now = Math.floor(Date.now() / 1000);
        finalStoredData.metadata.token = {
          address: baseToken.id,
          name: baseToken.name,
          symbol: baseToken.symbol,
          decimals: baseToken.decimals,
        };
        finalStoredData.metadata.pool = {
          id: selectedPool.id,
          address: selectedPool.id,
          token0: selectedPool.token0,
          token1: selectedPool.token1,
          feeTier: selectedPool.feeTier,
          totalValueLockedUSD: parseFloat(selectedPool.totalValueLockedUSD),
          volumeUSD: parseFloat(selectedPool.volumeUSD),
          currentPoolPrice: currentPoolRatio,
          currentSushiPrice: currentSushiPrice,
          scalingFactor: scalingFactor,
        };
        finalStoredData.metadata.isToken0 = isToken0;
        finalStoredData.metadata.quoteToken = quoteToken;
        finalStoredData.metadata.lastUpdate = now;
        
        // Update data range based on actual data
        if (finalStoredData.swaps.length > 0) {
          finalStoredData.metadata.dataRange.start = Math.min(...finalStoredData.swaps.map(s => s.timestamp));
          finalStoredData.metadata.dataRange.end = Math.max(...finalStoredData.swaps.map(s => s.timestamp));
          finalStoredData.metadata.lastSwapTimestamp = finalStoredData.metadata.dataRange.end;
        }

        // Ensure fetchProgress exists before accessing it
        if (!finalStoredData.metadata.fetchProgress) {
          finalStoredData.metadata.fetchProgress = {
            lastFetchedTimestamp: Math.floor(finalStoredData.metadata.lastSwapTimestamp / 1000),
            totalBatches: 0,
            completedBatches: 0,
            isComplete: true,
            failedRanges: [],
            lastBatchSize: 1000,
          };
        }

        // Step 12: Save final updated metadata
        try {
          await storeValue(cacheKey, JSON.stringify(finalStoredData), SQRT_PRICE_DATA_TTL);
          console.log(`[Katana SqrtPrice] Final data saved with ${finalStoredData.swaps.length} total swaps`);
        } catch (saveError) {
          console.error(`[Katana SqrtPrice] Failed to save final data:`, saveError);
        }

        // Step 13: Filter data for response
        const requestedStartTime = Math.floor(Date.now() / 1000) - (daysNum * 24 * 60 * 60);
        const filteredSwaps = finalStoredData.swaps.filter(
          swap => swap.timestamp >= requestedStartTime * 1000
        );

        const responseData = {
          swaps: filteredSwaps,
          metadata: {
            ...finalStoredData.metadata,
            totalSwaps: filteredSwaps.length,
            timeRange: {
              start: requestedStartTime * 1000,
              end: Date.now(),
              days: daysNum,
            },
          },
        };

        console.log(`[Katana SqrtPrice] Sending response with ${filteredSwaps.length} swaps`);

        res.status(200).json({
          status: "success",
          data: responseData,
          source: "katana-sqrtprice",
          cached: false,
          tokenAddress: normalizedAddress,
          count: filteredSwaps.length,
          poolId: selectedPool.id,
          poolTVL: selectedPool.totalValueLockedUSD,
          currentPoolPrice: currentSushiPrice,
          scalingFactor: scalingFactor,
          chain: "katana",
          updateStatus: hasIncompleteData ? "resumed" : "updated",
          fetchProgress: finalStoredData.metadata.fetchProgress,
          stats: {
            totalSwapsStored: finalStoredData.swaps.length,
            validPriceSwaps: finalStoredData.swaps.filter(s => s.poolPrice > 0).length,
            sushiApiPrice: currentSushiPrice,
            poolRatio: currentPoolRatio,
            completedBatches: finalStoredData.metadata.fetchProgress.completedBatches,
            failedRanges: finalStoredData.metadata.fetchProgress.failedRanges.length,
          },
        });

      } catch (apiError: any) {
        console.error(`[Katana SqrtPrice] API error:`, {
          message: apiError.message,
          status: apiError.response?.status,
          data: apiError.response?.data,
        });

        res.status(500).json({
          status: "error",
          msg: "Failed to fetch or update sqrt price data",
          debug: {
            error: apiError.message,
            status: apiError.response?.status,
          },
        });
      }
    });

  } catch (error: any) {
    console.error("[Katana SqrtPrice] Controller error:", error);
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
 * Clear cache for sqrt price data
 */
export async function clearKatanaSqrtPriceCache(
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
    const cacheKey = `${SQRT_PRICE_DATA_PREFIX}${normalizedAddress}`;
    
    console.log(`[Katana SqrtPrice] Clearing cache for: ${normalizedAddress}`);

    res.status(200).json({
      status: "success",
      msg: "SqrtPrice cache cleared successfully",
      tokenAddress: normalizedAddress,
      chain: "katana",
    });
  } catch (error) {
    console.error("[Katana SqrtPrice] Clear cache error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
    });
  }
}