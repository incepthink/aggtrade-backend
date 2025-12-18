// src/utils/katana/candleGapHelpers.ts

import KatanaCandle from "../../models/KatanaCandle";
import { getCandleStats } from "./candleOperations";
import { loadCandleDataFromRedis } from "./redisCandleOperations";

/**
 * Interface for a detected gap in candle data
 */
export interface CandleGap {
  start: number; // Unix timestamp in milliseconds
  end: number; // Unix timestamp in milliseconds
  durationMinutes: number;
  missingCandles: number; // Expected number of missing 5-minute candles
}

/**
 * Interface for pool metadata from existing candles
 */
export interface ExistingCandleInfo {
  pool_id: string;
  pool_token0_address: string;
  pool_token0_symbol: string;
  pool_token1_address: string;
  pool_token1_symbol: string;
  pool_fee_tier: number;
  is_token0: boolean;
}

/**
 * Interface for data range statistics
 */
export interface CandleDataRange {
  earliest: Date | null;
  latest: Date | null;
  totalCandles: number;
}

/**
 * Get all candle timestamps for a token/pool/timeframe combination
 * Returns timestamps in ascending order (oldest first)
 *
 * @param tokenAddress - The token address (will be lowercased)
 * @param poolId - The pool ID (will be lowercased)
 * @param timeframe - The timeframe (default: '5m')
 * @returns Array of timestamps in milliseconds
 */
export async function getCandleTimestamps(
  tokenAddress: string,
  poolId: string,
  timeframe: string = '5m'
): Promise<number[]> {
  try {
    const candles = await KatanaCandle.findAll({
      attributes: ['timestamp'],
      where: {
        token_address: tokenAddress.toLowerCase(),
        pool_id: poolId.toLowerCase(),
        timeframe,
      },
      order: [['timestamp', 'ASC']],
      raw: true,
    });

    return candles.map((c: any) => c.timestamp.getTime());
  } catch (error) {
    console.error('[Candle Gap Helper] Error getting timestamps:', error);
    return [];
  }
}

/**
 * Get timestamps from Redis cache for a token
 * Returns timestamps in the order they appear in Redis cache
 *
 * @param tokenAddress - The token address (will be lowercased)
 * @param poolId - The pool ID (not used for Redis key, but kept for consistency)
 * @param timeframe - The timeframe (default: '5m')
 * @returns Array of timestamps in milliseconds
 */
export async function getRedisTimestamps(
  tokenAddress: string,
  poolId: string,
  timeframe: string = '5m'
): Promise<number[]> {
  try {
    // Load candle data from Redis
    const candleData = await loadCandleDataFromRedis(tokenAddress, timeframe);

    // If no Redis data, return empty array
    if (!candleData || !candleData.candles) {
      console.log(`[Candle Gap Helper] No Redis data found for ${tokenAddress}`);
      return [];
    }

    console.log(`[Candle Gap Helper] Found ${candleData.candles.length} candles in Redis`);

    // Extract timestamps from candles
    return candleData.candles.map((c) => c.timestamp);
  } catch (error) {
    console.error('[Candle Gap Helper] Error getting Redis timestamps:', error);
    return [];
  }
}

/**
 * Detect gaps in candle data for a specific token/pool combination
 * Looks for missing 5-minute intervals in the sequence
 * Merges data from both MySQL and Redis to detect all gaps
 *
 * @param tokenAddress - The token address
 * @param poolId - The pool ID
 * @param minGapMinutes - Minimum gap size in minutes (default: 5 = one missing candle)
 * @returns Array of detected gaps
 */
export async function detectCandleGaps(
  tokenAddress: string,
  poolId: string,
  minGapMinutes: number = 5
): Promise<CandleGap[]> {
  try {
    console.log(`[Candle Gap Detection] Starting for token ${tokenAddress}, pool ${poolId}`);

    // Get timestamps from MySQL
    const mysqlTimestamps = await getCandleTimestamps(tokenAddress, poolId, '5m');
    console.log(`[Candle Gap Detection] MySQL candles: ${mysqlTimestamps.length}`);

    // Get timestamps from Redis
    const redisTimestamps = await getRedisTimestamps(tokenAddress, poolId, '5m');
    console.log(`[Candle Gap Detection] Redis candles: ${redisTimestamps.length}`);

    // Merge and deduplicate timestamps using Set
    const allTimestamps = Array.from(new Set([...mysqlTimestamps, ...redisTimestamps]));

    // Sort chronologically (oldest first)
    allTimestamps.sort((a, b) => a - b);

    if (allTimestamps.length < 2) {
      console.log(`[Candle Gap Detection] Insufficient data: ${allTimestamps.length} total candles found`);
      return [];
    }

    console.log(`[Candle Gap Detection] Analyzing ${allTimestamps.length} total candles (${mysqlTimestamps.length} MySQL + ${redisTimestamps.length} Redis)`);

    const gaps: CandleGap[] = [];
    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    const minGapMs = minGapMinutes * 60 * 1000;
    const tolerance = 10 * 1000; // 10 second tolerance for timing variations

    // Iterate through consecutive timestamps
    for (let i = 0; i < allTimestamps.length - 1; i++) {
      const currentTime = allTimestamps[i];
      const nextTime = allTimestamps[i + 1];
      const gap = nextTime - currentTime;

      // Check if gap is larger than minimum threshold (with tolerance)
      if (gap > minGapMs + tolerance) {
        const durationMinutes = gap / (60 * 1000);
        const missingCandles = Math.floor(gap / FIVE_MINUTES_MS) - 1;

        if (missingCandles > 0) {
          gaps.push({
            start: currentTime,
            end: nextTime,
            durationMinutes,
            missingCandles,
          });

          console.log(
            `[Candle Gap Detection] Gap found: ${new Date(currentTime).toISOString()} to ${new Date(nextTime).toISOString()} ` +
            `(${durationMinutes.toFixed(1)} minutes, ${missingCandles} missing candles)`
          );
        }
      }
    }

    console.log(`[Candle Gap Detection] Found ${gaps.length} gaps`);
    return gaps;
  } catch (error) {
    console.error('[Candle Gap Detection] Error:', error);
    return [];
  }
}

/**
 * Get data range statistics for candles
 * Uses getCandleStats utility for efficient querying
 *
 * @param tokenAddress - The token address
 * @param poolId - The pool ID
 * @param timeframe - The timeframe (default: '5m')
 * @returns Data range with earliest, latest, and total count
 */
export async function getCandleDataRange(
  tokenAddress: string,
  poolId: string,
  timeframe: string = '5m'
): Promise<CandleDataRange> {
  try {
    const stats = await getCandleStats(tokenAddress, poolId, timeframe);

    return {
      earliest: stats.oldestTimestamp,
      latest: stats.newestTimestamp,
      totalCandles: stats.count,
    };
  } catch (error) {
    console.error('[Candle Gap Helper] Error getting data range:', error);
    return { earliest: null, latest: null, totalCandles: 0 };
  }
}

/**
 * Get pool metadata from an existing candle
 * This is used to populate pool info when generating new candles
 *
 * @param tokenAddress - The token address
 * @param poolId - The pool ID
 * @returns Pool metadata or null if no candles exist
 */
export async function getExistingCandleInfo(
  tokenAddress: string,
  poolId: string
): Promise<ExistingCandleInfo | null> {
  try {
    const candle = await KatanaCandle.findOne({
      where: {
        token_address: tokenAddress.toLowerCase(),
        pool_id: poolId.toLowerCase(),
        timeframe: '5m',
      },
      raw: true,
    });

    if (!candle) {
      console.log('[Candle Gap Helper] No existing candles found for metadata');
      return null;
    }

    return {
      pool_id: (candle as any).pool_id,
      pool_token0_address: (candle as any).pool_token0_address,
      pool_token0_symbol: (candle as any).pool_token0_symbol,
      pool_token1_address: (candle as any).pool_token1_address,
      pool_token1_symbol: (candle as any).pool_token1_symbol,
      pool_fee_tier: (candle as any).pool_fee_tier,
      is_token0: (candle as any).is_token0,
    };
  } catch (error) {
    console.error('[Candle Gap Helper] Error getting existing candle info:', error);
    return null;
  }
}
