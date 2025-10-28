// src/controllers/katana/utils/redisOperations.ts

import { getValue, storeValue } from '../../redis/katanaTokens';
import { 
  FULL_SWAP_DATA_PREFIX, 
  FULL_SWAP_DATA_TTL, 
  UPDATE_LOCK_PREFIX, 
  UPDATE_LOCK_TTL,
  UPDATE_LOCK_TIMEOUT 
} from './constants';
import type { StoredSwapData, RedisSwapData } from './types';

/**
 * Load swap data from Redis cache
 * 
 * @param tokenAddress - Token address (lowercase)
 * @returns Stored swap data or null if not found/invalid
 */
export async function loadSwapDataFromRedis(tokenAddress: string): Promise<StoredSwapData | null> {
  try {
    const cacheKey = `${FULL_SWAP_DATA_PREFIX}${tokenAddress.toLowerCase()}`;
    console.log(`[Redis] Loading data from key: ${cacheKey}`);
    
    const cached = await getValue(cacheKey);
    
    if (!cached) {
      console.log(`[Redis] No cached data found`);
      return null;
    }

    const parsed = JSON.parse(cached) as StoredSwapData;
    
    // Validate the cached data structure
    if (!parsed.swaps || !Array.isArray(parsed.swaps)) {
      console.warn(`[Redis] Invalid cached data structure`);
      return null;
    }

    console.log(`[Redis] Found cached data:`, {
      swaps: parsed.swaps.length,
      lastUpdate: new Date(parsed.metadata.lastUpdate * 1000).toISOString(),
      pool: parsed.metadata.pool.id,
    });

    return parsed;
  } catch (error) {
    console.error('[Redis] Error loading data:', error);
    return null;
  }
}

/**
 * Load Redis swap data (simpler format used in appendHistorical)
 * 
 * @param tokenAddress - Token address (lowercase)
 * @returns Redis swap data or null if not found
 */
export async function loadRedisSwapData(tokenAddress: string): Promise<RedisSwapData | null> {
  try {
    const cacheKey = `${FULL_SWAP_DATA_PREFIX}${tokenAddress.toLowerCase()}`;
    console.log(`[Redis Fallback] Loading data from Redis key: ${cacheKey}`);
    
    const cached = await getValue(cacheKey);
    
    if (!cached) {
      console.log(`[Redis Fallback] No Redis data found`);
      return null;
    }

    const parsed = JSON.parse(cached) as RedisSwapData;
    
    if (!parsed.swaps || !Array.isArray(parsed.swaps)) {
      console.warn(`[Redis Fallback] Invalid Redis data structure`);
      return null;
    }

    console.log(`[Redis Fallback] Found Redis data:`, {
      swaps: parsed.swaps.length,
      poolId: parsed.metadata.pool.id,
      lastSwapTimestamp: new Date(parsed.metadata.lastSwapTimestamp).toISOString(),
    });

    return parsed;
  } catch (error) {
    console.error('[Redis Fallback] Error loading Redis data:', error);
    return null;
  }
}

/**
 * Save swap data to Redis cache
 * 
 * @param tokenAddress - Token address (lowercase)
 * @param data - Swap data to store
 * @returns Success status
 */
export async function saveSwapDataToRedis(
  tokenAddress: string,
  data: StoredSwapData
): Promise<boolean> {
  try {
    const cacheKey = `${FULL_SWAP_DATA_PREFIX}${tokenAddress.toLowerCase()}`;
    
    await storeValue(
      cacheKey,
      JSON.stringify(data),
      FULL_SWAP_DATA_TTL
    );
    
    console.log(`[Redis] Successfully saved ${data.swaps.length} swaps`);
    return true;
  } catch (error) {
    console.error(`[Redis] Failed to save data:`, error);
    return false;
  }
}

/**
 * Check if an update is currently in progress (lock exists)
 * 
 * @param tokenAddress - Token address (lowercase)
 * @returns True if locked, false otherwise
 */
export async function checkUpdateLock(tokenAddress: string): Promise<boolean> {
  try {
    const lockKey = `${UPDATE_LOCK_PREFIX}${tokenAddress.toLowerCase()}`;
    const lockValue = await getValue(lockKey);
    return lockValue !== null;
  } catch (error) {
    console.error('[Redis] Error checking update lock:', error);
    return false;
  }
}

/**
 * Set update lock to prevent concurrent updates
 * 
 * @param tokenAddress - Token address (lowercase)
 * @returns Success status
 */
export async function setUpdateLock(tokenAddress: string): Promise<boolean> {
  try {
    const lockKey = `${UPDATE_LOCK_PREFIX}${tokenAddress.toLowerCase()}`;
    const lockValue = Date.now().toString();
    
    await storeValue(lockKey, lockValue, UPDATE_LOCK_TTL);
    console.log(`[Redis] Set update lock for ${tokenAddress}`);
    return true;
  } catch (error) {
    console.error('[Redis] Error setting update lock:', error);
    return false;
  }
}

/**
 * Clear update lock (allow new updates)
 * 
 * @param tokenAddress - Token address (lowercase)
 */
export async function clearUpdateLock(tokenAddress: string): Promise<void> {
  try {
    const lockKey = `${UPDATE_LOCK_PREFIX}${tokenAddress.toLowerCase()}`;
    // Note: Redis deleteValue not implemented in the provided code
    // For now, set a very short TTL to effectively clear it
    await storeValue(lockKey, "", 1); // 1 second TTL
    console.log(`[Redis] Cleared update lock for ${tokenAddress}`);
  } catch (error) {
    console.warn('[Redis] Error clearing update lock:', error);
  }
}

/**
 * In-memory lock map for preventing concurrent updates
 * (Used as backup to Redis locks)
 */
const updateLocks = new Map<string, number>();

/**
 * Check in-memory update lock
 */
export function checkInMemoryLock(tokenAddress: string): boolean {
  const lockTime = updateLocks.get(tokenAddress.toLowerCase());
  
  if (!lockTime) {
    return false;
  }

  // Check if lock has expired
  if (Date.now() - lockTime > UPDATE_LOCK_TIMEOUT) {
    updateLocks.delete(tokenAddress.toLowerCase());
    return false;
  }

  return true;
}

/**
 * Set in-memory update lock
 */
export function setInMemoryLock(tokenAddress: string): void {
  updateLocks.set(tokenAddress.toLowerCase(), Date.now());
}

/**
 * Clear in-memory update lock
 */
export function clearInMemoryLock(tokenAddress: string): void {
  updateLocks.delete(tokenAddress.toLowerCase());
}