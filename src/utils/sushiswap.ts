// src/utils/sushiswap.ts
import type { SwapData, SwapDataV2, SwapDataV3, ProcessedSwap, Pool, PoolV3, PairV2, NormalizedPool, TokenInfo } from "../types/sushiswap";
import { FULL_DATA_DAYS, UPDATE_INTERVAL_HOURS } from "../config/sushiswap";

/**
 * Calculate time range for data retrieval
 */
export function getFullTimeRange(): { startTime: number; endTime: number } {
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - (FULL_DATA_DAYS * 24 * 60 * 60);
  return { startTime, endTime };
}

/**
 * Calculate incremental time range (only new data since last update)
 */
export function getIncrementalTimeRange(lastSwapTimestamp: number): { startTime: number; endTime: number } {
  const endTime = Math.floor(Date.now() / 1000);
  // Start from last swap + 1 second to avoid duplicates
  const startTime = lastSwapTimestamp + 1;
  return { startTime, endTime };
}

/**
 * Type guards for swap data
 */
export function isSwapDataV3(swap: SwapData): swap is SwapDataV3 {
  return 'pool' in swap;
}

export function isSwapDataV2(swap: SwapData): swap is SwapDataV2 {
  return 'pair' in swap;
}

/**
 * Type guards for pool data
 */
export function isPoolV3(pool: Pool): pool is PoolV3 {
  return 'feeTier' in pool && 'totalValueLockedUSD' in pool;
}

export function isPairV2(pool: Pool): pool is PairV2 {
  return 'reserveUSD' in pool && !('feeTier' in pool);
}

/**
 * Normalize pool/pair data to common interface
 */
export function normalizePool(pool: Pool): NormalizedPool {
  if (isPoolV3(pool)) {
    return {
      id: pool.id,
      token0: pool.token0,
      token1: pool.token1,
      feeTier: pool.feeTier,
      tvlUSD: pool.totalValueLockedUSD,
      volumeUSD: pool.volumeUSD,
      version: 'v3'
    };
  } else if (isPairV2(pool)) {
    return {
      id: pool.id,
      token0: pool.token0,
      token1: pool.token1,
      tvlUSD: pool.reserveUSD,
      volumeUSD: pool.volumeUSD,
      version: 'v2'
    };
  }
  
  throw new Error('Unknown pool type');
}

/**
 * Extract token info from swap data regardless of version
 */
export function extractTokensFromSwap(swap: SwapData): { token0: TokenInfo; token1: TokenInfo } {
  if (isSwapDataV3(swap)) {
    return {
      token0: swap.token0,
      token1: swap.token1
    };
  } else if (isSwapDataV2(swap)) {
    return {
      token0: swap.pair.token0,
      token1: swap.pair.token1
    };
  }
  
  throw new Error('Unknown swap data type');
}

/**
 * Process raw swaps into our format (version agnostic)
 */
export function processSwaps(rawSwaps: SwapData[], tokenAddress: string, isToken0: boolean): ProcessedSwap[] {
  return rawSwaps.map(swap => ({
    id: swap.id,
    timestamp: parseInt(swap.timestamp) * 1000, // Convert to milliseconds
    tokenPriceUSD: isToken0 
      ? parseFloat(swap.token0PriceUSD || "0")
      : parseFloat(swap.token1PriceUSD || "0"),
    tokenVolumeUSD: isToken0
      ? parseFloat(swap.amount0USD || "0") 
      : parseFloat(swap.amount1USD || "0"),
    totalVolumeUSD: parseFloat(swap.amountUSD || "0"),
  }));
}

/**
 * Merge new swaps with existing data, removing duplicates
 */
export function mergeSwaps(existingSwaps: ProcessedSwap[], newSwaps: ProcessedSwap[]): ProcessedSwap[] {
  const swapMap = new Map<string, ProcessedSwap>();
  
  // Add existing swaps
  for (const swap of existingSwaps) {
    swapMap.set(swap.id, swap);
  }
  
  // Add new swaps (will overwrite duplicates)
  for (const swap of newSwaps) {
    swapMap.set(swap.id, swap);
  }
  
  // Convert back to array and sort by timestamp
  const mergedSwaps = Array.from(swapMap.values());
  mergedSwaps.sort((a, b) => a.timestamp - b.timestamp);
  
  return mergedSwaps;
}

/**
 * Check if we need to update data (every hour)
 */
export function needsUpdate(lastUpdate: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const hoursSinceUpdate = (now - lastUpdate) / 3600;
  return hoursSinceUpdate >= UPDATE_INTERVAL_HOURS;
}

/**
 * Validate token address format
 */
export function validateTokenAddress(address: string): boolean {
  return /^0x[a-f0-9]{40}$/i.test(address);
}

/**
 * Validate days parameter
 */
export function validateDays(days: string): { isValid: boolean; daysNum?: number } {
  const daysNum = parseInt(days);
  if (isNaN(daysNum) || daysNum < 1 || daysNum > 365) {
    return { isValid: false };
  }
  return { isValid: true, daysNum };
}

/**
 * Convert token address to appropriate format for the version
 */
export function formatTokenAddress(address: string, version: 'v2' | 'v3'): string {
  // V2 uses Bytes format, V3 uses String format
  // Both should work with lowercase hex addresses
  return address.toLowerCase();
}

/**
 * Get appropriate query variables based on version
 */
export function getQueryVariables(
  poolId: string,
  startTime: number,
  endTime: number,
  first: number,
  skip: number,
  version: 'v2' | 'v3'
): Record<string, any> {
  if (version === 'v3') {
    return {
      poolId,
      startTime,
      endTime,
      first,
      skip,
    };
  } else {
    return {
      pairId: poolId,
      startTime: startTime.toString(),
      endTime: endTime.toString(),
      first,
      skip,
    };
  }
}