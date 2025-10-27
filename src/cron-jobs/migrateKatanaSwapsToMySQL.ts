// File: src/jobs/migrateKatanaSwapsToMySQL.ts
// Description: Cron job to migrate old swap data from Redis to MySQL, keeping only 3000 newest swaps in Redis

import cron from 'node-cron';
import { getValue, storeValue } from '../redis/katanaTokens';
import { bulkInsertSwapsToMySQL } from './utils/katanaMySQLHelpers';

// Constants
const FULL_SWAP_DATA_PREFIX = 'full_swaps_katana_';
const MAX_REDIS_SWAPS = 3000; // Keep only 3000 newest swaps in Redis
const FULL_SWAP_DATA_TTL = 365 * 24 * 60 * 60; // 365 days

interface ProcessedSwap {
  id: string;
  timestamp: number;
  tokenPriceUSD: number;
  tokenVolumeUSD: number;
  totalVolumeUSD: number;
}

interface StoredSwapData {
  swaps: ProcessedSwap[];
  metadata: {
    token: {
      address: string;
      name: string;
      symbol: string;
      decimals: string;
    };
    pool: {
      id: string;
      address: string;
      token0: any;
      token1: any;
      feeTier: string;
      totalValueLockedUSD: number;
      volumeUSD: number;
    };
    isToken0: boolean;
    quoteToken: any;
    lastUpdate: number;
    lastSwapTimestamp: number;
    dataRange: {
      start: number;
      end: number;
    };
    chain: string;
    dexId: string;
  };
}

/**
 * Get all Redis keys matching the pattern
 */
async function getAllKatanaTokenKeys(): Promise<string[]> {
  try {
    // Import your Redis instance
    const { redis } = await import('../redis/katanaTokens');
    
    const keys: string[] = [];
    let cursor = '0';
    const pattern = `${FULL_SWAP_DATA_PREFIX}*`;

    do {
      // ioredis SCAN syntax
      const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      
      cursor = result[0];
      keys.push(...result[1]);

    } while (cursor !== '0');

    console.log(`[Migration Cron] Found ${keys.length} keys matching pattern: ${pattern}`);
    return keys;
  } catch (error) {
    console.error('[Migration Cron] Error getting Redis keys:', error);
    return [];
  }
}

/**
 * Process a single token's data migration
 */
async function migrateTokenData(tokenKey: string): Promise<{
  success: boolean;
  tokenAddress: string;
  swapsMigrated: number;
  swapsKeptInRedis: number;
  error?: string;
}> {
  try {
    const tokenAddress = tokenKey.replace(FULL_SWAP_DATA_PREFIX, '');
    console.log(`[Migration Cron] Processing token: ${tokenAddress}`);

    // Load data from Redis
    const redisData = await getValue(tokenKey);
    
    if (!redisData) {
      console.log(`[Migration Cron] No data found for ${tokenAddress}`);
      return {
        success: false,
        tokenAddress,
        swapsMigrated: 0,
        swapsKeptInRedis: 0,
        error: 'No data in Redis'
      };
    }

    const storedData: StoredSwapData = JSON.parse(redisData);
    const allSwaps = storedData.swaps || [];

    console.log(`[Migration Cron] Token ${tokenAddress}: Found ${allSwaps.length} swaps`);

    // Check if migration is needed
    if (allSwaps.length <= MAX_REDIS_SWAPS) {
      console.log(`[Migration Cron] Token ${tokenAddress}: Within limit, no migration needed`);
      return {
        success: true,
        tokenAddress,
        swapsMigrated: 0,
        swapsKeptInRedis: allSwaps.length
      };
    }

    // Sort by timestamp DESC (newest first)
    allSwaps.sort((a, b) => b.timestamp - a.timestamp);

    // Split: Keep newest in Redis, migrate rest to MySQL
    const swapsToKeepInRedis = allSwaps.slice(0, MAX_REDIS_SWAPS);
    const swapsToMigrateToMySQL = allSwaps.slice(MAX_REDIS_SWAPS);

    console.log(`[Migration Cron] Token ${tokenAddress}: Migrating ${swapsToMigrateToMySQL.length} swaps to MySQL`);

    // Migrate old swaps to MySQL
    const migrationResult = await bulkInsertSwapsToMySQL(
      swapsToMigrateToMySQL,
      tokenAddress,
      storedData.metadata.pool.id,
      storedData.metadata.isToken0,
      {
        token0: storedData.metadata.pool.token0,
        token1: storedData.metadata.pool.token1,
        feeTier: storedData.metadata.pool.feeTier
      }
    );

    console.log(`[Migration Cron] Token ${tokenAddress}: MySQL insert result:`, migrationResult);

    // Update Redis with only newest swaps
    const updatedStoredData: StoredSwapData = {
      ...storedData,
      swaps: swapsToKeepInRedis,
      metadata: {
        ...storedData.metadata,
        lastUpdate: Math.floor(Date.now() / 1000),
        dataRange: {
          start: swapsToKeepInRedis.length > 0 
            ? Math.min(...swapsToKeepInRedis.map(s => s.timestamp))
            : storedData.metadata.dataRange.start,
          end: swapsToKeepInRedis.length > 0
            ? Math.max(...swapsToKeepInRedis.map(s => s.timestamp))
            : storedData.metadata.dataRange.end
        }
      }
    };

    // Save updated data back to Redis
    await storeValue(tokenKey, JSON.stringify(updatedStoredData), FULL_SWAP_DATA_TTL);

    console.log(`[Migration Cron] Token ${tokenAddress}: Successfully updated Redis with ${swapsToKeepInRedis.length} swaps`);

    return {
      success: true,
      tokenAddress,
      swapsMigrated: migrationResult.inserted,
      swapsKeptInRedis: swapsToKeepInRedis.length
    };

  } catch (error: any) {
    console.error(`[Migration Cron] Error processing token ${tokenKey}:`, error);
    return {
      success: false,
      tokenAddress: tokenKey.replace(FULL_SWAP_DATA_PREFIX, ''),
      swapsMigrated: 0,
      swapsKeptInRedis: 0,
      error: error.message
    };
  }
}

/**
 * Main migration job function
 */
export async function runMigrationJob(): Promise<void> {
  const startTime = Date.now();
  console.log('[Migration Cron] ===== Starting Katana Swaps Migration Job =====');
  console.log('[Migration Cron] Time:', new Date().toISOString());

  try {
    // Get all token keys from Redis
    const tokenKeys = await getAllKatanaTokenKeys();
    console.log(`[Migration Cron] Found ${tokenKeys.length} tokens to check`);

    if (tokenKeys.length === 0) {
      console.log('[Migration Cron] No tokens found, job complete');
      return;
    }

    // Process each token
    const results = await Promise.allSettled(
      tokenKeys.map(key => migrateTokenData(key))
    );

    // Summary
    let totalMigrated = 0;
    let successCount = 0;
    let errorCount = 0;

    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.success) {
        successCount++;
        totalMigrated += result.value.swapsMigrated;
        
        if (result.value.swapsMigrated > 0) {
          console.log(`[Migration Cron] ✓ ${result.value.tokenAddress}: Migrated ${result.value.swapsMigrated} swaps`);
        }
      } else {
        errorCount++;
        const error = result.status === 'fulfilled' ? result.value.error : (result as any).reason;
        console.error(`[Migration Cron] ✗ ${tokenKeys[index]}: Failed - ${error}`);
      }
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('[Migration Cron] ===== Migration Job Complete =====');
    console.log(`[Migration Cron] Duration: ${duration}s`);
    console.log(`[Migration Cron] Tokens processed: ${tokenKeys.length}`);
    console.log(`[Migration Cron] Success: ${successCount}`);
    console.log(`[Migration Cron] Errors: ${errorCount}`);
    console.log(`[Migration Cron] Total swaps migrated: ${totalMigrated}`);

  } catch (error) {
    console.error('[Migration Cron] Fatal error in migration job:', error);
  }
}

/**
 * Setup cron schedule
 * Runs every 1 hour at minute 0
 */
export function startMigrationCron(): void {
  // Cron pattern: Every 1 hour at :00
  // 0 * * * * = At minute 0 past every hour
  const cronPattern = '0 * * * *';

  console.log('[Migration Cron] Setting up cron job with pattern:', cronPattern);
  
  cron.schedule(cronPattern, async () => {
    console.log('[Migration Cron] Triggered at:', new Date().toISOString());
    await runMigrationJob();
  });

  console.log('[Migration Cron] Cron job scheduled successfully');
  console.log('[Migration Cron] Will run every 1 hour');
}

/**
 * Manual trigger function for testing
 */
export async function triggerMigrationManually(): Promise<void> {
  console.log('[Migration Cron] Manual trigger initiated');
  await runMigrationJob();
}