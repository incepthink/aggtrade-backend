// src/controllers/katana/utils/mysqlOperations.ts

import { KatanaSwap } from '../../models';
import sequelize from '../db/sequelize';
import { Op, Transaction } from 'sequelize';
import type { ProcessedSwap, ExistingSwapInfo, MySQLSwapResult } from './types';

/**
 * Load historical swaps from MySQL for a specific token and pool
 * 
 * @param tokenAddress - Token address (lowercase)
 * @param poolId - Pool ID (lowercase)
 * @param startTime - Start time (Unix timestamp in seconds)
 * @returns Array of processed swaps
 */
export async function loadHistoricalSwapsFromMySQL(
  tokenAddress: string,
  poolId: string,
  startTime: number
): Promise<ProcessedSwap[]> {
  try {
    console.log(`[MySQL] Loading swaps for token ${tokenAddress}, pool ${poolId}`);
    
    const historicalSwaps = await KatanaSwap.findAll({
      attributes: [
        'id',
        'timestamp',
        'token_price_usd',
        'token_volume_usd',
        'total_volume_usd'
      ],
      where: {
        token_address: tokenAddress.toLowerCase(),
        pool_id: poolId.toLowerCase(),
        timestamp: {
          [Op.gte]: new Date(startTime * 1000) // Convert to Date for MySQL
        }
      },
      order: [['timestamp', 'DESC']],
      raw: true
    });

    console.log(`[MySQL] Found ${historicalSwaps.length} historical swaps`);

    // Convert MySQL data to ProcessedSwap format
    const processedSwaps: ProcessedSwap[] = (historicalSwaps as MySQLSwapResult[]).map(swap => ({
      id: swap.id,
      timestamp: swap.timestamp.getTime(), // Convert Date to milliseconds
      tokenPriceUSD: parseFloat(swap.token_price_usd.toString()),
      tokenVolumeUSD: parseFloat(swap.token_volume_usd.toString()),
      totalVolumeUSD: parseFloat(swap.total_volume_usd.toString()),
    }));

    return processedSwaps;
  } catch (error) {
    console.error('[MySQL] Error loading historical swaps:', error);
    return []; // Return empty array on error to not break the main flow
  }
}

/**
 * Get the oldest swap timestamp for a token
 * 
 * @param tokenAddress - Token address (lowercase)
 * @returns Oldest swap timestamp as Date, or null if no swaps found
 */
export async function getOldestSwapTimestamp(tokenAddress: string): Promise<Date | null> {
  const oldestSwap = await KatanaSwap.findOne({
    attributes: ["timestamp"],
    where: { token_address: tokenAddress.toLowerCase() },
    order: [["timestamp", "ASC"]],
    raw: true,
  }) as { timestamp: Date } | null;

  return oldestSwap?.timestamp || null;
}

/**
 * Get existing swap info (pool metadata) for a token
 * 
 * @param tokenAddress - Token address (lowercase)
 * @returns Existing swap info or null if not found
 */
export async function getExistingSwapInfo(tokenAddress: string): Promise<ExistingSwapInfo | null> {
  const existingSwap = await KatanaSwap.findOne({
    attributes: [
      "pool_id",
      "pool_token0_address",
      "pool_token0_symbol",
      "pool_token1_address",
      "pool_token1_symbol",
      "pool_fee_tier",
      "is_token0",
    ],
    where: { token_address: tokenAddress.toLowerCase() },
    raw: true,
  }) as ExistingSwapInfo | null;

  return existingSwap;
}

/**
 * Get count of existing swaps for a token
 * 
 * @param tokenAddress - Token address (lowercase)
 * @returns Count of swaps
 */
export async function getSwapCount(tokenAddress: string): Promise<number> {
  return await KatanaSwap.count({
    where: { token_address: tokenAddress.toLowerCase() },
  });
}

/**
 * Bulk insert swaps into MySQL with transaction handling
 * 
 * @param swaps - Array of swap objects ready for insertion
 * @returns Success status and number of swaps inserted
 */
export async function bulkInsertSwaps(
  swaps: any[]
): Promise<{ success: boolean; count: number; error?: any }> {
  let transaction: Transaction | null = null;
  
  try {
    transaction = await sequelize.transaction();
    
    await KatanaSwap.bulkCreate(swaps, {
      transaction,
      ignoreDuplicates: true,
    });

    await transaction.commit();
    
    console.log(`[MySQL] Successfully inserted ${swaps.length} swaps`);
    
    return { success: true, count: swaps.length };
  } catch (error: any) {
    if (transaction) {
      await transaction.rollback();
    }
    
    console.error('[MySQL] Error inserting swaps:', error);
    return { success: false, count: 0, error };
  }
}

/**
 * Get swap statistics for a token and pool
 * 
 * @param tokenAddress - Token address (lowercase)
 * @param poolId - Pool ID (lowercase)
 * @returns Statistics about the swaps
 */
export async function getSwapStats(tokenAddress: string, poolId: string) {
  const [count, oldestSwap, newestSwap] = await Promise.all([
    KatanaSwap.count({
      where: { 
        token_address: tokenAddress.toLowerCase(),
        pool_id: poolId.toLowerCase()
      },
    }),
    KatanaSwap.findOne({
      attributes: ["timestamp"],
      where: { 
        token_address: tokenAddress.toLowerCase(),
        pool_id: poolId.toLowerCase()
      },
      order: [["timestamp", "ASC"]],
      raw: true,
    }) as Promise<{ timestamp: Date } | null>,
    KatanaSwap.findOne({
      attributes: ["timestamp"],
      where: { 
        token_address: tokenAddress.toLowerCase(),
        pool_id: poolId.toLowerCase()
      },
      order: [["timestamp", "DESC"]],
      raw: true,
    }) as Promise<{ timestamp: Date } | null>,
  ]);

  return {
    count,
    oldestTimestamp: oldestSwap?.timestamp || null,
    newestTimestamp: newestSwap?.timestamp || null,
  };
}

/**
 * Check if any swaps exist for a token
 * 
 * @param tokenAddress - Token address (lowercase)
 * @returns True if swaps exist, false otherwise
 */
export async function hasExistingSwaps(tokenAddress: string): Promise<boolean> {
  const count = await getSwapCount(tokenAddress);
  return count > 0;
}