// src/controllers/katana/utils/dataFetching.ts

import axios from "axios";
import Bottleneck from "bottleneck";
import { 
  KATANA_SUBGRAPH_URL, 
  RATE_LIMITER_CONFIG, 
  MAX_SKIP_LIMIT, 
  MAX_SKIP_LIMIT_INCREMENTAL 
} from './constants';
import { 
  getPoolsByTVLQuery, 
  getSwapsQuery, 
  getHistoricalSwapsQuery 
} from './graphqlQueries';
import type { SwapData, Pool, SushiGraphResponse } from './types';

/**
 * Shared rate limiter instance for all subgraph requests
 */
export const sushiLimiter = new Bottleneck(RATE_LIMITER_CONFIG);

/**
 * Fetch pools containing a specific token, ordered by TVL
 * 
 * @param tokenAddress - Token address to search for
 * @returns Array of pools containing the token
 */
export async function fetchPoolsByTVL(tokenAddress: string): Promise<Pool[]> {
  const response = await sushiLimiter.schedule(() =>
    axios.post<SushiGraphResponse>(KATANA_SUBGRAPH_URL, {
      query: getPoolsByTVLQuery(),
      variables: { tokenAddress: tokenAddress.toLowerCase() },
    })
  );

  if (response.data.errors) {
    console.error("[Fetch Pools] GraphQL errors:", response.data.errors);
    throw new Error(`GraphQL error: ${JSON.stringify(response.data.errors)}`);
  }

  const pools = response.data.data?.pools || [];
  console.log(`[Fetch Pools] Found ${pools.length} pools for token ${tokenAddress}`);
  
  return pools;
}

/**
 * Fetch swaps for a specific pool in a time range
 * Handles pagination automatically with batching
 * 
 * @param poolId - Pool ID to fetch swaps from
 * @param startTime - Start time (Unix timestamp in seconds)
 * @param endTime - End time (Unix timestamp in seconds)
 * @param maxSwaps - Maximum total swaps to fetch (default 3000)
 * @param maxSkip - Maximum skip value (default from constants)
 * @returns Array of swap data
 */
export async function fetchSwaps(
  poolId: string,
  startTime: number,
  endTime: number,
  maxSwaps: number = 3000,
  maxSkip: number = MAX_SKIP_LIMIT_INCREMENTAL
): Promise<SwapData[]> {
  const allSwaps: SwapData[] = [];
  let skip = 0;
  const batchSize = 1000; // GraphQL first parameter

  console.log(`[Fetch Swaps] Starting fetch for pool ${poolId}`, {
    startTime: new Date(startTime * 1000).toISOString(),
    endTime: new Date(endTime * 1000).toISOString(),
    maxSwaps,
    maxSkip,
  });

  while (skip < maxSkip && allSwaps.length < maxSwaps) {
    const response = await sushiLimiter.schedule(() =>
      axios.post<SushiGraphResponse>(KATANA_SUBGRAPH_URL, {
        query: getSwapsQuery(),
        variables: {
          poolId: poolId.toLowerCase(),
          startTime,
          endTime,
          first: batchSize,
          skip,
        },
      })
    );

    if (response.data.errors) {
      console.error(`[Fetch Swaps] GraphQL errors at skip ${skip}:`, response.data.errors);
      throw new Error(`GraphQL error: ${JSON.stringify(response.data.errors)}`);
    }

    const batch = response.data.data?.swaps || [];
    
    if (batch.length === 0) {
      console.log(`[Fetch Swaps] No more swaps at skip ${skip}`);
      break;
    }

    allSwaps.push(...batch);
    skip += batchSize;

    console.log(`[Fetch Swaps] Batch complete: ${batch.length} swaps, total: ${allSwaps.length}`);

    // Stop if we've fetched enough
    if (allSwaps.length >= maxSwaps) {
      console.log(`[Fetch Swaps] Reached max swaps limit: ${maxSwaps}`);
      break;
    }

    // Stop if batch was smaller than expected (no more data)
    if (batch.length < batchSize) {
      console.log(`[Fetch Swaps] Received partial batch, no more data available`);
      break;
    }
  }

  console.log(`[Fetch Swaps] Fetch complete: ${allSwaps.length} total swaps`);
  return allSwaps;
}

/**
 * Fetch historical swaps (older than a specific timestamp)
 * Used for appending historical data
 * 
 * @param poolId - Pool ID to fetch swaps from
 * @param olderThan - Timestamp to fetch older swaps (Unix timestamp in seconds)
 * @param maxSwaps - Maximum total swaps to fetch
 * @param maxSkip - Maximum skip value (default from constants)
 * @returns Array of historical swap data
 */
export async function fetchHistoricalSwaps(
  poolId: string,
  olderThan: number,
  maxSwaps: number = 6000,
  maxSkip: number = MAX_SKIP_LIMIT
): Promise<SwapData[]> {
  const allSwaps: SwapData[] = [];
  let skip = 0;
  const batchSize = 1000;

  console.log(`[Fetch Historical] Starting for pool ${poolId}`, {
    olderThan: new Date(olderThan * 1000).toISOString(),
    maxSwaps,
    maxSkip,
  });

  while (skip < maxSkip && allSwaps.length < maxSwaps) {
    const response = await sushiLimiter.schedule(() =>
      axios.post<SushiGraphResponse>(KATANA_SUBGRAPH_URL, {
        query: getHistoricalSwapsQuery(),
        variables: {
          poolId: poolId.toLowerCase(),
          olderThan,
          first: batchSize,
          skip,
        },
      })
    );

    if (response.data.errors) {
      console.error(`[Fetch Historical] GraphQL errors at skip ${skip}:`, response.data.errors);
      throw new Error(`GraphQL error: ${JSON.stringify(response.data.errors)}`);
    }

    const batch = response.data.data?.swaps || [];

    if (batch.length === 0) {
      console.log(`[Fetch Historical] No more swaps at skip ${skip}`);
      break;
    }

    allSwaps.push(...batch);
    skip += batchSize;

    console.log(`[Fetch Historical] Batch complete: ${batch.length} swaps, total: ${allSwaps.length}`);

    if (allSwaps.length >= maxSwaps) {
      console.log(`[Fetch Historical] Reached max swaps limit: ${maxSwaps}`);
      break;
    }

    if (batch.length < batchSize) {
      console.log(`[Fetch Historical] Received partial batch, no more data available`);
      break;
    }
  }

  console.log(`[Fetch Historical] Fetch complete: ${allSwaps.length} total swaps`);
  return allSwaps;
}