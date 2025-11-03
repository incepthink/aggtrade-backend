// src/jobs/updateProactiveCandlesJob.ts
// Description: Cron job to proactively update candle data for whitelisted tokens every 5 minutes

import cron from 'node-cron';
import { PROACTIVE_TOKENS } from '../utils/katana/constants';
import { 
  fetchPoolsByTVL, 
  selectBestPool, 
  fetchSwaps,
  processSwaps,
  getIncrementalTimeRange,
} from '../utils/katana/index';
import {
  generateFiveMinuteCandles,
  mergeCandles,
  convertCandlesToModelFormat,
  type Candle,
} from '../utils/katana/candleGeneration';
import {
  loadCandleDataFromRedis,
  saveCandleDataToRedis,
  type StoredCandleData,
} from '../utils/katana/redisCandleOperations';
import {
  bulkInsertCandles,
} from '../utils/katana/candleOperations';

import { getExistingSwapInfo } from '../utils/katana/index';

/**
 * Update candles for a single proactive token
 */
async function updateTokenCandles(tokenAddress: string): Promise<{
  success: boolean;
  tokenAddress: string;
  newCandles: number;
  totalCandles: number;
  error?: string;
}> {
  try {
    const normalizedAddress = tokenAddress.toLowerCase();
    console.log(`[Proactive Candles] Processing token: ${normalizedAddress}`);

    // Load existing cached data
    const storedData = await loadCandleDataFromRedis(normalizedAddress, '5m');

    let selectedPool;
    let allCandles: Candle[] = storedData?.candles || [];

    // Fetch pools and select best one
    const pools = await fetchPoolsByTVL(normalizedAddress);

    if (!pools || pools.length === 0) {
      console.log(`[Proactive Candles] No pools found for ${normalizedAddress}`);
      return {
        success: false,
        tokenAddress: normalizedAddress,
        newCandles: 0,
        totalCandles: 0,
        error: 'No pools found',
      };
    }

    selectedPool = selectBestPool(pools, normalizedAddress);

    console.log(`[Proactive Candles] Selected pool:`, {
      poolId: selectedPool.id,
      pair: `${selectedPool.token0.symbol}/${selectedPool.token1.symbol}`,
    });

    const isToken0 = selectedPool.token0.id.toLowerCase() === normalizedAddress;
    const baseToken = isToken0 ? selectedPool.token0 : selectedPool.token1;
    const quoteToken = isToken0 ? selectedPool.token1 : selectedPool.token0;

    // Fetch new swaps (incremental if we have existing data)
    let newSwaps;
    if (storedData?.metadata.lastCandleTimestamp) {
      const { startTime, endTime } = getIncrementalTimeRange(
        Math.floor(storedData.metadata.lastCandleTimestamp / 1000)
      );
      console.log(`[Proactive Candles] Incremental fetch from ${new Date(startTime * 1000).toISOString()}`);
      newSwaps = await fetchSwaps(selectedPool.id, startTime, endTime);
    } else {
      console.log(`[Proactive Candles] First-time full fetch for ${normalizedAddress}`);
      const now = Math.floor(Date.now() / 1000);
      const startTime = now - (365 * 24 * 60 * 60); // 1 year back
      newSwaps = await fetchSwaps(selectedPool.id, startTime, now);
    }

    // Process swaps and generate 5m candles
    const processedSwaps = processSwaps(newSwaps, isToken0);
    const newCandles = generateFiveMinuteCandles(processedSwaps);

    console.log(`[Proactive Candles] Generated ${newCandles.length} new candles from ${processedSwaps.length} swaps`);

    // Merge with existing candles
    const existingCandles = storedData?.candles || [];
    allCandles = mergeCandles(existingCandles, newCandles);

    console.log(`[Proactive Candles] Merged: ${existingCandles.length} existing + ${newCandles.length} new = ${allCandles.length} total`);

    // Prepare updated stored data
    const now = Math.floor(Date.now() / 1000);
    const lastCandleTimestamp = allCandles.length > 0
      ? Math.max(...allCandles.map(c => c.timestamp))
      : now * 1000;

    const updatedStoredData: StoredCandleData = {
      candles: allCandles,
      metadata: {
        token: {
          address: baseToken.id,
          name: baseToken.name,
          symbol: baseToken.symbol,
          decimals: baseToken.decimals,
        },
        pool: {
          id: selectedPool.id,
          address: selectedPool.id,
          token0: selectedPool.token0,
          token1: selectedPool.token1,
          feeTier: selectedPool.feeTier,
          totalValueLockedUSD: parseFloat(selectedPool.totalValueLockedUSD),
          volumeUSD: parseFloat(selectedPool.volumeUSD),
        },
        isToken0,
        quoteToken,
        lastUpdate: now,
        lastCandleTimestamp,
        dataRange: {
          start: allCandles.length > 0 ? Math.min(...allCandles.map(c => c.timestamp)) : now * 1000,
          end: lastCandleTimestamp,
        },
        chain: "katana",
        dexId: "katana-sushiswap",
        timeframe: '5m',
      },
    };

    // Save to Redis
    await saveCandleDataToRedis(normalizedAddress, updatedStoredData, '5m');

    // Save new candles to MySQL
    if (newCandles.length > 0) {
      const existingSwapInfo = await getExistingSwapInfo(normalizedAddress);
      if (existingSwapInfo) {
        const candlesForDB = convertCandlesToModelFormat(newCandles, existingSwapInfo, normalizedAddress);
        await bulkInsertCandles(candlesForDB);
        console.log(`[Proactive Candles] Saved ${candlesForDB.length} candles to MySQL`);
      }
    }

    return {
      success: true,
      tokenAddress: normalizedAddress,
      newCandles: newCandles.length,
      totalCandles: allCandles.length,
    };

  } catch (error: any) {
    console.error(`[Proactive Candles] Error processing ${tokenAddress}:`, error.message);
    return {
      success: false,
      tokenAddress,
      newCandles: 0,
      totalCandles: 0,
      error: error.message,
    };
  }
}

/**
 * Main cron job function - updates all proactive tokens
 */
export async function runProactiveCandlesUpdate(): Promise<void> {
  const startTime = Date.now();
  console.log('\n===========================================');
  console.log(`[Proactive Candles Cron] Starting update at ${new Date().toISOString()}`);
  console.log('===========================================\n');

  try {
    if (PROACTIVE_TOKENS.length === 0) {
      console.log('[Proactive Candles Cron] No proactive tokens configured');
      return;
    }

    console.log(`[Proactive Candles Cron] Updating ${PROACTIVE_TOKENS.length} tokens:`, PROACTIVE_TOKENS);

    // Process all tokens in parallel (they're independent)
    const results = await Promise.allSettled(
      PROACTIVE_TOKENS.map(tokenAddress => updateTokenCandles(tokenAddress))
    );

    // Summary
    let successCount = 0;
    let errorCount = 0;
    let totalNewCandles = 0;

    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.success) {
        successCount++;
        totalNewCandles += result.value.newCandles;
        console.log(`[Proactive Candles Cron] ✓ ${result.value.tokenAddress}: ${result.value.newCandles} new candles (${result.value.totalCandles} total)`);
      } else {
        errorCount++;
        const error = result.status === 'fulfilled' ? result.value.error : (result as any).reason;
        console.error(`[Proactive Candles Cron] ✗ ${PROACTIVE_TOKENS[index]}: ${error}`);
      }
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n===========================================');
    console.log('[Proactive Candles Cron] Update Complete');
    console.log(`[Proactive Candles Cron] Duration: ${duration}s`);
    console.log(`[Proactive Candles Cron] Tokens processed: ${PROACTIVE_TOKENS.length}`);
    console.log(`[Proactive Candles Cron] Success: ${successCount}`);
    console.log(`[Proactive Candles Cron] Errors: ${errorCount}`);
    console.log(`[Proactive Candles Cron] Total new candles: ${totalNewCandles}`);
    console.log('===========================================\n');

  } catch (error: any) {
    console.error('[Proactive Candles Cron] Fatal error:', error.message);
  }
}

// /**
//  * Setup cron schedule - runs every 5 minutes
//  * Pattern: */5 * * * * = At every 5th minute
//  */
export function startProactiveCandlesCron(): void {
  const cronPattern = '*/5 * * * *';

  console.log('[Proactive Candles Cron] Setting up with pattern:', cronPattern);
  
  cron.schedule(cronPattern, async () => {
    console.log('[Proactive Candles Cron] Triggered at:', new Date().toISOString());
    await runProactiveCandlesUpdate();
  });

  console.log('[Proactive Candles Cron] Scheduled successfully');
  console.log('[Proactive Candles Cron] Will run every 5 minutes');
}

/**
 * Manual trigger for testing
 */
export async function triggerProactiveCandlesManually(): Promise<void> {
  console.log('[Proactive Candles Cron] Manual trigger initiated');
  await runProactiveCandlesUpdate();
}

// Auto-start when file is imported
console.log('[Proactive Candles Cron] Starting proactive candles updater...');
startProactiveCandlesCron();

// Optional: Run immediately on startup
// (async () => {
//   console.log('[Proactive Candles Cron] Running initial update...\n');
//   await runProactiveCandlesUpdate();
// })();