// src/utils/katana/candleGeneration.ts

import type { ProcessedSwap, ExistingSwapInfo } from './types';

export interface Candle {
  timestamp: number; // milliseconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleForDB {
  token_address: string;
  pool_id: string;
  pool_token0_address: string;
  pool_token0_symbol: string;
  pool_token1_address: string;
  pool_token1_symbol: string;
  pool_fee_tier: number;
  is_token0: boolean;
  timeframe: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Generate 5-minute candles from processed swaps
 * Uses the SAME sqrt price calculation method as your frontend
 * 
 * @param swaps - Processed swaps with USD prices already calculated
 * @returns Array of 5-minute candles
 */
export function generateFiveMinuteCandles(swaps: ProcessedSwap[]): Candle[] {
  if (swaps.length === 0) {
    return [];
  }

  // Sort swaps by timestamp (oldest first for proper OHLC)
  const sortedSwaps = [...swaps].sort((a, b) => a.timestamp - b.timestamp);

  // Group swaps into 5-minute buckets
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  const buckets = new Map<number, ProcessedSwap[]>();

  for (const swap of sortedSwaps) {
    // Round down to nearest 5-minute interval
    const bucketTimestamp = Math.floor(swap.timestamp / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
    
    if (!buckets.has(bucketTimestamp)) {
      buckets.set(bucketTimestamp, []);
    }
    buckets.get(bucketTimestamp)!.push(swap);
  }

  // Convert buckets to OHLC candles
  const candles: Candle[] = [];

  for (const [timestamp, bucketSwaps] of buckets.entries()) {
    if (bucketSwaps.length === 0) continue;

    // Sort by timestamp within bucket
    bucketSwaps.sort((a, b) => a.timestamp - b.timestamp);

    // Calculate OHLC from sqrt prices (same as frontend)
    const open = bucketSwaps[0].tokenPriceUSD;
    const close = bucketSwaps[bucketSwaps.length - 1].tokenPriceUSD;
    const high = Math.max(...bucketSwaps.map(s => s.tokenPriceUSD));
    const low = Math.min(...bucketSwaps.map(s => s.tokenPriceUSD));
    const volume = bucketSwaps.reduce((sum, s) => sum + s.tokenVolumeUSD, 0);

    candles.push({
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  // Sort candles by timestamp (newest first for API response)
  candles.sort((a, b) => b.timestamp - a.timestamp);

  return candles;
}

/**
 * Convert candles to MySQL database format
 */
export function convertCandlesToModelFormat(
  candles: Candle[],
  existingSwap: ExistingSwapInfo,
  tokenAddress: string
): CandleForDB[] {
  const tokenAddr = tokenAddress.toLowerCase();
  
  return candles.map((candle) => ({
    token_address: tokenAddr,
    pool_id: existingSwap.pool_id,
    pool_token0_address: existingSwap.pool_token0_address,
    pool_token0_symbol: existingSwap.pool_token0_symbol,
    pool_token1_address: existingSwap.pool_token1_address,
    pool_token1_symbol: existingSwap.pool_token1_symbol,
    pool_fee_tier: existingSwap.pool_fee_tier,
    is_token0: existingSwap.is_token0,
    timeframe: '5m',
    timestamp: new Date(candle.timestamp),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }));
}

/**
 * Aggregate 5-minute candles to larger timeframes
 * 
 * @param candles - Array of 5-minute candles
 * @param timeframe - Target timeframe ('15m', '30m', '1h', '4h', '1d', '1w')
 * @returns Aggregated candles
 */
export function aggregateCandlesToTimeframe(
  candles: Candle[],
  timeframe: '15m' | '30m' | '1h' | '4h' | '1d' | '1w'
): Candle[] {
  if (candles.length === 0) return [];

  // Timeframe in milliseconds
  const timeframeMs: Record<string, number> = {
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
    '1w': 7 * 24 * 60 * 60 * 1000,
  };

  const intervalMs = timeframeMs[timeframe];

  // Sort candles by timestamp (oldest first)
  const sortedCandles = [...candles].sort((a, b) => a.timestamp - b.timestamp);

  // Group into timeframe buckets
  const buckets = new Map<number, Candle[]>();

  for (const candle of sortedCandles) {
    const bucketTimestamp = Math.floor(candle.timestamp / intervalMs) * intervalMs;
    
    if (!buckets.has(bucketTimestamp)) {
      buckets.set(bucketTimestamp, []);
    }
    buckets.get(bucketTimestamp)!.push(candle);
  }

  // Aggregate each bucket
  const aggregated: Candle[] = [];

  for (const [timestamp, bucketCandles] of buckets.entries()) {
    if (bucketCandles.length === 0) continue;

    // Sort by timestamp within bucket
    bucketCandles.sort((a, b) => a.timestamp - b.timestamp);

    const open = bucketCandles[0].open;
    const close = bucketCandles[bucketCandles.length - 1].close;
    const high = Math.max(...bucketCandles.map(c => c.high));
    const low = Math.min(...bucketCandles.map(c => c.low));
    const volume = bucketCandles.reduce((sum, c) => sum + c.volume, 0);

    aggregated.push({
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  // Sort by timestamp (newest first)
  aggregated.sort((a, b) => b.timestamp - a.timestamp);

  return aggregated;
}

/**
 * Merge new candles with existing candles, removing duplicates
 * Keeps the most recent version of each candle
 */
export function mergeCandles(
  existingCandles: Candle[],
  newCandles: Candle[]
): Candle[] {
  const candleMap = new Map<number, Candle>();

  // Add existing candles first
  for (const candle of existingCandles) {
    candleMap.set(candle.timestamp, candle);
  }

  // Add new candles (will overwrite any duplicates)
  for (const candle of newCandles) {
    candleMap.set(candle.timestamp, candle);
  }

  // Convert back to array and sort by timestamp (newest first)
  const mergedCandles = Array.from(candleMap.values());
  mergedCandles.sort((a, b) => b.timestamp - a.timestamp);

  return mergedCandles;
}