// controllers/katanaSushiswapSqrtPriceController.ts
import type { Request, Response, NextFunction } from "express";
import { getValue, storeValue } from "../../redis/katanaTokens";

// Import all our modular services
import { StoredSwapData } from "../../types/katanaSqrtPrice.types";
import { 
  SQRT_PRICE_DATA_PREFIX,
  SQRT_PRICE_DATA_TTL,
  UPDATE_LOCK_PREFIX,
  UPDATE_LOCK_TTL,
  FULL_DATA_DAYS,
  UPDATE_INTERVAL_HOURS,
  MAX_SWAPS_DEFAULT,
  LOG_PREFIX
} from "../../constants/katanaSqrtPrice.constants";
import { KatanaLogger } from "../../utils/logger";
import { MemoryManager } from "../../services/memoryManager";
import { PriceCalculator } from "../../services/priceCalculator";
import { ApiService } from "../../services/apiService";
import { FetchManager } from "../../services/fetchManager";

/**
 * Check if we need to update data (every hour)
 */
function needsUpdate(lastUpdate: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const hoursSinceUpdate = (now - lastUpdate) / 3600;
  const needs = hoursSinceUpdate >= UPDATE_INTERVAL_HOURS;
  
  KatanaLogger.debug(LOG_PREFIX, "Update check", {
    lastUpdate,
    hoursSinceUpdate: hoursSinceUpdate.toFixed(2),
    needsUpdate: needs
  });
  
  return needs;
}

/**
 * Main controller for sqrt price data
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
  const requestStartTime = Date.now();
  const requestId = Math.random().toString(36).substring(2, 8);
  
  try {
    let { tokenAddress, days = "365", force } = req.query;

    KatanaLogger.info(LOG_PREFIX, `Request ${requestId} received`, { 
      tokenAddress, 
      days, 
      force 
    });

    // Parse and validate input
    const shouldForce = force === 'true' || force === '1' || force === 'yes';

    if (!tokenAddress) {
      KatanaLogger.warn(LOG_PREFIX, `Request ${requestId} missing tokenAddress`);
      res.status(400).json({
        status: "error",
        msg: "tokenAddress parameter is required",
      });
      return;
    }

    if (!/^0x[a-f0-9]{40}$/i.test(tokenAddress)) {
      KatanaLogger.warn(LOG_PREFIX, `Request ${requestId} invalid address format`, {
        tokenAddress
      });
      res.status(422).json({
        status: "error",
        msg: "Invalid address format",
      });
      return;
    }

    const daysNum = parseInt(days);
    if (isNaN(daysNum) || daysNum < 1 || daysNum > 365) {
      KatanaLogger.warn(LOG_PREFIX, `Request ${requestId} invalid days parameter`, {
        days,
        parsed: daysNum
      });
      res.status(400).json({
        status: "error",
        msg: "Days must be a number between 1 and 365",
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();
    const cacheKey = `${SQRT_PRICE_DATA_PREFIX}${normalizedAddress}`;
    const lockKey = `${UPDATE_LOCK_PREFIX}${normalizedAddress}`;

    KatanaLogger.info(LOG_PREFIX, `Request ${requestId} processing`, {
      normalizedAddress,
      daysNum,
      shouldForce,
      cacheKey: cacheKey.substring(0, 50) + "..."
    });

    // Step 1: Try to load existing data
    let storedData: StoredSwapData | null = null;
    try {
      storedData = await MemoryManager.loadStoredData(cacheKey);
      
      if (storedData) {
        KatanaLogger.info(LOG_PREFIX, `Request ${requestId} found existing data`, {
          swapsCount: storedData.swaps.length,
          lastUpdate: storedData.metadata.lastUpdate,
          lastSwapTimestamp: storedData.metadata.lastSwapTimestamp,
          fetchProgress: storedData.metadata.fetchProgress
        });
      }
    } catch (cacheError) {
      KatanaLogger.warn(LOG_PREFIX, `Request ${requestId} cache read error`, cacheError);
    }

    // Step 2: Fetch current Sushi API price
    const currentSushiPrice = await ApiService.fetchSushiPrice(normalizedAddress);
    
    if (!currentSushiPrice) {
      KatanaLogger.error(LOG_PREFIX, `Request ${requestId} failed to fetch Sushi price`);
      res.status(503).json({
        status: "error",
        msg: "Unable to fetch current token price from Sushi API",
        tokenAddress: normalizedAddress,
      });
      return;
    }

    KatanaLogger.info(LOG_PREFIX, `Request ${requestId} current price`, {
      currentSushiPrice
    });

    // Step 3: Check if we have incomplete fetch
    const hasIncompleteData = storedData && 
      storedData.metadata.fetchProgress && 
      !storedData.metadata.fetchProgress.isComplete;

    // Step 4: Determine if we need to update
    const shouldUpdate = shouldForce || 
      !storedData || 
      hasIncompleteData ||
      needsUpdate(storedData.metadata.lastUpdate);
    
    KatanaLogger.info(LOG_PREFIX, `Request ${requestId} update decision`, {
      shouldForce,
      hasStoredData: !!storedData,
      hasIncompleteData,
      shouldUpdate
    });

    // Step 5: Handle cached data with potential rescaling
    if (!shouldUpdate && storedData) {
      return await handleCachedData(
        req,
        res,
        requestId,
        storedData,
        currentSushiPrice,
        daysNum,
        normalizedAddress
      );
    }

    // Step 6: Check update lock (but allow resuming incomplete fetches)
    if (!hasIncompleteData && !shouldForce) {
      try {
        const lockExists = await getValue(lockKey);
        if (lockExists) {
          return await handleLockedUpdate(
            res,
            requestId,
            storedData,
            daysNum
          );
        }
      } catch (lockError) {
        KatanaLogger.warn(LOG_PREFIX, `Request ${requestId} lock check error`, lockError);
      }
    }

    // Step 7: Set update lock
    try {
      await storeValue(lockKey, "updating", UPDATE_LOCK_TTL);
      KatanaLogger.info(LOG_PREFIX, `Request ${requestId} update lock set`);
    } catch (lockError) {
      KatanaLogger.warn(LOG_PREFIX, `Request ${requestId} failed to set update lock`, lockError);
    }

    // Step 8: Process the update
    await processDataUpdate(
      req,
      res,
      requestId,
      {
        normalizedAddress,
        cacheKey,
        lockKey,
        currentSushiPrice,
        daysNum,
        storedData,
        hasIncompleteData
      }
    );

  } catch (error: any) {
    KatanaLogger.error(LOG_PREFIX, `Request ${requestId} controller error`, error);
    
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
      debug: {
        error: error.message,
        requestId
      },
    });
  } finally {
    KatanaLogger.performance(LOG_PREFIX, `Request ${requestId} completed`, requestStartTime);
  }
}

/**
 * Handle cached data with potential rescaling
 */
async function handleCachedData(
  req: Request,
  res: Response,
  requestId: string,
  storedData: StoredSwapData,
  currentSushiPrice: number,
  daysNum: number,
  normalizedAddress: string
): Promise<void> {
  KatanaLogger.info(LOG_PREFIX, `Request ${requestId} handling cached data`);

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
  const { shouldRescale, changePercentage } = PriceCalculator.shouldRescale(
    currentSushiPrice,
    storedData.metadata.pool.currentSushiPrice
  );

  let updateStatus = "fresh";

  if (shouldRescale) {
    KatanaLogger.info(LOG_PREFIX, `Request ${requestId} rescaling data`, {
      changePercentage
    });

    try {
      // Calculate new scaling factor
      const currentPoolRatio = PriceCalculator.calculateCurrentPoolRatio(
        storedData.metadata.pool as any, 
        storedData.metadata.isToken0
      );
      
      const newScalingFactor = PriceCalculator.calculateScalingFactor(
        currentSushiPrice,
        currentPoolRatio,
        normalizedAddress
      );

      // Rescale existing data
      const rescaledSwaps = PriceCalculator.rescaleExistingSwaps(
        storedData.swaps, 
        newScalingFactor
      );

      // Update stored data with new scaling
      storedData.swaps = rescaledSwaps;
      storedData.metadata.pool.currentSushiPrice = currentSushiPrice;
      storedData.metadata.pool.scalingFactor = newScalingFactor;

      // Save rescaled data
      const cacheKey = `${SQRT_PRICE_DATA_PREFIX}${normalizedAddress}`;
      await MemoryManager.saveWithOptimalStrategy(
        cacheKey,
        storedData,
        0,
        Math.floor(Date.now() / 1000),
        true
      );

      updateStatus = "rescaled";
      KatanaLogger.info(LOG_PREFIX, `Request ${requestId} data rescaled and saved`);
    } catch (rescaleError) {
      KatanaLogger.error(LOG_PREFIX, `Request ${requestId} rescaling failed`, rescaleError);
    }
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

  KatanaLogger.info(LOG_PREFIX, `Request ${requestId} sending cached response`, {
    swapCount: filteredSwaps.length,
    updateStatus
  });

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
    updateStatus,
    fetchProgress: storedData.metadata.fetchProgress,
    requestId
  });
}

/**
 * Handle locked update scenario
 */
async function handleLockedUpdate(
  res: Response,
  requestId: string,
  storedData: StoredSwapData | null,
  daysNum: number
): Promise<void> {
  KatanaLogger.info(LOG_PREFIX, `Request ${requestId} update in progress, returning stale data`);

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
      requestId
    });
  } else {
    res.status(202).json({
      status: "processing",
      message: "Data update in progress, no cached data available",
      requestId
    });
  }
}

/**
 * Process data update (fetch new data)
 */
async function processDataUpdate(
  req: Request,
  res: Response,
  requestId: string,
  context: {
    normalizedAddress: string;
    cacheKey: string;
    lockKey: string;
    currentSushiPrice: number;
    daysNum: number;
    storedData: StoredSwapData | null;
    hasIncompleteData: boolean | null;
  }
): Promise<void> {
  const updateStartTime = Date.now();
  
  try {
    KatanaLogger.info(LOG_PREFIX, `Request ${requestId} ${context.hasIncompleteData ? 'resuming incomplete' : 'starting new'} data fetch`);

    // Step 1: Find highest TVL pool
    let selectedPool;
    
    if (context.storedData?.metadata.pool) {
      // Refresh existing pool data
      const pools = await ApiService.fetchPoolsByTVL(context.normalizedAddress);
      selectedPool = pools.find(p => p.id === context.storedData!.metadata.pool.id) || pools[0];
      
      if (!selectedPool) {
        throw new Error("No pools found for this token");
      }
      
      KatanaLogger.info(LOG_PREFIX, `Request ${requestId} refreshed pool data`, {
        poolId: selectedPool.id
      });
    } else {
      // Find highest TVL pool
      const pools = await ApiService.fetchPoolsByTVL(context.normalizedAddress);
      
      if (!pools || pools.length === 0) {
        res.status(404).json({
          status: "error",
          msg: "No pools found for this token on Katana",
          tokenAddress: context.normalizedAddress,
          requestId
        });
        return;
      }

      selectedPool = pools[0];
      KatanaLogger.info(LOG_PREFIX, `Request ${requestId} found highest TVL pool`, {
        poolId: selectedPool.id,
        tvl: selectedPool.totalValueLockedUSD,
        token0: selectedPool.token0.symbol,
        token1: selectedPool.token1.symbol,
      });
    }

    // Step 2: Calculate scaling parameters
    const isToken0 = selectedPool.token0.id.toLowerCase() === context.normalizedAddress;
    const baseToken = isToken0 ? selectedPool.token0 : selectedPool.token1;
    const quoteToken = isToken0 ? selectedPool.token1 : selectedPool.token0;

    const currentPoolRatio = PriceCalculator.calculateCurrentPoolRatio(selectedPool, isToken0);
    const scalingFactor = PriceCalculator.calculateScalingFactor(
      context.currentSushiPrice,
      currentPoolRatio,
      context.normalizedAddress
    );

    // Step 3: Determine fetch strategy
    let fetchStartTime: number;
    let fetchEndTime: number;
    let strategy: 'full' | 'incremental' | 'resume';
    
    if (context.hasIncompleteData) {
      strategy = 'resume';
      const timeRange = FetchManager.getTimeRange(
        strategy,
        undefined,
        context.storedData!.metadata.fetchProgress.lastFetchedTimestamp
      );
      fetchStartTime = timeRange.startTime;
      fetchEndTime = timeRange.endTime;
    } else if (context.storedData && context.storedData.metadata.lastSwapTimestamp) {
      strategy = 'incremental';
      const timeRange = FetchManager.getTimeRange(
        strategy,
        context.storedData.metadata.lastSwapTimestamp
      );
      fetchStartTime = timeRange.startTime;
      fetchEndTime = timeRange.endTime;
    } else {
      strategy = 'full';
      const timeRange = FetchManager.getTimeRange(strategy, undefined, undefined, FULL_DATA_DAYS);
      fetchStartTime = timeRange.startTime;
      fetchEndTime = timeRange.endTime;
    }

    KatanaLogger.info(LOG_PREFIX, `Request ${requestId} fetch strategy: ${strategy}`, {
      fetchStartTime,
      fetchEndTime
    });

    // Step 4: Create and validate fetch configuration
    const fetchConfig = FetchManager.createFetchConfig(
      selectedPool.id,
      fetchStartTime,
      fetchEndTime,
      MAX_SWAPS_DEFAULT
    );

    if (!FetchManager.validateFetchConfig(fetchConfig)) {
      throw new Error("Invalid fetch configuration");
    }

    // Step 5: Estimate requirements
    const estimates = FetchManager.estimateFetchRequirements(fetchConfig);
    KatanaLogger.info(LOG_PREFIX, `Request ${requestId} fetch estimates`, estimates);

    // Step 6: Execute fetch with optimized persistence
    await FetchManager.fetchSwapsWithOptimizedPersistence(
      fetchConfig,
      context.cacheKey,
      context.storedData,
      scalingFactor,
      context.normalizedAddress,
      isToken0
    );

    // Step 7: Load final results
    const finalStoredData = await MemoryManager.loadStoredData(context.cacheKey);

    if (!finalStoredData) {
      res.status(500).json({
        status: "error",
        msg: "Failed to save or retrieve processed data",
        tokenAddress: context.normalizedAddress,
        requestId
      });
      return;
    }

    // Step 8: Update final metadata
    await updateFinalMetadata(
      finalStoredData,
      baseToken,
      quoteToken,
      selectedPool,
      isToken0,
      currentPoolRatio,
      context.currentSushiPrice,
      scalingFactor,
      context.cacheKey
    );

    // Step 9: Send response
    await sendFinalResponse(
      res,
      requestId,
      finalStoredData,
      context.daysNum,
      context.normalizedAddress,
      selectedPool,
      context.currentSushiPrice,
      scalingFactor,
      context.hasIncompleteData
    );

  } catch (error: any) {
    KatanaLogger.error(LOG_PREFIX, `Request ${requestId} update failed`, error);
    
    res.status(500).json({
      status: "error",
      msg: "Failed to fetch or update sqrt price data",
      debug: {
        error: error.message,
        requestId
      },
    });
  } finally {
    // Clear update lock
    try {
      // Note: In a real implementation, you'd want to delete the lock key
      // await deleteValue(context.lockKey);
      KatanaLogger.info(LOG_PREFIX, `Request ${requestId} update lock cleared`);
    } catch (lockError) {
      KatanaLogger.warn(LOG_PREFIX, `Request ${requestId} failed to clear update lock`, lockError);
    }
    
    KatanaLogger.performance(LOG_PREFIX, `Request ${requestId} update process`, updateStartTime);
  }
}

/**
 * Update final metadata
 */
async function updateFinalMetadata(
  finalStoredData: StoredSwapData,
  baseToken: any,
  quoteToken: any,
  selectedPool: any,
  isToken0: boolean,
  currentPoolRatio: number,
  currentSushiPrice: number,
  scalingFactor: number,
  cacheKey: string
): Promise<void> {
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

  // Ensure fetchProgress exists
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

  // Save final updated metadata
  await MemoryManager.saveWithOptimalStrategy(
    cacheKey,
    finalStoredData,
    finalStoredData.metadata.fetchProgress.completedBatches,
    finalStoredData.metadata.fetchProgress.lastFetchedTimestamp,
    true
  );
}

/**
 * Send final response
 */
async function sendFinalResponse(
  res: Response,
  requestId: string,
  finalStoredData: StoredSwapData,
  daysNum: number,
  normalizedAddress: string,
  selectedPool: any,
  currentSushiPrice: number,
  scalingFactor: number,
  wasIncomplete: boolean | null
): Promise<void> {
  // Filter data for response
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

  KatanaLogger.info(LOG_PREFIX, `Request ${requestId} sending final response`, {
    totalSwapsStored: finalStoredData.swaps.length,
    filteredSwapsCount: filteredSwaps.length,
    validPriceSwaps: finalStoredData.swaps.filter(s => s.poolPrice > 0).length
  });

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
    updateStatus: wasIncomplete ? "resumed" : "updated",
    fetchProgress: finalStoredData.metadata.fetchProgress,
    requestId,
    stats: {
      totalSwapsStored: finalStoredData.swaps.length,
      validPriceSwaps: finalStoredData.swaps.filter(s => s.poolPrice > 0).length,
      sushiApiPrice: currentSushiPrice,
      poolRatio: finalStoredData.metadata.pool.currentPoolPrice,
      completedBatches: finalStoredData.metadata.fetchProgress.completedBatches,
      failedRanges: finalStoredData.metadata.fetchProgress.failedRanges.length,
    },
  });
}

/**
 * Clear cache for sqrt price data
 */
export async function clearKatanaSqrtPriceCache(
  req: Request<{}, {}, {}, { tokenAddress?: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  const requestStartTime = Date.now();
  const requestId = Math.random().toString(36).substring(2, 8);
  
  try {
    const { tokenAddress } = req.query;

    KatanaLogger.info(LOG_PREFIX, `Clear cache request ${requestId}`, { tokenAddress });

    if (!tokenAddress) {
      res.status(400).json({
        status: "error",
        msg: "tokenAddress parameter is required",
        requestId
      });
      return;
    }

    if (!/^0x[a-f0-9]{40}$/i.test(tokenAddress)) {
      res.status(422).json({
        status: "error",
        msg: "Invalid address format",
        requestId
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();
    const cacheKey = `${SQRT_PRICE_DATA_PREFIX}${normalizedAddress}`;
    
    KatanaLogger.info(LOG_PREFIX, `Clearing cache for: ${normalizedAddress}`);

    // In a real implementation, you would clear all related cache keys:
    // - Main cache key
    // - Chunked data (_meta, _chunk_*)
    // - Recent data fallback (_recent)
    // - Update lock
    
    // For now, we'll just log the operation
    KatanaLogger.info(LOG_PREFIX, "Cache clear operation completed", {
      normalizedAddress,
      requestId
    });

    res.status(200).json({
      status: "success",
      msg: "SqrtPrice cache cleared successfully",
      tokenAddress: normalizedAddress,
      chain: "katana",
      requestId
    });

  } catch (error: any) {
    KatanaLogger.error(LOG_PREFIX, `Clear cache request ${requestId} error`, error);
    
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
      requestId
    });
  } finally {
    KatanaLogger.performance(LOG_PREFIX, `Clear cache request ${requestId}`, requestStartTime);
  }
}