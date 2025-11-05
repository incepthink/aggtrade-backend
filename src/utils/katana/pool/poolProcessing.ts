import type { PoolWithMetrics, ProcessedPool } from '../types';
import { KATANA_CHAIN_ID } from '../constants';

/**
 * Calculate percentage change between two values
 */
function calculateChange(current: number, previous: number): number {
  if (previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

/**
 * Calculate APR from daily fees and TVL
 * APR = (daily fees / TVL) * 365 * 100
 */
function calculateAPR(dailyFeesUSD: number, tvlUSD: number): number {
  if (tvlUSD === 0) return 0;
  return (dailyFeesUSD / tvlUSD) * 365 * 100;
}

/**
 * Process raw pool data into frontend format
 * @param pool - Raw pool data from subgraph
 * @param tokenLogos - Map of token address to logo URI
 */
export function processPool(
  pool: PoolWithMetrics,
  tokenLogos?: Map<string, string | null>
): ProcessedPool {
  // Parse current values
  const currentTVL = parseFloat(pool.totalValueLockedUSD);
  const feeTier = parseFloat(pool.feeTier);
  
  // Get sorted day data (newest first)
  const dayData = [...pool.poolDayData].sort((a, b) => b.date - a.date);
  
  // Use index 1 (yesterday) for complete 24h data instead of index 0 (today's incomplete)
  const yesterday = dayData[1];
  const dayBefore = dayData[2];
  
  // Last complete 24h metrics (yesterday's data)
  const volumeUSD1d = yesterday ? parseFloat(yesterday.volumeUSD) : 0;
  const yesterdayTVL = yesterday ? parseFloat(yesterday.tvlUSD) : currentTVL;
  const txCount1d = yesterday ? parseInt(yesterday.txCount) : 0;
  
  // Day before yesterday for 24h change calculation
  const dayBeforeVolume = dayBefore ? parseFloat(dayBefore.volumeUSD) : 0;
  const dayBeforeTVL = dayBefore ? parseFloat(dayBefore.tvlUSD) : yesterdayTVL;
  
  // Calculate 7-day volume (sum of last 7 complete days, starting from yesterday)
  const volumeUSD1w = dayData
    .slice(1, 8) // Skip today (index 0), use indices 1-7
    .reduce((sum, day) => sum + parseFloat(day.volumeUSD), 0);
  
  // Calculate 7-day volume change (compare yesterday to 8 days ago)
  const eightDaysAgo = dayData[8];
  const eightDaysAgoVolume = eightDaysAgo ? parseFloat(eightDaysAgo.volumeUSD) : 0;
  
  // Calculate daily fees from yesterday's complete volume
  const dailyFeesUSD = volumeUSD1d * (feeTier / 1_000_000);
  
  // Calculate APR using yesterday's complete data
  const totalApr1d = calculateAPR(dailyFeesUSD, yesterdayTVL);
  
  // Get logo URIs from map (if provided)
  const token0LogoUri = tokenLogos?.get(pool.token0.id.toLowerCase()) ?? null;
  const token1LogoUri = tokenLogos?.get(pool.token1.id.toLowerCase()) ?? null;
  
  return {
    id: pool.id,
    address: pool.id,
    name: `${pool.token0.symbol}/${pool.token1.symbol}`,
    token0Address: pool.token0.id,
    token1Address: pool.token1.id,
    token0Symbol: pool.token0.symbol,
    token1Symbol: pool.token1.symbol,
    token0Name: pool.token0.name,
    token1Name: pool.token1.name,
    token0LogoUri,
    token1LogoUri,
    swapFee: feeTier / 1_000_000, // Convert to decimal (e.g., 3000 -> 0.003)
    protocol: 'SUSHISWAP_V3',
    chainId: KATANA_CHAIN_ID,
    
    // Current metrics (using yesterday's complete data)
    liquidityUSD: currentTVL,
    volumeUSD1d,
    volumeUSD1w,
    txCount1d, // Yesterday's complete transaction count only
    
    // Changes (comparing complete days)
    liquidityUSDChange1d: calculateChange(yesterdayTVL, dayBeforeTVL),
    volumeUSDChange1d: calculateChange(volumeUSD1d, dayBeforeVolume),
    volumeUSDChange1w: calculateChange(volumeUSD1d, eightDaysAgoVolume),
    
    // APR (from yesterday's complete data)
    totalApr1d,
  };
}

/**
 * Process multiple pools
 * @param pools - Array of raw pool data
 * @param tokenLogos - Map of token address to logo URI
 */
export function processPools(
  pools: PoolWithMetrics[],
  tokenLogos?: Map<string, string | null>
): ProcessedPool[] {
  return pools.map(pool => processPool(pool, tokenLogos));
}