// File: src/redis/redisKeyScanner.ts
// Description: Redis utilities for scanning and managing Katana swap keys

import type Redis from 'ioredis';

/**
 * Scan Redis for all keys matching a pattern (ioredis version)
 * Uses SCAN instead of KEYS to avoid blocking Redis
 */
export async function scanRedisKeys(
  pattern: string,
  redisClient: Redis
): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';

  try {
    do {
      // ioredis SCAN syntax: scan(cursor, 'MATCH', pattern, 'COUNT', count)
      const result = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      
      cursor = result[0];
      keys.push(...result[1]);

    } while (cursor !== '0');

    console.log(`[Redis Scanner] Found ${keys.length} keys matching pattern: ${pattern}`);
    return keys;

  } catch (error) {
    console.error('[Redis Scanner] Error scanning keys:', error);
    return [];
  }
}

/**
 * Get all Katana swap data keys from Redis
 */
export async function getAllKatanaSwapKeys(
  redisClient: Redis,
  prefix: string = 'full_swaps_katana_'
): Promise<string[]> {
  const pattern = `${prefix}*`;
  return await scanRedisKeys(pattern, redisClient);
}

/**
 * Check if a specific key exists in Redis
 */
export async function keyExists(
  key: string,
  redisClient: Redis
): Promise<boolean> {
  try {
    const exists = await redisClient.exists(key);
    return exists === 1;
  } catch (error) {
    console.error(`[Redis Scanner] Error checking key existence for ${key}:`, error);
    return false;
  }
}

/**
 * Get TTL (time to live) for a key
 */
export async function getKeyTTL(
  key: string,
  redisClient: Redis
): Promise<number> {
  try {
    const ttl = await redisClient.ttl(key);
    return ttl;
  } catch (error) {
    console.error(`[Redis Scanner] Error getting TTL for ${key}:`, error);
    return -1;
  }
}

/**
 * Delete a key from Redis
 */
export async function deleteKey(
  key: string,
  redisClient: Redis
): Promise<boolean> {
  try {
    const result = await redisClient.del(key);
    return result === 1;
  } catch (error) {
    console.error(`[Redis Scanner] Error deleting key ${key}:`, error);
    return false;
  }
}

/**
 * Get memory usage for a specific key (in bytes)
 */
export async function getKeyMemoryUsage(
  key: string,
  redisClient: Redis
): Promise<number | null> {
  try {
    const memory = await redisClient.memory('USAGE', key);
    return memory;
  } catch (error) {
    console.error(`[Redis Scanner] Error getting memory usage for ${key}:`, error);
    return null;
  }
}

/**
 * Get statistics about all Katana swap keys
 */
export async function getKatanaKeysStats(
  redisClient: Redis
): Promise<{
  totalKeys: number;
  totalMemoryBytes: number;
  avgMemoryBytes: number;
  keys: Array<{ key: string; memoryBytes: number; ttl: number }>;
}> {
  try {
    const keys = await getAllKatanaSwapKeys(redisClient);
    const stats = {
      totalKeys: keys.length,
      totalMemoryBytes: 0,
      avgMemoryBytes: 0,
      keys: [] as Array<{ key: string; memoryBytes: number; ttl: number }>
    };

    for (const key of keys) {
      const memory = await getKeyMemoryUsage(key, redisClient);
      const ttl = await getKeyTTL(key, redisClient);
      
      if (memory !== null) {
        stats.totalMemoryBytes += memory;
        stats.keys.push({
          key,
          memoryBytes: memory,
          ttl
        });
      }
    }

    stats.avgMemoryBytes = stats.totalKeys > 0 
      ? Math.round(stats.totalMemoryBytes / stats.totalKeys)
      : 0;

    return stats;

  } catch (error) {
    console.error('[Redis Scanner] Error getting key stats:', error);
    return {
      totalKeys: 0,
      totalMemoryBytes: 0,
      avgMemoryBytes: 0,
      keys: []
    };
  }
}

/**
 * Simple KEYS command (NOT RECOMMENDED FOR PRODUCTION)
 * Use only for development/testing with small datasets
 * In production, always use SCAN instead
 */
export async function getKeysSimple(
  pattern: string,
  redisClient: Redis
): Promise<string[]> {
  try {
    console.warn('[Redis Scanner] WARNING: Using KEYS command (blocking operation)');
    const keys = await redisClient.keys(pattern);
    return keys;
  } catch (error) {
    console.error('[Redis Scanner] Error with KEYS command:', error);
    return [];
  }
}