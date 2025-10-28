// src/controllers/katana/utils/poolSelection.ts

import { USDC_KATANA, AUSD_KATANA } from './constants';
import type { Pool } from './types';

/**
 * Select the best pool for a token using priority scoring
 * 
 * Priority order:
 * 1. Pools with stablecoins (USDC > AUSD)
 * 2. Highest TVL within same category
 * 
 * @param pools - Array of pools to choose from
 * @param tokenAddress - Target token address (normalized lowercase)
 * @returns Best pool for the token
 */
export function selectBestPool(pools: Pool[], tokenAddress: string): Pool {
  if (pools.length === 0) {
    throw new Error("No pools provided for selection");
  }

  if (pools.length === 1) {
    return pools[0];
  }

  const normalizedToken = tokenAddress.toLowerCase();

  // Separate pools by category
  const usdcPools: Pool[] = [];
  const ausdPools: Pool[] = [];
  const otherPools: Pool[] = [];

  for (const pool of pools) {
    const token0Lower = pool.token0.id.toLowerCase();
    const token1Lower = pool.token1.id.toLowerCase();
    
    // Skip if target token is in both positions (shouldn't happen)
    if (token0Lower === normalizedToken && token1Lower === normalizedToken) {
      continue;
    }
    
    const otherTokenAddress = 
      token0Lower === normalizedToken ? token1Lower : token0Lower;

    if (otherTokenAddress === USDC_KATANA) {
      usdcPools.push(pool);
    } else if (otherTokenAddress === AUSD_KATANA) {
      ausdPools.push(pool);
    } else {
      otherPools.push(pool);
    }
  }

  // Sort each category by TVL (descending)
  const sortByTVL = (a: Pool, b: Pool) => 
    parseFloat(b.totalValueLockedUSD) - parseFloat(a.totalValueLockedUSD);

  usdcPools.sort(sortByTVL);
  ausdPools.sort(sortByTVL);
  otherPools.sort(sortByTVL);

  // Priority: USDC > AUSD > Others (all sorted by TVL)
  const selectedPool = 
    usdcPools[0] || 
    ausdPools[0] || 
    otherPools[0];

  if (!selectedPool) {
    throw new Error("No suitable pool found after filtering");
  }

  console.log(`[Pool Selection] Selected pool:`, {
    poolId: selectedPool.id,
    pair: `${selectedPool.token0.symbol}/${selectedPool.token1.symbol}`,
    tvl: selectedPool.totalValueLockedUSD,
    category: usdcPools.includes(selectedPool) ? 'USDC' : 
              ausdPools.includes(selectedPool) ? 'AUSD' : 'Other',
  });

  return selectedPool;
}

/**
 * Check if a pool contains a specific token
 */
export function poolContainsToken(pool: Pool, tokenAddress: string): boolean {
  const normalized = tokenAddress.toLowerCase();
  return (
    pool.token0.id.toLowerCase() === normalized ||
    pool.token1.id.toLowerCase() === normalized
  );
}

/**
 * Get the other token in a pool (the one that's not the target token)
 */
export function getOtherToken(pool: Pool, tokenAddress: string): Pool['token0'] | Pool['token1'] {
  const normalized = tokenAddress.toLowerCase();
  if (pool.token0.id.toLowerCase() === normalized) {
    return pool.token1;
  }
  return pool.token0;
}

/**
 * Check if a pool has a stablecoin
 */
export function hasStablecoin(pool: Pool): boolean {
  const token0Lower = pool.token0.id.toLowerCase();
  const token1Lower = pool.token1.id.toLowerCase();
  return (
    token0Lower === USDC_KATANA ||
    token0Lower === AUSD_KATANA ||
    token1Lower === USDC_KATANA ||
    token1Lower === AUSD_KATANA
  );
}

/**
 * Score a pool based on multiple factors
 * Higher score = better pool
 */
export function scorePool(pool: Pool, tokenAddress: string): number {
  let score = 0;
  const normalized = tokenAddress.toLowerCase();
  const otherToken = getOtherToken(pool, normalized);
  const otherTokenLower = otherToken.id.toLowerCase();

  // Base score from TVL (normalized)
  const tvl = parseFloat(pool.totalValueLockedUSD);
  score += Math.log10(tvl + 1) * 10; // Log scale to prevent dominance

  // Stablecoin bonus
  if (otherTokenLower === USDC_KATANA) {
    score += 100; // Highest priority
  } else if (otherTokenLower === AUSD_KATANA) {
    score += 80; // Second priority
  }

  // Volume bonus
  const volume = parseFloat(pool.volumeUSD);
  score += Math.log10(volume + 1) * 5;

  return score;
}