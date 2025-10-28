// src/controllers/katana/appendHistoricalController.ts
import type { Request, Response, NextFunction } from "express";
import {
  // Constants
  MAX_SKIP_LIMIT,
  MAX_TOTAL_SWAPS,
  
  // Types
  ExistingSwapInfo,
  ProcessedSwap,
  RedisSwapData,
  
  // Utilities
  fetchHistoricalSwaps,
  processSwaps,
  convertToModelFormat,
  bulkInsertSwaps,
  loadRedisSwapData,
  getSwapCount,
  getOldestSwapTimestamp,
  getExistingSwapInfo,
  getMySQLSwapStats, // This is the renamed import
  checkInMemoryLock,
  setInMemoryLock,
  clearInMemoryLock,
} from '../../utils/katana/index';

/**
 * Append historical data for a token by fetching older swaps
 * Works backward from oldest existing swap
 */
export async function appendHistoricalData(
  req: Request<{}, {}, {}, { tokenAddress?: string; batchCount?: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { tokenAddress, batchCount = "1" } = req.query;

    // Validation
    if (!tokenAddress) {
      res.status(400).json({
        status: "error",
        msg: "tokenAddress parameter is required",
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();
    const batchCountNum = Math.max(1, Math.min(parseInt(batchCount, 10) || 1, 10));

    console.log(`[Historical Append] Processing request:`, {
      tokenAddress: normalizedAddress,
      batchCount: batchCountNum,
    });

    // Check in-memory lock
    if (checkInMemoryLock(normalizedAddress)) {
      console.log(`[Historical Append] Update already in progress`);
      res.status(429).json({
        status: "error",
        msg: "Historical update already in progress for this token",
        tokenAddress: normalizedAddress,
      });
      return;
    }

    // Set in-memory lock
    setInMemoryLock(normalizedAddress);

    try {
      // Check existing MySQL data
      const existingCount = await getSwapCount(normalizedAddress);
      
      console.log(`[Historical Append] Existing MySQL count: ${existingCount}`);

      let poolIdToUse: string;
      let oldestTimestamp: Date;
      let existingSwapForPoolInfo: ExistingSwapInfo;

      if (existingCount === 0) {
        // Try Redis fallback
        console.log(`[Historical Append] No MySQL data, checking Redis`);
        
        const redisData: RedisSwapData | null = await loadRedisSwapData(normalizedAddress);

        if (!redisData || !redisData.swaps || redisData.swaps.length === 0) {
          clearInMemoryLock(normalizedAddress);
          res.status(404).json({
            status: "error",
            msg: "No existing data found in MySQL or Redis. Please fetch initial data first.",
            tokenAddress: normalizedAddress,
          });
          return;
        }

        console.log(`[Historical Append] Found Redis data: ${redisData.swaps.length} swaps`);

        // Use Redis data
        poolIdToUse = redisData.metadata.pool.id;
        const oldestSwapTimestamp = Math.min(...redisData.swaps.map(s => s.timestamp));
        oldestTimestamp = new Date(oldestSwapTimestamp);

        existingSwapForPoolInfo = {
          pool_id: redisData.metadata.pool.id,
          pool_token0_address: redisData.metadata.pool.token0.id,
          pool_token0_symbol: redisData.metadata.pool.token0.symbol,
          pool_token1_address: redisData.metadata.pool.token1.id,
          pool_token1_symbol: redisData.metadata.pool.token1.symbol,
          pool_fee_tier: parseInt(redisData.metadata.pool.feeTier),
          is_token0: redisData.metadata.isToken0,
        };

        console.log(`[Historical Append] Using Redis data as baseline:`, {
          poolId: poolIdToUse,
          oldestSwap: oldestTimestamp.toISOString(),
          isToken0: existingSwapForPoolInfo.is_token0,
        });

      } else {
        // Use MySQL data
        console.log(`[Historical Append] Found MySQL data: ${existingCount} swaps`);

        const oldestSwap = await getOldestSwapTimestamp(normalizedAddress);
        const existingSwapInfo = await getExistingSwapInfo(normalizedAddress);

        if (!oldestSwap || !existingSwapInfo) {
          clearInMemoryLock(normalizedAddress);
          res.status(404).json({
            status: "error",
            msg: "No existing swap data found",
            tokenAddress: normalizedAddress,
          });
          return;
        }

        poolIdToUse = existingSwapInfo.pool_id;
        oldestTimestamp = oldestSwap;
        existingSwapForPoolInfo = existingSwapInfo;
      }

      console.log(`[Historical Append] Current data stats:`, {
        totalSwaps: existingCount,
        oldestSwap: oldestTimestamp.toISOString(),
        poolId: poolIdToUse,
        isToken0: existingSwapForPoolInfo.is_token0,
        dataSource: existingCount > 0 ? 'MySQL' : 'Redis',
      });

      const isToken0 = existingSwapForPoolInfo.is_token0;

      // Fetch historical data in batches
      let allHistorical: ProcessedSwap[] = [];
      const currentOldestSec = Math.floor(oldestTimestamp.getTime() / 1000);

      console.log(`[Historical Append] Starting historical fetch from: ${new Date(currentOldestSec * 1000).toISOString()}`);

      for (let batch = 1; batch <= batchCountNum; batch++) {
        const olderThanSec = batch === 1
          ? currentOldestSec
          : Math.min(...allHistorical.map((s) => Math.floor(s.timestamp / 1000)));

        console.log(`[Historical Append] Batch ${batch}/${batchCountNum}, fetching swaps older than ${new Date(olderThanSec * 1000).toISOString()}`);

        const historicalRaw = await fetchHistoricalSwaps(
          poolIdToUse.toLowerCase(),
          olderThanSec,
          MAX_TOTAL_SWAPS,
          MAX_SKIP_LIMIT
        );

        if (historicalRaw.length === 0) {
          console.log(`[Historical Append] No more historical data in batch ${batch}`);
          break;
        }

        const processed = processSwaps(historicalRaw, isToken0);
        allHistorical = [...allHistorical, ...processed];

        console.log(`[Historical Append] Batch ${batch} complete: ${processed.length} swaps, total: ${allHistorical.length}`);

        if (processed.length > 0) {
          const newestInBatch = Math.max(...processed.map(s => s.timestamp));
          const oldestInBatch = Math.min(...processed.map(s => s.timestamp));
          console.log(`[Historical Append] Batch time range: ${new Date(newestInBatch).toISOString()} to ${new Date(oldestInBatch).toISOString()}`);
        }

        if (batch < batchCountNum) {
          console.log(`[Historical Append] Waiting 2 seconds before next batch...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      if (allHistorical.length === 0) {
        clearInMemoryLock(normalizedAddress);
        res.status(200).json({
          status: "success",
          msg: "No additional historical data found",
          tokenAddress: normalizedAddress,
          poolId: poolIdToUse,
          chain: "katana",
          stats: {
            existingSwaps: existingCount,
            historicalSwapsAdded: 0,
            totalSwaps: existingCount,
            batchesProcessed: 0,
          },
        });
        return;
      }

      console.log(`[Historical Append] Total historical swaps fetched: ${allHistorical.length}`);

      // Insert into MySQL
      const rows = convertToModelFormat(allHistorical, existingSwapForPoolInfo, normalizedAddress);
      const insertResult = await bulkInsertSwaps(rows);

      if (!insertResult.success) {
        throw new Error(`Failed to insert swaps: ${insertResult.error}`);
      }

      console.log(`[Historical Append] Successfully inserted ${rows.length} swaps`);

      // Get final stats
      const finalStats = await getMySQLSwapStats(normalizedAddress, poolIdToUse.toLowerCase());

      clearInMemoryLock(normalizedAddress);

      res.status(200).json({
        status: "success",
        msg: "Historical data appended successfully",
        tokenAddress: normalizedAddress,
        poolId: poolIdToUse.toLowerCase(),
        chain: "katana",
        dataSource: existingCount > 0 ? 'MySQL' : 'Redis-initiated',
        stats: {
          existingSwaps: existingCount,
          historicalSwapsAdded: allHistorical.length,
          totalSwaps: finalStats.count,
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

      console.error(`[Historical Append] API error:`, apiError.message);
      res.status(500).json({
        status: "error",
        msg: "Failed to append historical swap data",
        debug: { error: apiError.message },
      });
    }

  } catch (error: any) {
    if (req.query.tokenAddress) {
      clearInMemoryLock(req.query.tokenAddress.toLowerCase());
    }

    console.error("[Historical Append] Controller error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
      debug: { error: error.message },
    });
  }
}