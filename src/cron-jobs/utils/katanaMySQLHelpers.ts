// File: src/utils/katanaMySQLHelpers.ts
// Description: Helper functions for MySQL operations - bulk insert, gap detection, and backfill

import KatanaSwap from '../../models/KatanaSwap';
import { Op } from 'sequelize';

interface ProcessedSwap {
  id: string;
  timestamp: number;
  tokenPriceUSD: number;
  tokenVolumeUSD: number;
  totalVolumeUSD: number;
}

interface BulkInsertResult {
  inserted: number;
  duplicates: number;
  errors: number;
}

/**
 * Bulk insert processed swaps into MySQL
 * Handles deduplication and error cases
 * 
 * Note: You need to pass pool metadata (token0, token1, feeTier) from StoredSwapData
 */
export async function bulkInsertSwapsToMySQL(
  swaps: ProcessedSwap[],
  tokenAddress: string,
  poolId: string,
  isToken0: boolean,
  poolMetadata?: {
    token0: { id: string; symbol: string };
    token1: { id: string; symbol: string };
    feeTier: string;
  }
): Promise<BulkInsertResult> {
  if (!swaps || swaps.length === 0) {
    return { inserted: 0, duplicates: 0, errors: 0 };
  }

  try {
    console.log(`[MySQL Helper] Starting bulk insert: ${swaps.length} swaps for token ${tokenAddress}`);

    // Convert ProcessedSwap format to MySQL model format
    const mysqlRecords = swaps.map(swap => ({
      id: swap.id,
      timestamp: new Date(swap.timestamp), // Convert milliseconds to Date
      token_address: tokenAddress.toLowerCase(),
      pool_id: poolId.toLowerCase(),
      is_token0: isToken0,
      token_price_usd: swap.tokenPriceUSD,
      token_volume_usd: swap.tokenVolumeUSD,
      total_volume_usd: swap.totalVolumeUSD,
      // Required fields from KatanaSwap model
      pool_token0_address: poolMetadata?.token0?.id?.toLowerCase() || 'unknown',
      pool_token0_symbol: poolMetadata?.token0?.symbol || 'UNKNOWN',
      pool_token1_address: poolMetadata?.token1?.id?.toLowerCase() || 'unknown',
      pool_token1_symbol: poolMetadata?.token1?.symbol || 'UNKNOWN',
      pool_fee_tier: parseInt(poolMetadata?.feeTier || '3000'),
      block_number: 0, // You'll need to add this to ProcessedSwap or fetch separately
      tx_hash: swap.id.split('#')[0] || swap.id, // Extract tx hash from swap id if formatted as "txHash#logIndex"
    }));

    // Bulk insert with ignoreDuplicates to handle existing records
    const result = await KatanaSwap.bulkCreate(mysqlRecords, {
      ignoreDuplicates: true, // Skip records with duplicate primary keys
      validate: true,
      logging: false // Set to true for debugging
    });

    const insertedCount = result.length;
    const duplicateCount = mysqlRecords.length - insertedCount;

    console.log(`[MySQL Helper] Bulk insert complete:`, {
      attempted: mysqlRecords.length,
      inserted: insertedCount,
      duplicates: duplicateCount
    });

    return {
      inserted: insertedCount,
      duplicates: duplicateCount,
      errors: 0
    };

  } catch (error: any) {
    console.error('[MySQL Helper] Error in bulk insert:', error);
    
    // Try individual inserts as fallback
    console.log('[MySQL Helper] Attempting fallback: individual inserts');
    return await fallbackIndividualInserts(swaps, tokenAddress, poolId, isToken0, poolMetadata);
  }
}

/**
 * Fallback: Insert swaps one by one if bulk insert fails
 */
async function fallbackIndividualInserts(
  swaps: ProcessedSwap[],
  tokenAddress: string,
  poolId: string,
  isToken0: boolean,
  poolMetadata?: {
    token0: { id: string; symbol: string };
    token1: { id: string; symbol: string };
    feeTier: string;
  }
): Promise<BulkInsertResult> {
  let inserted = 0;
  let duplicates = 0;
  let errors = 0;

  for (const swap of swaps) {
    try {
      const [record, created] = await KatanaSwap.findOrCreate({
        where: { id: swap.id },
        defaults: {
          id: swap.id,
          timestamp: new Date(swap.timestamp),
          token_address: tokenAddress.toLowerCase(),
          pool_id: poolId.toLowerCase(),
          is_token0: isToken0,
          token_price_usd: swap.tokenPriceUSD,
          token_volume_usd: swap.tokenVolumeUSD,
          total_volume_usd: swap.totalVolumeUSD,
          // Required fields
          pool_token0_address: poolMetadata?.token0?.id?.toLowerCase() || 'unknown',
          pool_token0_symbol: poolMetadata?.token0?.symbol || 'UNKNOWN',
          pool_token1_address: poolMetadata?.token1?.id?.toLowerCase() || 'unknown',
          pool_token1_symbol: poolMetadata?.token1?.symbol || 'UNKNOWN',
          pool_fee_tier: parseInt(poolMetadata?.feeTier || '3000'),
          block_number: 0,
          tx_hash: swap.id.split('#')[0] || swap.id,
        }
      });

      if (created) {
        inserted++;
      } else {
        duplicates++;
      }
    } catch (error) {
      console.error(`[MySQL Helper] Error inserting swap ${swap.id}:`, error);
      errors++;
    }
  }

  console.log(`[MySQL Helper] Fallback insert complete:`, {
    inserted,
    duplicates,
    errors
  });

  return { inserted, duplicates, errors };
}

/**
 * Get all unique timestamps for a token from MySQL (for gap detection)
 */
export async function getTokenTimestamps(tokenAddress: string): Promise<number[]> {
  try {
    const swaps = await KatanaSwap.findAll({
      attributes: ['timestamp'],
      where: {
        token_address: tokenAddress.toLowerCase()
      },
      order: [['timestamp', 'ASC']],
      raw: true
    });

    return swaps.map(swap => (swap as any).timestamp.getTime());
  } catch (error) {
    console.error('[MySQL Helper] Error getting timestamps:', error);
    return [];
  }
}

/**
 * Detect gaps in timestamp data (24+ hour jumps)
 */
export interface Gap {
  start: number; // Unix timestamp (seconds)
  end: number;   // Unix timestamp (seconds)
  durationHours: number;
}

export async function detectGaps(
  tokenAddress: string,
  minGapHours: number = 24
): Promise<Gap[]> {
  try {
    console.log(`[MySQL Helper] Detecting gaps for token ${tokenAddress}`);

    const timestamps = await getTokenTimestamps(tokenAddress);

    if (timestamps.length < 2) {
      console.log(`[MySQL Helper] Not enough data to detect gaps (found ${timestamps.length} swaps)`);
      return [];
    }

    const gaps: Gap[] = [];
    const minGapMs = minGapHours * 60 * 60 * 1000;

    for (let i = 0; i < timestamps.length - 1; i++) {
      const current = timestamps[i];
      const next = timestamps[i + 1];
      const gap = next - current;

      if (gap > minGapMs) {
        const durationHours = gap / (60 * 60 * 1000);
        gaps.push({
          start: Math.floor(current / 1000), // Convert to seconds
          end: Math.floor(next / 1000),
          durationHours: Math.round(durationHours * 100) / 100 // Round to 2 decimals
        });
      }
    }

    console.log(`[MySQL Helper] Found ${gaps.length} gaps (${minGapHours}+ hours)`);
    gaps.forEach((gap, index) => {
      console.log(`[MySQL Helper] Gap ${index + 1}: ${new Date(gap.start * 1000).toISOString()} → ${new Date(gap.end * 1000).toISOString()} (${gap.durationHours} hours)`);
    });

    return gaps;

  } catch (error) {
    console.error('[MySQL Helper] Error detecting gaps:', error);
    return [];
  }
}

/**
 * Get total swap count for a token in MySQL
 */
export async function getTokenSwapCount(tokenAddress: string): Promise<number> {
  try {
    const count = await KatanaSwap.count({
      where: {
        token_address: tokenAddress.toLowerCase()
      }
    });
    return count;
  } catch (error) {
    console.error('[MySQL Helper] Error getting swap count:', error);
    return 0;
  }
}

/**
 * Get date range of data for a token in MySQL
 */
export async function getTokenDataRange(tokenAddress: string): Promise<{
  earliest: Date | null;
  latest: Date | null;
  totalSwaps: number;
}> {
  try {
    const swaps = await KatanaSwap.findAll({
      attributes: ['timestamp'],
      where: {
        token_address: tokenAddress.toLowerCase()
      },
      order: [['timestamp', 'ASC']],
      raw: true
    });

    if (swaps.length === 0) {
      return { earliest: null, latest: null, totalSwaps: 0 };
    }

    return {
      earliest: (swaps[0] as any).timestamp,
      latest: (swaps[swaps.length - 1] as any).timestamp,
      totalSwaps: swaps.length
    };

  } catch (error) {
    console.error('[MySQL Helper] Error getting data range:', error);
    return { earliest: null, latest: null, totalSwaps: 0 };
  }
}

/**
 * Delete old swaps beyond a certain date (cleanup utility)
 */
export async function deleteOldSwaps(
  tokenAddress: string,
  beforeDate: Date
): Promise<number> {
  try {
    console.log(`[MySQL Helper] Deleting swaps before ${beforeDate.toISOString()} for token ${tokenAddress}`);

    const deletedCount = await KatanaSwap.destroy({
      where: {
        token_address: tokenAddress.toLowerCase(),
        timestamp: {
          [Op.lt]: beforeDate
        }
      }
    });

    console.log(`[MySQL Helper] Deleted ${deletedCount} old swaps`);
    return deletedCount;

  } catch (error) {
    console.error('[MySQL Helper] Error deleting old swaps:', error);
    return 0;
  }
}