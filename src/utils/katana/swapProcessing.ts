// src/controllers/katana/utils/swapProcessing.ts

import { calculateTokenUSDPrice } from './priceCalculations';
import type { SwapData, ProcessedSwap, ExistingSwapInfo } from './types';

/**
 * Process raw swap data from subgraph into ProcessedSwap format
 * 
 * @param rawSwaps - Raw swap data from SushiSwap subgraph
 * @param isToken0 - Whether the target token is token0 in the pool
 * @returns Array of processed swaps
 */
export function processSwaps(rawSwaps: SwapData[], isToken0: boolean): ProcessedSwap[] {
  return rawSwaps.map((swap) => {
    const correctTokenPrice = calculateTokenUSDPrice(swap, isToken0);
    
    return {
      id: swap.id,
      timestamp: parseInt(swap.timestamp, 10) * 1000, // sec -> ms
      tokenPriceUSD: correctTokenPrice,
      tokenVolumeUSD: isToken0
        ? Math.abs(parseFloat(swap.amount0USD || "0"))
        : Math.abs(parseFloat(swap.amount1USD || "0")),
      totalVolumeUSD: parseFloat(swap.amountUSD || "0"),
    };
  });
}

/**
 * Merge new swaps with existing swaps, removing duplicates
 * Keeps the most recent version of each swap
 * 
 * @param existingSwaps - Existing swaps
 * @param newSwaps - New swaps to merge
 * @returns Merged and deduplicated array sorted by timestamp (newest first)
 */
export function mergeSwaps(
  existingSwaps: ProcessedSwap[],
  newSwaps: ProcessedSwap[]
): ProcessedSwap[] {
  const swapMap = new Map<string, ProcessedSwap>();
  
  // Add existing swaps first
  for (const swap of existingSwaps) {
    swapMap.set(swap.id, swap);
  }
  
  // Add new swaps (will overwrite any duplicates)
  for (const swap of newSwaps) {
    swapMap.set(swap.id, swap);
  }
  
  // Convert back to array and sort by timestamp (newest first)
  const mergedSwaps = Array.from(swapMap.values());
  mergedSwaps.sort((a, b) => b.timestamp - a.timestamp); // DESC order
  
  return mergedSwaps;
}

/**
 * Merge Redis swaps with MySQL historical swaps
 * MySQL data is typically older, Redis data is newer
 * 
 * @param redisSwaps - Swaps from Redis cache
 * @param mysqlSwaps - Historical swaps from MySQL
 * @returns Merged and deduplicated array sorted by timestamp (newest first)
 */
export function mergeWithHistoricalSwaps(
  redisSwaps: ProcessedSwap[], 
  mysqlSwaps: ProcessedSwap[]
): ProcessedSwap[] {
  const swapMap = new Map<string, ProcessedSwap>();
  
  // Add MySQL swaps first (older data)
  for (const swap of mysqlSwaps) {
    swapMap.set(swap.id, swap);
  }
  
  // Add Redis swaps (newer data) - will overwrite any duplicates
  for (const swap of redisSwaps) {
    swapMap.set(swap.id, swap);
  }
  
  // Convert back to array and sort by timestamp (newest first)
  const mergedSwaps = Array.from(swapMap.values());
  mergedSwaps.sort((a, b) => b.timestamp - a.timestamp); // DESC order
  
  console.log(`[Merge] MySQL: ${mysqlSwaps.length}, Redis: ${redisSwaps.length}, Total: ${mergedSwaps.length}`);
  
  return mergedSwaps;
}

/**
 * Convert ProcessedSwap format to MySQL KatanaSwap model format
 * 
 * @param processedSwaps - Processed swap data
 * @param existingSwap - Existing swap info for pool metadata
 * @param tokenAddress - Token address being processed
 * @returns Array of objects ready for MySQL insertion
 */
export function convertToModelFormat(
  processedSwaps: ProcessedSwap[],
  existingSwap: ExistingSwapInfo,
  tokenAddress: string
): any[] {
  const tokenAddr = tokenAddress.toLowerCase();
  return processedSwaps.map((swap) => ({
    id: swap.id,
    pool_id: existingSwap.pool_id,
    pool_token0_address: existingSwap.pool_token0_address,
    pool_token0_symbol: existingSwap.pool_token0_symbol,
    pool_token1_address: existingSwap.pool_token1_address,
    pool_token1_symbol: existingSwap.pool_token1_symbol,
    pool_fee_tier: existingSwap.pool_fee_tier,
    token_address: tokenAddr,
    is_token0: existingSwap.is_token0,
    timestamp: new Date(swap.timestamp),
    block_number: 0, // not provided by some queries
    token_price_usd: swap.tokenPriceUSD,
    token_volume_usd: swap.tokenVolumeUSD,
    total_volume_usd: swap.totalVolumeUSD,
    tx_hash: swap.id.split("-")[0], // txhash-logIndex format
  }));
}

/**
 * Filter swaps by time range
 * 
 * @param swaps - Swaps to filter
 * @param startTime - Start time (Unix timestamp in seconds)
 * @param endTime - End time (Unix timestamp in seconds), optional
 * @returns Filtered swaps
 */
export function filterSwapsByTimeRange(
  swaps: ProcessedSwap[],
  startTime: number,
  endTime?: number
): ProcessedSwap[] {
  return swaps.filter(swap => {
    const swapTimeSec = swap.timestamp / 1000;
    const afterStart = swapTimeSec >= startTime;
    const beforeEnd = endTime ? swapTimeSec <= endTime : true;
    return afterStart && beforeEnd;
  });
}

/**
 * Get swap statistics from an array of swaps
 */
export function getSwapStats(swaps: ProcessedSwap[]) {
  if (swaps.length === 0) {
    return {
      count: 0,
      oldestTimestamp: null,
      newestTimestamp: null,
      totalVolume: 0,
      avgPrice: 0,
    };
  }

  const timestamps = swaps.map(s => s.timestamp);
  const totalVolume = swaps.reduce((sum, s) => sum + s.tokenVolumeUSD, 0);
  const avgPrice = swaps.reduce((sum, s) => sum + s.tokenPriceUSD, 0) / swaps.length;

  return {
    count: swaps.length,
    oldestTimestamp: Math.min(...timestamps),
    newestTimestamp: Math.max(...timestamps),
    totalVolume,
    avgPrice,
  };
}