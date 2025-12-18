// File: src/controllers/katanaCandleGapFixController.ts
// Description: API endpoint to detect and fix gaps in Katana candle data

import type { Request, Response } from "express";
import { getValue, storeValue, deleteValue } from "../redis/katanaTokens";
import {
  detectCandleGaps,
  getCandleDataRange,
  getExistingCandleInfo,
  type CandleGap,
} from "../utils/katana/candleGapHelpers";
import KatanaCandle from "../models/KatanaCandle";
import { fetchPoolsByTVL } from "../utils/katana/dataFetching";
import { fetchSwaps } from "../utils/katana/dataFetching";
import { processSwaps } from "../utils/katana/swapProcessing";
import { generateFiveMinuteCandles } from "../utils/katana/candleGeneration";
import { convertCandlesToModelFormat } from "../utils/katana/candleGeneration";
import { bulkInsertCandles } from "../utils/katana/candleOperations";
import { loadCandlesFromMySQL } from "../utils/katana/candleOperations";
import { saveCandleDataToRedis } from "../utils/katana/redisCandleOperations";
import { selectBestPool } from "../utils/katana/poolSelection";
import {
  CANDLE_GAP_FIX_LOCK_PREFIX,
  CANDLE_GAP_FIX_LOCK_TTL,
} from "../utils/katana/constants";
import type { StoredCandleData } from "../utils/katana/redisCandleOperations";

/**
 * Acquire a lock for candle gap fix operation
 * Prevents concurrent gap-fixing operations for the same token
 */
async function acquireCandleGapFixLock(tokenAddress: string): Promise<boolean> {
  try {
    const lockKey = `${CANDLE_GAP_FIX_LOCK_PREFIX}${tokenAddress.toLowerCase()}`;
    const existing = await getValue(lockKey);

    if (existing) {
      console.log(`[Candle Gap Fix Lock] Lock already held for ${tokenAddress}`);
      return false;
    }

    await storeValue(lockKey, Date.now().toString(), CANDLE_GAP_FIX_LOCK_TTL);
    console.log(`[Candle Gap Fix Lock] Acquired lock for ${tokenAddress}`);
    return true;
  } catch (error) {
    console.error('[Candle Gap Fix Lock] Error acquiring lock:', error);
    return false;
  }
}

/**
 * Release the lock for candle gap fix operation
 */
async function releaseCandleGapFixLock(tokenAddress: string): Promise<void> {
  try {
    const lockKey = `${CANDLE_GAP_FIX_LOCK_PREFIX}${tokenAddress.toLowerCase()}`;
    await deleteValue(lockKey);
    console.log(`[Candle Gap Fix Lock] Released lock for ${tokenAddress}`);
  } catch (error) {
    console.error('[Candle Gap Fix Lock] Error releasing lock:', error);
  }
}

/**
 * Rebuild Redis cache from MySQL candle data
 * Loads recent candles and updates cache with fresh data
 */
async function rebuildRedisCandlesFromMySQL(
  tokenAddress: string,
  poolId: string
): Promise<void> {
  try {
    console.log(`[Candle Gap Fix] Rebuilding Redis cache for ${tokenAddress}`);

    // Load candles from MySQL (last 365 days)
    const oneYearAgo = Math.floor((Date.now() - 365 * 24 * 60 * 60 * 1000) / 1000);
    const mysqlCandles = await loadCandlesFromMySQL(
      tokenAddress,
      poolId,
      oneYearAgo,
      '5m'
    );

    if (mysqlCandles.length === 0) {
      console.log(`[Candle Gap Fix] No candles found in MySQL to rebuild cache`);
      return;
    }

    console.log(`[Candle Gap Fix] Loaded ${mysqlCandles.length} candles from MySQL`);

    // Get pool metadata from first existing candle
    const firstCandle = await KatanaCandle.findOne({
      where: {
        token_address: tokenAddress.toLowerCase(),
        pool_id: poolId.toLowerCase(),
        timeframe: '5m',
      },
      order: [['timestamp', 'DESC']],
    });

    if (!firstCandle) {
      console.log(`[Candle Gap Fix] No candle metadata found`);
      return;
    }

    // Build StoredCandleData structure
    const candleData: StoredCandleData = {
      candles: mysqlCandles,
      metadata: {
        token: {
          address: tokenAddress.toLowerCase(),
          name: firstCandle.pool_token0_address === tokenAddress.toLowerCase()
            ? firstCandle.pool_token0_symbol
            : firstCandle.pool_token1_symbol,
          symbol: firstCandle.pool_token0_address === tokenAddress.toLowerCase()
            ? firstCandle.pool_token0_symbol
            : firstCandle.pool_token1_symbol,
          decimals: '18', // Standard assumption
        },
        pool: {
          id: poolId,
          address: poolId,
          token0: {
            id: firstCandle.pool_token0_address,
            symbol: firstCandle.pool_token0_symbol,
          },
          token1: {
            id: firstCandle.pool_token1_address,
            symbol: firstCandle.pool_token1_symbol,
          },
          feeTier: String(firstCandle.pool_fee_tier),
          totalValueLockedUSD: 0,
          volumeUSD: 0,
        },
        isToken0: firstCandle.is_token0,
        quoteToken: null,
        lastUpdate: Math.floor(Date.now() / 1000),
        lastCandleTimestamp: Math.max(...mysqlCandles.map((c) => c.timestamp)),
        dataRange: {
          start: Math.min(...mysqlCandles.map((c) => c.timestamp)),
          end: Math.max(...mysqlCandles.map((c) => c.timestamp)),
        },
        chain: 'katana',
        dexId: 'katana-sushiswap',
        timeframe: '5m',
      },
    };

    // Save to Redis
    await saveCandleDataToRedis(tokenAddress, candleData, '5m');

    console.log(`[Candle Gap Fix] Redis cache rebuilt with ${mysqlCandles.length} candles`);
  } catch (error) {
    console.error('[Candle Gap Fix] Error rebuilding Redis cache:', error);
  }
}

/**
 * Main endpoint to fix gaps in candle data
 * GET /api/admin/fix-candle-gaps/:tokenAddress?dryRun=true
 */
export async function fixCandleGaps(
  req: Request<{ tokenAddress: string }>,
  res: Response
): Promise<void> {
  const startTime = Date.now();
  const { tokenAddress } = req.params;
  const dryRun = req.query.dryRun === 'true';
  const normalizedAddress = tokenAddress?.toLowerCase();

  let lockAcquired = false;

  try {
    // Validate input
    if (!tokenAddress) {
      res.status(400).json({
        status: 'error',
        message: 'tokenAddress parameter is required',
      });
      return;
    }

    console.log(`[Candle Gap Fix] Starting for token ${normalizedAddress}, dryRun: ${dryRun}`);

    // Acquire lock
    lockAcquired = await acquireCandleGapFixLock(normalizedAddress);
    if (!lockAcquired) {
      res.status(429).json({
        status: 'error',
        message: 'Another gap fix operation is in progress for this token',
        tokenAddress: normalizedAddress,
        retryAfter: CANDLE_GAP_FIX_LOCK_TTL,
      });
      return;
    }

    // Step 1: Find best pool for this token
    console.log(`[Candle Gap Fix] Finding best pool for token ${normalizedAddress}`);
    const pools = await fetchPoolsByTVL(normalizedAddress);

    if (!pools || pools.length === 0) {
      res.status(404).json({
        status: 'error',
        message: 'Could not find any pools for this token',
        tokenAddress: normalizedAddress,
      });
      return;
    }

    const selectedPool = selectBestPool(pools, normalizedAddress);
    const poolId = selectedPool.id;
    const isToken0 = selectedPool.token0.id.toLowerCase() === normalizedAddress;

    console.log(
      `[Candle Gap Fix] Selected pool ${poolId}: ${selectedPool.token0.symbol}/${selectedPool.token1.symbol}`
    );

    // Step 2: Get current data range
    const dataRange = await getCandleDataRange(normalizedAddress, poolId, '5m');

    if (dataRange.totalCandles === 0) {
      res.status(404).json({
        status: 'error',
        message: 'No candle data found for this token. Cannot detect gaps.',
        tokenAddress: normalizedAddress,
        poolId,
      });
      return;
    }

    if (dataRange.totalCandles < 2) {
      res.status(200).json({
        status: 'info',
        message: 'Insufficient data for gap detection. Need at least 2 candles.',
        tokenAddress: normalizedAddress,
        poolId,
        totalCandles: dataRange.totalCandles,
      });
      return;
    }

    console.log(
      `[Candle Gap Fix] Data range: ${dataRange.earliest?.toISOString()} to ${dataRange.latest?.toISOString()} ` +
      `(${dataRange.totalCandles} candles)`
    );

    // Step 3: Detect gaps
    const gaps = await detectCandleGaps(normalizedAddress, poolId, 5);

    if (gaps.length === 0) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      res.status(200).json({
        status: 'success',
        message: 'No gaps detected',
        tokenAddress: normalizedAddress,
        poolId,
        poolPair: `${selectedPool.token0.symbol}/${selectedPool.token1.symbol}`,
        dataRange: {
          earliest: dataRange.earliest?.toISOString(),
          latest: dataRange.latest?.toISOString(),
          totalCandles: dataRange.totalCandles,
        },
        gaps: [],
        candlesAdded: 0,
        duration: `${duration}s`,
      });
      return;
    }

    console.log(`[Candle Gap Fix] Found ${gaps.length} gaps totaling ${gaps.reduce((sum, g) => sum + g.missingCandles, 0)} missing candles`);

    // If dry run, return gaps without fixing
    if (dryRun) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      res.status(200).json({
        status: 'success',
        message: 'Dry run - gaps detected but not fixed',
        dryRun: true,
        tokenAddress: normalizedAddress,
        poolId,
        poolPair: `${selectedPool.token0.symbol}/${selectedPool.token1.symbol}`,
        gapsDetected: gaps.length,
        estimatedCandlesToAdd: gaps.reduce((sum, g) => sum + g.missingCandles, 0),
        gaps: gaps.map((gap) => ({
          start: new Date(gap.start).toISOString(),
          end: new Date(gap.end).toISOString(),
          durationMinutes: gap.durationMinutes,
          missingCandles: gap.missingCandles,
        })),
        dataRange: {
          earliest: dataRange.earliest?.toISOString(),
          latest: dataRange.latest?.toISOString(),
          totalCandles: dataRange.totalCandles,
        },
        duration: `${duration}s`,
      });
      return;
    }

    // Step 4: Fix each gap
    const gapResults = [];
    let totalCandlesAdded = 0;

    // Get existing candle info for metadata
    const existingInfo = await getExistingCandleInfo(normalizedAddress, poolId);
    if (!existingInfo) {
      res.status(500).json({
        status: 'error',
        message: 'Could not retrieve existing candle metadata',
        tokenAddress: normalizedAddress,
      });
      return;
    }

    for (let i = 0; i < gaps.length; i++) {
      const gap = gaps[i];
      console.log(
        `[Candle Gap Fix] Processing gap ${i + 1}/${gaps.length}: ` +
        `${new Date(gap.start).toISOString()} to ${new Date(gap.end).toISOString()} ` +
        `(${gap.missingCandles} candles)`
      );

      try {
        // Fetch swaps from subgraph
        const swaps = await fetchSwaps(
          poolId,
          Math.floor(gap.start / 1000), // Convert ms to seconds
          Math.floor(gap.end / 1000),
          5000, // maxSwaps
          5000  // maxSkip
        );

        console.log(`[Candle Gap Fix] Fetched ${swaps.length} swaps for gap`);

        if (swaps.length === 0) {
          console.log(`[Candle Gap Fix] No swaps found for gap period`);
          gapResults.push({
            start: new Date(gap.start).toISOString(),
            end: new Date(gap.end).toISOString(),
            durationMinutes: gap.durationMinutes,
            missingCandles: gap.missingCandles,
            candlesAdded: 0,
            swapsProcessed: 0,
            note: 'No swap data available for this period',
          });
          continue;
        }

        // Process swaps
        const processedSwaps = processSwaps(swaps, isToken0);
        console.log(`[Candle Gap Fix] Processed ${processedSwaps.length} swaps`);

        // Generate 5-minute candles
        const candles = generateFiveMinuteCandles(processedSwaps);
        console.log(`[Candle Gap Fix] Generated ${candles.length} candles`);

        if (candles.length === 0) {
          gapResults.push({
            start: new Date(gap.start).toISOString(),
            end: new Date(gap.end).toISOString(),
            durationMinutes: gap.durationMinutes,
            missingCandles: gap.missingCandles,
            candlesAdded: 0,
            swapsProcessed: processedSwaps.length,
            note: 'No candles generated from swaps',
          });
          continue;
        }

        // Convert to MySQL format
        const candlesForDB = convertCandlesToModelFormat(
          candles,
          existingInfo,
          normalizedAddress
        );

        // Insert to MySQL
        const result = await bulkInsertCandles(candlesForDB);

        if (result.success) {
          console.log(`[Candle Gap Fix] Inserted ${result.count} candles to MySQL`);
          totalCandlesAdded += result.count;

          gapResults.push({
            start: new Date(gap.start).toISOString(),
            end: new Date(gap.end).toISOString(),
            durationMinutes: gap.durationMinutes,
            missingCandles: gap.missingCandles,
            candlesAdded: result.count,
            swapsProcessed: processedSwaps.length,
          });
        } else {
          console.error(`[Candle Gap Fix] Failed to insert candles:`, result.error);
          gapResults.push({
            start: new Date(gap.start).toISOString(),
            end: new Date(gap.end).toISOString(),
            durationMinutes: gap.durationMinutes,
            missingCandles: gap.missingCandles,
            candlesAdded: 0,
            swapsProcessed: processedSwaps.length,
            error: result.error,
          });
        }
      } catch (gapError: any) {
        console.error(`[Candle Gap Fix] Error processing gap:`, gapError);
        gapResults.push({
          start: new Date(gap.start).toISOString(),
          end: new Date(gap.end).toISOString(),
          durationMinutes: gap.durationMinutes,
          missingCandles: gap.missingCandles,
          candlesAdded: 0,
          error: gapError.message,
        });
      }
    }

    // Step 5: Rebuild Redis cache
    console.log(`[Candle Gap Fix] Rebuilding Redis cache`);
    await rebuildRedisCandlesFromMySQL(normalizedAddress, poolId);

    // Return success response
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    res.status(200).json({
      status: 'success',
      message: 'Gaps fixed successfully',
      tokenAddress: normalizedAddress,
      poolId,
      poolPair: `${selectedPool.token0.symbol}/${selectedPool.token1.symbol}`,
      poolInfo: {
        token0: { address: selectedPool.token0.id, symbol: selectedPool.token0.symbol },
        token1: { address: selectedPool.token1.id, symbol: selectedPool.token1.symbol },
        feeTier: parseInt(selectedPool.feeTier),
        isToken0,
      },
      gapsFixed: gaps.length,
      candlesAdded: totalCandlesAdded,
      duration: `${duration}s`,
      gaps: gapResults,
      dataRange: {
        earliest: dataRange.earliest?.toISOString(),
        latest: dataRange.latest?.toISOString(),
        totalCandles: dataRange.totalCandles + totalCandlesAdded,
      },
    });
  } catch (error: any) {
    console.error('[Candle Gap Fix] Fatal error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fix candle gaps',
      error: error.message,
      tokenAddress: normalizedAddress,
    });
  } finally {
    // Always release lock
    if (lockAcquired) {
      await releaseCandleGapFixLock(normalizedAddress);
    }
  }
}
