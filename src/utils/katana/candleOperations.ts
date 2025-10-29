// src/utils/katana/candleOperations.ts

import KatanaCandle from '../../models/KatanaCandle';
import sequelize from '../../utils/db/sequelize';
import { Op, Transaction } from 'sequelize';
import type { Candle, CandleForDB } from './candleGeneration';

/**
 * Load candles from MySQL for a specific token and time range
 */
export async function loadCandlesFromMySQL(
  tokenAddress: string,
  poolId: string,
  startTime: number, // Unix timestamp in seconds
  timeframe: string = '5m'
): Promise<Candle[]> {
  try {
    console.log(`[MySQL Candles] Loading ${timeframe} candles for token ${tokenAddress}`);

    const candles = await KatanaCandle.findAll({
      attributes: ['timestamp', 'open', 'high', 'low', 'close', 'volume'],
      where: {
        token_address: tokenAddress.toLowerCase(),
        pool_id: poolId.toLowerCase(),
        timeframe,
        timestamp: {
          [Op.gte]: new Date(startTime * 1000)
        }
      },
      order: [['timestamp', 'DESC']],
      raw: true
    });

    console.log(`[MySQL Candles] Found ${candles.length} candles`);

    // Convert to Candle format
    return candles.map((c: any) => ({
      timestamp: c.timestamp.getTime(),
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume),
    }));
  } catch (error) {
    console.error('[MySQL Candles] Error loading candles:', error);
    return [];
  }
}

/**
 * Bulk insert candles into MySQL with transaction handling
 */
export async function bulkInsertCandles(
  candles: CandleForDB[]
): Promise<{ success: boolean; count: number; error?: any }> {
  let transaction: Transaction | null = null;

  try {
    transaction = await sequelize.transaction();

    await KatanaCandle.bulkCreate(candles, {
      transaction,
      ignoreDuplicates: true, // Skip duplicates based on unique index
    });

    await transaction.commit();

    console.log(`[MySQL Candles] Successfully inserted ${candles.length} candles`);

    return { success: true, count: candles.length };
  } catch (error: any) {
    if (transaction) {
      await transaction.rollback();
    }

    console.error('[MySQL Candles] Error inserting candles:', error);
    return { success: false, count: 0, error };
  }
}

/**
 * Get candle statistics for a token
 */
export async function getCandleStats(tokenAddress: string, poolId: string, timeframe: string = '5m') {
  const [count, oldestCandle, newestCandle] = await Promise.all([
    KatanaCandle.count({
      where: {
        token_address: tokenAddress.toLowerCase(),
        pool_id: poolId.toLowerCase(),
        timeframe,
      },
    }),
    KatanaCandle.findOne({
      attributes: ['timestamp'],
      where: {
        token_address: tokenAddress.toLowerCase(),
        pool_id: poolId.toLowerCase(),
        timeframe,
      },
      order: [['timestamp', 'ASC']],
      raw: true,
    }) as Promise<{ timestamp: Date } | null>,
    KatanaCandle.findOne({
      attributes: ['timestamp'],
      where: {
        token_address: tokenAddress.toLowerCase(),
        pool_id: poolId.toLowerCase(),
        timeframe,
      },
      order: [['timestamp', 'DESC']],
      raw: true,
    }) as Promise<{ timestamp: Date } | null>,
  ]);

  return {
    count,
    oldestTimestamp: oldestCandle?.timestamp || null,
    newestTimestamp: newestCandle?.timestamp || null,
  };
}

/**
 * Check if any candles exist for a token
 */
export async function hasExistingCandles(tokenAddress: string, timeframe: string = '5m'): Promise<boolean> {
  const count = await KatanaCandle.count({
    where: {
      token_address: tokenAddress.toLowerCase(),
      timeframe,
    },
  });
  return count > 0;
}

/**
 * Get oldest candle timestamp for a token
 */
export async function getOldestCandleTimestamp(
  tokenAddress: string,
  timeframe: string = '5m'
): Promise<Date | null> {
  const oldestCandle = await KatanaCandle.findOne({
    attributes: ['timestamp'],
    where: {
      token_address: tokenAddress.toLowerCase(),
      timeframe,
    },
    order: [['timestamp', 'ASC']],
    raw: true,
  }) as { timestamp: Date } | null;

  return oldestCandle?.timestamp || null;
}