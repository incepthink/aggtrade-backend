// src/controllers/katana/appendHistoricalController.ts
import type { Request, Response, NextFunction } from "express";
import {
  // Constants
  MAX_SKIP_LIMIT,
  MAX_TOTAL_SWAPS,
  
  // Types
  ExistingSwapInfo,
  
  // Utilities
  fetchHistoricalSwaps,
  processSwaps,
  getSwapCount,
  getOldestSwapTimestamp,
  getExistingSwapInfo,
  checkInMemoryLock,
  setInMemoryLock,
  clearInMemoryLock,
} from '../../utils/katana/index';

import {
  generateFiveMinuteCandles,
  convertCandlesToModelFormat,
  type Candle,
} from '../../utils/katana/candleGeneration';

import {
  bulkInsertCandles,
  getCandleStats,
  getOldestCandleTimestamp,
} from '../../utils/katana/candleOperations';

import {
  loadCandleDataFromRedis,
} from '../../utils/katana/redisCandleOperations';

/**
 * Append historical candle data by fetching older swaps and converting to candles
 * Works backward from oldest existing candle
 */
export async function appendHistoricalData(
  req: Request<{}, {}, {}, { tokenAddress?: string; batchCount?: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { tokenAddress, batchCount = "1" } = req.query;

    if (!tokenAddress) {
      res.status(400).json({
        status: "error",
        msg: "tokenAddress parameter is required",
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();
    const batchCountNum = Math.max(1, Math.min(parseInt(batchCount, 10) || 1, 10));

    console.log(`[Historical Candles] Processing request:`, {
      tokenAddress: normalizedAddress,
      batchCount: batchCountNum,
    });

    // Check in-memory lock
    if (checkInMemoryLock(normalizedAddress)) {
      console.log(`[Historical Candles] Update already in progress`);
      res.status(429).json({
        status: "error",
        msg: "Historical update already in progress for this token",
        tokenAddress: normalizedAddress,
      });
      return;
    }

    setInMemoryLock(normalizedAddress);

    try {
      // Check existing candle data in MySQL
      let poolIdToUse: string;
      let oldestTimestamp: Date;
      let existingSwapForPoolInfo: ExistingSwapInfo;

      // First check if we have candles in MySQL
      const oldestCandleTimestamp = await getOldestCandleTimestamp(normalizedAddress, '5m');
      
      if (oldestCandleTimestamp) {
        // Use candle data
        console.log(`[Historical Candles] Found existing candles in MySQL`);
        oldestTimestamp = oldestCandleTimestamp;
        
        const existingSwapInfo = await getExistingSwapInfo(normalizedAddress);
        if (!existingSwapInfo) {
          clearInMemoryLock(normalizedAddress);
          res.status(404).json({
            status: "error",
            msg: "No pool info found",
            tokenAddress: normalizedAddress,
          });
          return;
        }
        
        poolIdToUse = existingSwapInfo.pool_id;
        existingSwapForPoolInfo = existingSwapInfo;
        
      } else {
        // No candles in MySQL, check Redis
        console.log(`[Historical Candles] No MySQL candles, checking Redis`);
        
        const redisData = await loadCandleDataFromRedis(normalizedAddress, '5m');

        if (!redisData || !redisData.candles || redisData.candles.length === 0) {
          // Try old swap data as fallback
          const existingCount = await getSwapCount(normalizedAddress);
          
          if (existingCount === 0) {
            clearInMemoryLock(normalizedAddress);
            res.status(404).json({
              status: "error",
              msg: "No existing data found. Please fetch initial data first.",
              tokenAddress: normalizedAddress,
            });
            return;
          }

          // Use swap data
          const oldestSwap = await getOldestSwapTimestamp(normalizedAddress);
          const existingSwapInfo = await getExistingSwapInfo(normalizedAddress);

          if (!oldestSwap || !existingSwapInfo) {
            clearInMemoryLock(normalizedAddress);
            res.status(404).json({
              status: "error",
              msg: "No existing data found",
              tokenAddress: normalizedAddress,
            });
            return;
          }

          poolIdToUse = existingSwapInfo.pool_id;
          oldestTimestamp = oldestSwap;
          existingSwapForPoolInfo = existingSwapInfo;
        } else {
          // Use Redis candle data
          console.log(`[Historical Candles] Found Redis candles: ${redisData.candles.length}`);

          poolIdToUse = redisData.metadata.pool.id;
          const oldestCandleTs = Math.min(...redisData.candles.map(c => c.timestamp));
          oldestTimestamp = new Date(oldestCandleTs);

          existingSwapForPoolInfo = {
            pool_id: redisData.metadata.pool.id,
            pool_token0_address: redisData.metadata.pool.token0.id,
            pool_token0_symbol: redisData.metadata.pool.token0.symbol,
            pool_token1_address: redisData.metadata.pool.token1.id,
            pool_token1_symbol: redisData.metadata.pool.token1.symbol,
            pool_fee_tier: parseInt(redisData.metadata.pool.feeTier),
            is_token0: redisData.metadata.isToken0,
          };
        }
      }

      console.log(`[Historical Candles] Current data stats:`, {
        oldestCandle: oldestTimestamp.toISOString(),
        poolId: poolIdToUse,
        isToken0: existingSwapForPoolInfo.is_token0,
      });

      const isToken0 = existingSwapForPoolInfo.is_token0;

      // Fetch historical swaps in batches
      let allHistoricalCandles: Candle[] = [];
      const currentOldestSec = Math.floor(oldestTimestamp.getTime() / 1000);

      console.log(`[Historical Candles] Starting historical fetch from: ${new Date(currentOldestSec * 1000).toISOString()}`);

      for (let batch = 1; batch <= batchCountNum; batch++) {
        const olderThanSec = batch === 1
          ? currentOldestSec
          : Math.min(...allHistoricalCandles.map((c) => Math.floor(c.timestamp / 1000)));

        console.log(`[Historical Candles] Batch ${batch}/${batchCountNum}, fetching swaps older than ${new Date(olderThanSec * 1000).toISOString()}`);

        const historicalRaw = await fetchHistoricalSwaps(
          poolIdToUse.toLowerCase(),
          olderThanSec,
          MAX_TOTAL_SWAPS,
          MAX_SKIP_LIMIT
        );

        if (historicalRaw.length === 0) {
          console.log(`[Historical Candles] No more historical data in batch ${batch}`);
          break;
        }

        // Process swaps and generate candles
        const processedSwaps = processSwaps(historicalRaw, isToken0);
        const newCandles = generateFiveMinuteCandles(processedSwaps);
        
        allHistoricalCandles = [...allHistoricalCandles, ...newCandles];

        console.log(`[Historical Candles] Batch ${batch} complete: ${historicalRaw.length} swaps → ${newCandles.length} candles, total: ${allHistoricalCandles.length} candles`);

        if (batch < batchCountNum) {
          console.log(`[Historical Candles] Waiting 2 seconds before next batch...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      if (allHistoricalCandles.length === 0) {
        clearInMemoryLock(normalizedAddress);
        res.status(200).json({
          status: "success",
          msg: "No additional historical data found",
          tokenAddress: normalizedAddress,
          poolId: poolIdToUse,
          chain: "katana",
          stats: {
            existingCandles: 0,
            historicalCandlesAdded: 0,
            totalCandles: 0,
            batchesProcessed: 0,
          },
        });
        return;
      }

      console.log(`[Historical Candles] Total historical candles generated: ${allHistoricalCandles.length}`);

      // Insert candles into MySQL
      const candlesForDB = convertCandlesToModelFormat(
        allHistoricalCandles,
        existingSwapForPoolInfo,
        normalizedAddress
      );
      
      const insertResult = await bulkInsertCandles(candlesForDB);

      if (!insertResult.success) {
        throw new Error(`Failed to insert candles: ${insertResult.error}`);
      }

      console.log(`[Historical Candles] Successfully inserted ${candlesForDB.length} candles`);

      // Get final stats
      const finalStats = await getCandleStats(normalizedAddress, poolIdToUse.toLowerCase(), '5m');

      clearInMemoryLock(normalizedAddress);

      res.status(200).json({
        status: "success",
        msg: "Historical candle data appended successfully",
        tokenAddress: normalizedAddress,
        poolId: poolIdToUse.toLowerCase(),
        chain: "katana",
        timeframe: '5m',
        stats: {
          historicalCandlesAdded: allHistoricalCandles.length,
          totalCandles: finalStats.count,
          batchesProcessed: batchCountNum,
        },
        dataRange: {
          oldStart: oldestTimestamp.toISOString(),
          newStart: finalStats.oldestTimestamp?.toISOString(),
          end: finalStats.newestTimestamp?.toISOString(),
          totalDaysAdded: finalStats.oldestTimestamp
            ? Math.floor((oldestTimestamp.getTime() - finalStats.oldestTimestamp.getTime()) / (24 * 60 * 60 * 1000))
            : 0,
        },
        limits: {
          maxSwapsPerBatch: MAX_TOTAL_SWAPS,
          maxSkip: MAX_SKIP_LIMIT,
        },
      });

    } catch (apiError: any) {
      clearInMemoryLock(normalizedAddress);

      console.error(`[Historical Candles] API error:`, apiError.message);
      res.status(500).json({
        status: "error",
        msg: "Failed to append historical candle data",
        debug: { error: apiError.message },
      });
    }

  } catch (error: any) {
    if (req.query.tokenAddress) {
      clearInMemoryLock(req.query.tokenAddress.toLowerCase());
    }

    console.error("[Historical Candles] Controller error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
      debug: { error: error.message },
    });
  }
}