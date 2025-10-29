// src/controllers/katana/katanaSushiswapSwapController.ts
import type { Request, Response, NextFunction } from "express";
import {
  // Constants
  FULL_DATA_DAYS,
  
  // Types
  Pool,
  
  // Utilities
  fetchPoolsByTVL,
  selectBestPool,
  fetchSwaps,
  processSwaps,
  getFullTimeRange,
  getIncrementalTimeRange,
  needsUpdate,
  checkUpdateLock,
  setUpdateLock,
  clearUpdateLock,
  getExistingSwapInfo,
} from '../utils/katana/index';

import {
  generateFiveMinuteCandles,
  convertCandlesToModelFormat,
  aggregateCandlesToTimeframe,
  mergeCandles,
  type Candle,
} from '../utils/katana/candleGeneration';

import {
  loadCandlesFromMySQL,
  bulkInsertCandles,
} from '../utils/katana/candleOperations';

import {
  loadCandleDataFromRedis,
  saveCandleDataToRedis,
  type StoredCandleData,
} from '../utils/katana/redisCandleOperations';

/**
 * Get OHLC candle data for Katana tokens
 * Returns pre-computed 5m candles (or aggregated timeframes)
 */
export async function getKatanaSwapData(
  req: Request<{}, {}, {}, { tokenAddress?: string; days?: string; timeframe?: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { tokenAddress, days = "365", timeframe = "5m" } = req.query;

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
    const requestedTimeframe = timeframe as '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';

    console.log(`[Katana Candles] Processing request:`, {
      tokenAddress: normalizedAddress,
      days: daysNum,
      timeframe: requestedTimeframe,
    });

    // Check if update is in progress
    const isLocked = await checkUpdateLock(normalizedAddress);
    if (isLocked) {
      console.log(`[Katana Candles] Update in progress, returning 429`);
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
      // Load cached 5m candles
      const storedData = await loadCandleDataFromRedis(normalizedAddress, '5m');

      // Determine if we need to fetch new data
      const shouldUpdate = !storedData || needsUpdate(storedData.metadata.lastUpdate);

      let selectedPool: Pool;
      let allCandles: Candle[] = storedData?.candles || [];

      if (shouldUpdate) {
        console.log(`[Katana Candles] Fetching new data from subgraph`);

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

        console.log(`[Katana Candles] Selected pool:`, {
          poolId: selectedPool.id,
          pair: `${selectedPool.token0.symbol}/${selectedPool.token1.symbol}`,
        });

        const isToken0 = selectedPool.token0.id.toLowerCase() === normalizedAddress;
        const baseToken = isToken0 ? selectedPool.token0 : selectedPool.token1;
        const quoteToken = isToken0 ? selectedPool.token1 : selectedPool.token0;

        // Fetch swaps (incremental or full)
        let newSwaps;
        if (storedData?.metadata.lastCandleTimestamp) {
          const { startTime, endTime } = getIncrementalTimeRange(
            Math.floor(storedData.metadata.lastCandleTimestamp / 1000)
          );
          console.log(`[Katana Candles] Incremental fetch`);
          newSwaps = await fetchSwaps(selectedPool.id, startTime, endTime);
        } else {
          const { startTime, endTime } = getFullTimeRange();
          console.log(`[Katana Candles] Full fetch`);
          newSwaps = await fetchSwaps(selectedPool.id, startTime, endTime);
        }

        // Process swaps and generate 5m candles
        const processedSwaps = processSwaps(newSwaps, isToken0);
        const newCandles = generateFiveMinuteCandles(processedSwaps);
        
        console.log(`[Katana Candles] Generated ${newCandles.length} new 5m candles from ${processedSwaps.length} swaps`);

        // Merge with existing candles
        const existingCandles = storedData?.candles || [];
        allCandles = mergeCandles(existingCandles, newCandles);

        console.log(`[Katana Candles] Merged: ${existingCandles.length} existing + ${newCandles.length} new = ${allCandles.length} total`);

        // Prepare updated stored data
        const now = Math.floor(Date.now() / 1000);
        const lastCandleTimestamp = allCandles.length > 0
          ? Math.max(...allCandles.map(c => c.timestamp))
          : now * 1000;

        const updatedStoredData: StoredCandleData = {
          candles: allCandles,
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
            lastCandleTimestamp,
            dataRange: {
              start: allCandles.length > 0 ? Math.min(...allCandles.map(c => c.timestamp)) : now * 1000,
              end: lastCandleTimestamp,
            },
            chain: "katana",
            dexId: "katana-sushiswap",
            timeframe: '5m',
          },
        };

        // Save 5m candles to Redis
        await saveCandleDataToRedis(normalizedAddress, updatedStoredData, '5m');

        // Save 5m candles to MySQL
        const existingSwapInfo = await getExistingSwapInfo(normalizedAddress);
        if (existingSwapInfo) {
          const candlesForDB = convertCandlesToModelFormat(newCandles, existingSwapInfo, normalizedAddress);
          await bulkInsertCandles(candlesForDB);
          console.log(`[Katana Candles] Saved ${candlesForDB.length} candles to MySQL`);
        }

      } else {
        selectedPool = {
          id: storedData.metadata.pool.id,
          token0: storedData.metadata.pool.token0,
          token1: storedData.metadata.pool.token1,
          feeTier: storedData.metadata.pool.feeTier,
          totalValueLockedUSD: storedData.metadata.pool.totalValueLockedUSD.toString(),
          volumeUSD: storedData.metadata.pool.volumeUSD.toString(),
        };
        console.log(`[Katana Candles] Using cached data`);
      }

      // Load historical candles from MySQL and merge
      const requestedStartTime = Math.floor(Date.now() / 1000) - (daysNum * 24 * 60 * 60);
      
      const historicalCandles = await loadCandlesFromMySQL(
        normalizedAddress,
        selectedPool.id,
        requestedStartTime,
        '5m'
      );

      // Filter Redis candles to requested time range
      const filteredRedisCandles = allCandles.filter(
        candle => candle.timestamp >= requestedStartTime * 1000
      );

      // Merge Redis and MySQL candles
      const combined5mCandles = mergeCandles(filteredRedisCandles, historicalCandles);

      // Aggregate to requested timeframe if needed
      let finalCandles: Candle[];
      if (requestedTimeframe === '5m') {
        finalCandles = combined5mCandles;
      } else {
        console.log(`[Katana Candles] Aggregating to ${requestedTimeframe}`);
        finalCandles = aggregateCandlesToTimeframe(combined5mCandles, requestedTimeframe);
      }

      // Clear update lock
      await clearUpdateLock(normalizedAddress);

      console.log(`[Katana Candles] Sending response: ${finalCandles.length} ${requestedTimeframe} candles`);

      // Format response to match frontend expectations
      const isToken0 = storedData?.metadata?.isToken0 ?? 
                       (selectedPool.token0.id.toLowerCase() === normalizedAddress);
      
      res.status(200).json({
        status: "success",
        data: {
          candles: finalCandles,
          metadata: {
            token: storedData?.metadata?.token || {
              address: normalizedAddress,
              symbol: isToken0 ? selectedPool.token0.symbol : selectedPool.token1.symbol,
            },
            pool: storedData?.metadata?.pool || {
              id: selectedPool.id,
              token0: selectedPool.token0,
              token1: selectedPool.token1,
            },
            poolToken0: selectedPool.token0, // Frontend expects this
            poolToken1: selectedPool.token1, // Frontend expects this
            isToken0,
            totalCandles: finalCandles.length,
            timeframe: requestedTimeframe,
            timeRange: {
              start: requestedStartTime * 1000,
              end: Date.now(),
              days: daysNum,
            },
          },
        },
        source: "katana-sushiswap-candles",
        cached: !shouldUpdate,
        tokenAddress: normalizedAddress,
        count: finalCandles.length,
        poolId: selectedPool.id,
        poolTVL: selectedPool.totalValueLockedUSD,
        chain: "katana",
        updateStatus: shouldUpdate ? "updated" : "cached",
        dataSource: {
          redis: filteredRedisCandles.length,
          mysql: historicalCandles.length,
          combined5m: combined5mCandles.length,
          finalTimeframe: finalCandles.length,
        },
      });

    } catch (apiError: any) {
      await clearUpdateLock(normalizedAddress);
      
      console.error(`[Katana Candles] API error:`, apiError.message);
      res.status(500).json({
        status: "error",
        msg: "Failed to fetch or update candle data",
        debug: { error: apiError.message },
      });
    }

  } catch (error: any) {
    console.error("[Katana Candles] Controller error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
      debug: { error: error.message },
    });
  }
}

/**
 * Clear cache for a specific token
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
    console.log(`[Katana Candles] Clearing cache for: ${normalizedAddress}`);

    await clearUpdateLock(normalizedAddress);

    res.status(200).json({
      status: "success",
      msg: "Cache cleared successfully",
      tokenAddress: normalizedAddress,
      chain: "katana",
    });
  } catch (error: any) {
    console.error("[Katana Candles] Clear cache error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
    });
  }
}