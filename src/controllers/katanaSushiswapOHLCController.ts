// src/controllers/katana/katanaSushiswapSwapController.ts
import type { Request, Response, NextFunction } from "express";
import {
  // Constants
  FULL_DATA_DAYS,
  
  // Types
  Pool,
  StoredSwapData,
  
  // Utilities
  fetchPoolsByTVL,
  selectBestPool,
  fetchSwaps,
  processSwaps,
  mergeSwaps,
  getFullTimeRange,
  getIncrementalTimeRange,
  needsUpdate,
  loadSwapDataFromRedis,
  saveSwapDataToRedis,
  checkUpdateLock,
  setUpdateLock,
  clearUpdateLock,
  loadHistoricalSwapsFromMySQL,
  mergeWithHistoricalSwaps,
} from "../utils/katana/index"

/**
 * Get OHLC data for Katana tokens with incremental updates
 * Combines Redis cache + MySQL historical data
 */
export async function getKatanaSwapData(
  req: Request<{}, {}, {}, { tokenAddress?: string; days?: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { tokenAddress, days = "365" } = req.query;

    // Validation
    if (!tokenAddress) {
      res.status(400).json({
        status: "error",
        msg: "tokenAddress parameter is required",
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();
    const daysNum = Math.min(parseInt(days, 10) || 365, FULL_DATA_DAYS);

    console.log(`[Katana Incremental] Processing request:`, {
      tokenAddress: normalizedAddress,
      days: daysNum,
    });

    // Check if update is in progress
    const isLocked = await checkUpdateLock(normalizedAddress);
    if (isLocked) {
      console.log(`[Katana Incremental] Update in progress, returning 429`);
      res.status(429).json({
        status: "error",
        msg: "Update already in progress for this token",
        tokenAddress: normalizedAddress,
      });
      return;
    }

    // Set update lock
    await setUpdateLock(normalizedAddress);

    try {
      // Load cached data
      const storedData = await loadSwapDataFromRedis(normalizedAddress);

      // Determine if we need to fetch new data
      const shouldUpdate = !storedData || 
        needsUpdate(storedData.metadata.lastUpdate);

      let selectedPool: Pool;
      let allSwaps = storedData?.swaps || [];

      if (shouldUpdate) {
        console.log(`[Katana Incremental] Fetching new data from subgraph`);

        // Fetch pools and select best one
        const pools = await fetchPoolsByTVL(normalizedAddress);

        if (!pools || pools.length === 0) {
          await clearUpdateLock(normalizedAddress);
          res.status(404).json({
            status: "error",
            msg: "No pools found for this token",
            tokenAddress: normalizedAddress,
          });
          return;
        }

        selectedPool = selectBestPool(pools, normalizedAddress);

        console.log(`[Katana Incremental] Selected pool:`, {
          poolId: selectedPool.id,
          pair: `${selectedPool.token0.symbol}/${selectedPool.token1.symbol}`,
          tvl: selectedPool.totalValueLockedUSD,
        });

        // Determine if token is token0
        const isToken0 = selectedPool.token0.id.toLowerCase() === normalizedAddress;
        const baseToken = isToken0 ? selectedPool.token0 : selectedPool.token1;
        const quoteToken = isToken0 ? selectedPool.token1 : selectedPool.token0;

        // Fetch swaps (incremental or full)
        let newSwaps;
        if (storedData?.metadata.lastSwapTimestamp) {
          // Incremental update
          const { startTime, endTime } = getIncrementalTimeRange(
            Math.floor(storedData.metadata.lastSwapTimestamp / 1000)
          );
          console.log(`[Katana Incremental] Incremental fetch from ${new Date(startTime * 1000).toISOString()}`);
          newSwaps = await fetchSwaps(selectedPool.id, startTime, endTime);
        } else {
          // Full fetch
          const { startTime, endTime } = getFullTimeRange();
          console.log(`[Katana Incremental] Full fetch from ${new Date(startTime * 1000).toISOString()}`);
          newSwaps = await fetchSwaps(selectedPool.id, startTime, endTime);
        }

        // Process and merge swaps
        const processedNewSwaps = processSwaps(newSwaps, isToken0);
        const existingSwaps = storedData?.swaps || [];
        allSwaps = mergeSwaps(existingSwaps, processedNewSwaps);

        console.log(`[Katana Incremental] Merged: ${existingSwaps.length} existing + ${processedNewSwaps.length} new = ${allSwaps.length} total`);

        // Prepare updated stored data
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

        // Save to Redis
        await saveSwapDataToRedis(normalizedAddress, updatedStoredData);
      } else {
        // Use existing pool info from cache
        selectedPool = {
          id: storedData.metadata.pool.id,
          token0: storedData.metadata.pool.token0,
          token1: storedData.metadata.pool.token1,
          feeTier: storedData.metadata.pool.feeTier,
          totalValueLockedUSD: storedData.metadata.pool.totalValueLockedUSD.toString(),
          volumeUSD: storedData.metadata.pool.volumeUSD.toString(),
        };
        console.log(`[Katana Incremental] Using cached data`);
      }

      // Load historical MySQL data and merge
      const requestedStartTime = Math.floor(Date.now() / 1000) - (daysNum * 24 * 60 * 60);
      
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
          ...(storedData?.metadata || {}),
          totalSwaps: combinedSwaps.length,
          timeRange: {
            start: requestedStartTime * 1000,
            end: Date.now(),
            days: daysNum,
          },
        },
      };

      // Clear update lock
      await clearUpdateLock(normalizedAddress);

      console.log(`[Katana Incremental] Sending response: ${combinedSwaps.length} swaps (${filteredRedisSwaps.length} Redis + ${historicalSwaps.length} MySQL)`);

      res.status(200).json({
        status: "success",
        data: responseData,
        source: "katana-sushiswap-hybrid",
        cached: !shouldUpdate,
        tokenAddress: normalizedAddress,
        count: combinedSwaps.length,
        poolId: selectedPool.id,
        poolTVL: selectedPool.totalValueLockedUSD,
        chain: "katana",
        updateStatus: shouldUpdate ? "updated" : "cached",
        dataSource: {
          redis: filteredRedisSwaps.length,
          mysql: historicalSwaps.length,
          total: combinedSwaps.length,
        },
      });

    } catch (apiError: any) {
      await clearUpdateLock(normalizedAddress);
      
      console.error(`[Katana Incremental] API error:`, apiError.message);
      res.status(500).json({
        status: "error",
        msg: "Failed to fetch or update swap data",
        debug: { error: apiError.message },
      });
    }

  } catch (error: any) {
    console.error("[Katana Incremental] Controller error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
      debug: { error: error.message },
    });
  }
}

/**
 * Clear cache for a specific token (admin endpoint)
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
    console.log(`[Katana Incremental] Clearing cache for: ${normalizedAddress}`);

    // Clear both locks
    await clearUpdateLock(normalizedAddress);

    res.status(200).json({
      status: "success",
      msg: "Cache cleared successfully",
      tokenAddress: normalizedAddress,
      chain: "katana",
    });
  } catch (error: any) {
    console.error("[Katana Incremental] Clear cache error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
    });
  }
}