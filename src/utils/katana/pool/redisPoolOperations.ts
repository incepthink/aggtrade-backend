import { getValue, storeValue } from '../../../redis/katanaTokens';
import type { ProcessedPool } from '../types';

const POOLS_CACHE_KEY = "pools_katana_all";
const POOLS_CACHE_TTL = 6 * 60 * 60; // 6 hours in seconds

export interface StoredPoolsData {
  pools: ProcessedPool[];
  metadata: {
    lastUpdate: number;
    count: number;
    chain: string;
  };
}

/**
 * Load pools data from Redis cache
 */
export async function loadPoolsDataFromRedis(): Promise<StoredPoolsData | null> {
  try {
    console.log(`[Redis Pools] Loading from key: ${POOLS_CACHE_KEY}`);

    const cached = await getValue(POOLS_CACHE_KEY);

    if (!cached) {
      console.log(`[Redis Pools] No cached data found`);
      return null;
    }

    const parsed = JSON.parse(cached) as StoredPoolsData;

    if (!parsed.pools || !Array.isArray(parsed.pools)) {
      console.warn(`[Redis Pools] Invalid cached data structure`);
      return null;
    }

    console.log(`[Redis Pools] Found cached data:`, {
      pools: parsed.pools.length,
      lastUpdate: new Date(parsed.metadata.lastUpdate * 1000).toISOString(),
    });

    return parsed;
  } catch (error) {
    console.error('[Redis Pools] Error loading data:', error);
    return null;
  }
}

/**
 * Save pools data to Redis cache
 */
export async function savePoolsDataToRedis(
  pools: ProcessedPool[]
): Promise<boolean> {
  try {
    const data: StoredPoolsData = {
      pools,
      metadata: {
        lastUpdate: Math.floor(Date.now() / 1000),
        count: pools.length,
        chain: "katana",
      },
    };

    await storeValue(
      POOLS_CACHE_KEY,
      JSON.stringify(data),
      POOLS_CACHE_TTL
    );

    console.log(`[Redis Pools] Successfully saved ${pools.length} pools`);
    return true;
  } catch (error) {
    console.error(`[Redis Pools] Failed to save data:`, error);
    return false;
  }
}

/**
 * Check if cached data needs update (older than 6 hours)
 */
export function needsPoolsUpdate(lastUpdate: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const age = now - lastUpdate;
  const needsUpdate = age > POOLS_CACHE_TTL;

  console.log(`[Redis Pools] Cache age: ${age}s, needs update: ${needsUpdate}`);
  return needsUpdate;
}