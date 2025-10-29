// src/utils/katana/redisCandleOperations.ts

import { getValue, storeValue } from '../../redis/katanaTokens';
import { FULL_SWAP_DATA_TTL } from './constants';
import type { Candle } from './candleGeneration';

const CANDLE_DATA_PREFIX = "candles_katana_";

export interface StoredCandleData {
  candles: Candle[];
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
    lastCandleTimestamp: number;
    dataRange: {
      start: number;
      end: number;
    };
    chain: string;
    dexId: string;
    timeframe: string;
  };
}

/**
 * Load candle data from Redis cache
 */
export async function loadCandleDataFromRedis(
  tokenAddress: string,
  timeframe: string = '5m'
): Promise<StoredCandleData | null> {
  try {
    const cacheKey = `${CANDLE_DATA_PREFIX}${tokenAddress.toLowerCase()}_${timeframe}`;
    console.log(`[Redis Candles] Loading from key: ${cacheKey}`);

    const cached = await getValue(cacheKey);

    if (!cached) {
      console.log(`[Redis Candles] No cached data found`);
      return null;
    }

    const parsed = JSON.parse(cached) as StoredCandleData;

    if (!parsed.candles || !Array.isArray(parsed.candles)) {
      console.warn(`[Redis Candles] Invalid cached data structure`);
      return null;
    }

    console.log(`[Redis Candles] Found cached data:`, {
      candles: parsed.candles.length,
      lastUpdate: new Date(parsed.metadata.lastUpdate * 1000).toISOString(),
      pool: parsed.metadata.pool.id,
    });

    return parsed;
  } catch (error) {
    console.error('[Redis Candles] Error loading data:', error);
    return null;
  }
}

/**
 * Save candle data to Redis cache
 */
export async function saveCandleDataToRedis(
  tokenAddress: string,
  data: StoredCandleData,
  timeframe: string = '5m'
): Promise<boolean> {
  try {
    const cacheKey = `${CANDLE_DATA_PREFIX}${tokenAddress.toLowerCase()}_${timeframe}`;

    await storeValue(
      cacheKey,
      JSON.stringify(data),
      FULL_SWAP_DATA_TTL
    );

    console.log(`[Redis Candles] Successfully saved ${data.candles.length} candles`);
    return true;
  } catch (error) {
    console.error(`[Redis Candles] Failed to save data:`, error);
    return false;
  }
}