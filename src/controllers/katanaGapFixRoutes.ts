// File: src/controllers/katanaGapFixController.ts
// Description: API endpoint to detect and fix data gaps for Katana swap tokens

import type { Request, Response } from "express";
import { getValue, storeValue, deleteValue } from "../redis/katanaTokens";
import { 
  detectGaps, 
  bulkInsertSwapsToMySQL,
  getTokenDataRange 
} from "../cron-jobs/utils/katanaMySQLHelpers";
import KatanaSwap from "../models/KatanaSwap";
import axios from "axios";
import Bottleneck from "bottleneck";

// Constants
const KATANA_SUBGRAPH_URL = "https://api.studio.thegraph.com/query/106601/sushi-v-3-katana-2/version/latest";
const FULL_SWAP_DATA_PREFIX = "full_swaps_katana_";
const FULL_SWAP_DATA_TTL = 365 * 24 * 60 * 60;
const MAX_REDIS_SWAPS = 3000;

// Rate limiter
const sushiLimiter = new Bottleneck({
  reservoir: 60,
  reservoirRefreshAmount: 60,
  reservoirRefreshInterval: 60 * 1000,
  maxConcurrent: 2,
  minTime: 1000,
});

interface SwapData {
  id: string;
  timestamp: string;
  token0: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  token1: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  token0PriceUSD: string;
  token1PriceUSD: string;
  amount0USD: string;
  amount1USD: string;
  amountUSD: string;
  sqrtPriceX96: string;
  pool: {
    id: string;
    token0: { id: string; symbol: string };
    token1: { id: string; symbol: string };
    feeTier: string;
  };
}

interface ProcessedSwap {
  id: string;
  timestamp: number;
  tokenPriceUSD: number;
  tokenVolumeUSD: number;
  totalVolumeUSD: number;
}

interface Pool {
  id: string;
  token0: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  token1: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  feeTier: string;
  totalValueLockedUSD: string;
  volumeUSD: string;
}

/**
 * Fetch swaps from subgraph for a specific time range
 */
async function fetchSwapsForGap(
  poolId: string,
  startTime: number,
  endTime: number
): Promise<SwapData[]> {
  const allSwaps: SwapData[] = [];
  let skip = 0;
  const first = 1000;

  console.log(`[Gap Fixer] Fetching swaps for pool ${poolId} from ${startTime} to ${endTime}`);

  while (true) {
    const query = `
      query GetSwaps($poolId: String!, $startTime: Int!, $endTime: Int!, $first: Int!, $skip: Int!) {
        swaps(
          where: {
            pool: $poolId
            timestamp_gte: $startTime
            timestamp_lte: $endTime
          }
          orderBy: timestamp
          orderDirection: desc
          first: $first
          skip: $skip
        ) {
          id
          timestamp
          token0 {
            id
            symbol
            name
            decimals
          }
          token1 {
            id
            symbol
            name
            decimals
          }
          token0PriceUSD
          token1PriceUSD
          amount0USD
          amount1USD
          amountUSD
          sqrtPriceX96
          pool {
            id
            token0 { id symbol }
            token1 { id symbol }
            feeTier
          }
        }
      }
    `;

    const response = await sushiLimiter.schedule(() =>
      axios.post(KATANA_SUBGRAPH_URL, {
        query,
        variables: {
          poolId: poolId.toLowerCase(),
          startTime,
          endTime,
          first,
          skip,
        },
      })
    );

    const swaps = response.data?.data?.swaps || [];
    
    if (swaps.length === 0) {
      break;
    }

    allSwaps.push(...swaps);
    console.log(`[Gap Fixer] Fetched ${swaps.length} swaps (total: ${allSwaps.length})`);

    if (swaps.length < first) {
      break;
    }

    skip += first;

    if (skip >= 5000) {
      console.log(`[Gap Fixer] Reached skip limit of 5000`);
      break;
    }
  }

  console.log(`[Gap Fixer] Total swaps fetched: ${allSwaps.length}`);
  return allSwaps;
}

/**
 * Process raw swap data into ProcessedSwap format
 */
function processSwaps(
  swaps: SwapData[],
  tokenAddress: string,
  isToken0: boolean
): ProcessedSwap[] {
  return swaps.map(swap => {
    const tokenPriceUSD = parseFloat(isToken0 ? swap.token0PriceUSD : swap.token1PriceUSD);
    const tokenVolumeUSD = parseFloat(isToken0 ? swap.amount0USD : swap.amount1USD);
    const totalVolumeUSD = parseFloat(swap.amountUSD);

    return {
      id: swap.id,
      timestamp: parseInt(swap.timestamp) * 1000,
      tokenPriceUSD,
      tokenVolumeUSD: Math.abs(tokenVolumeUSD),
      totalVolumeUSD,
    };
  });
}

/**
 * Get pool for token from Redis metadata
 */
async function getPoolFromRedis(tokenAddress: string): Promise<{
  poolId: string;
  isToken0: boolean;
  token0: any;
  token1: any;
  feeTier: string;
} | null> {
  try {
    const cacheKey = `${FULL_SWAP_DATA_PREFIX}${tokenAddress.toLowerCase()}`;
    const redisData = await getValue(cacheKey);
    
    if (!redisData) {
      return null;
    }

    const storedData = JSON.parse(redisData);
    return {
      poolId: storedData.metadata.pool.id,
      isToken0: storedData.metadata.isToken0,
      token0: storedData.metadata.pool.token0,
      token1: storedData.metadata.pool.token1,
      feeTier: storedData.metadata.pool.feeTier,
    };
  } catch (error) {
    console.error('[Gap Fixer] Error getting pool from Redis:', error);
    return null;
  }
}

/**
 * Find pool for token from subgraph
 */
async function findPoolForToken(tokenAddress: string): Promise<Pool | null> {
  const query = `
    query GetPoolsByTVL($tokenAddress: String!) {
      pools(
        where: {
          or: [
            { token0: $tokenAddress }
            { token1: $tokenAddress }
          ]
        }
        orderBy: totalValueLockedUSD
        orderDirection: desc
        first: 10
      ) {
        id
        token0 { id symbol name decimals }
        token1 { id symbol name decimals }
        feeTier
        totalValueLockedUSD
        volumeUSD
      }
    }
  `;

  try {
    const response = await axios.post(KATANA_SUBGRAPH_URL, {
      query,
      variables: { tokenAddress: tokenAddress.toLowerCase() },
    });

    const pools = response.data?.data?.pools || [];
    
    if (pools.length === 0) {
      return null;
    }

    // Prefer USDC or AUSD pairs
    const USDC = "0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36".toLowerCase();
    const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a".toLowerCase();

    for (const pool of pools) {
      if (pool.token0.id.toLowerCase() === USDC || pool.token1.id.toLowerCase() === USDC) {
        return pool;
      }
      if (pool.token0.id.toLowerCase() === AUSD || pool.token1.id.toLowerCase() === AUSD) {
        return pool;
      }
    }

    return pools[0];
  } catch (error) {
    console.error('[Gap Fixer] Error finding pool:', error);
    return null;
  }
}

/**
 * Rebuild Redis cache from MySQL
 */
async function rebuildRedisFromMySQL(tokenAddress: string): Promise<void> {
  try {
    console.log(`[Gap Fixer] Rebuilding Redis cache for ${tokenAddress}`);

    // Get most recent 3000 swaps from MySQL
    const recentSwaps = await KatanaSwap.getRecentSwaps(tokenAddress, MAX_REDIS_SWAPS);

    if (recentSwaps.length === 0) {
      console.log(`[Gap Fixer] No swaps found in MySQL for ${tokenAddress}`);
      return;
    }

    // Get pool info
    const poolInfo = await getPoolFromRedis(tokenAddress);
    
    if (!poolInfo) {
      console.log(`[Gap Fixer] No pool info in Redis, skipping rebuild`);
      return;
    }

    // Convert to ProcessedSwap format
    const processedSwaps: ProcessedSwap[] = recentSwaps.map((swap: any) => ({
      id: swap.id,
      timestamp: new Date(swap.timestamp).getTime(),
      tokenPriceUSD: parseFloat(swap.token_price_usd),
      tokenVolumeUSD: parseFloat(swap.token_volume_usd),
      totalVolumeUSD: parseFloat(swap.total_volume_usd),
    }));

    // Update Redis
    const cacheKey = `${FULL_SWAP_DATA_PREFIX}${tokenAddress.toLowerCase()}`;
    const existingData = await getValue(cacheKey);
    const metadata = existingData ? JSON.parse(existingData).metadata : null;

    if (!metadata) {
      console.log(`[Gap Fixer] No metadata in Redis, cannot rebuild`);
      return;
    }

    const updatedData = {
      swaps: processedSwaps,
      metadata: {
        ...metadata,
        lastUpdate: Math.floor(Date.now() / 1000),
        dataRange: {
          start: Math.min(...processedSwaps.map(s => s.timestamp)),
          end: Math.max(...processedSwaps.map(s => s.timestamp)),
        },
      },
    };

    await storeValue(cacheKey, JSON.stringify(updatedData), FULL_SWAP_DATA_TTL);
    console.log(`[Gap Fixer] Redis rebuilt with ${processedSwaps.length} swaps`);

  } catch (error) {
    console.error('[Gap Fixer] Error rebuilding Redis:', error);
  }
}

/**
 * Main API endpoint: Fix gaps for a token
 */
export async function fixTokenGaps(
  req: Request<{ tokenAddress: string }>,
  res: Response
): Promise<void> {
  const startTime = Date.now();
  const { tokenAddress } = req.params;

  if (!tokenAddress) {
    res.status(400).json({
      status: "error",
      message: "tokenAddress parameter is required",
    });
    return;
  }

  const normalizedAddress = tokenAddress.toLowerCase();

  try {
    console.log(`\n[Gap Fixer] ===== Starting Gap Fix for ${normalizedAddress} =====`);

    // Step 1: Get data range from MySQL
    const dataRange = await getTokenDataRange(normalizedAddress);
    
    if (dataRange.totalSwaps === 0) {
      res.status(404).json({
        status: "error",
        message: "No data found for this token in MySQL",
        tokenAddress: normalizedAddress,
      });
      return;
    }

    console.log(`[Gap Fixer] Current data range:`, {
      earliest: dataRange.earliest,
      latest: dataRange.latest,
      totalSwaps: dataRange.totalSwaps,
    });

    // Step 2: Detect gaps
    const gaps = await detectGaps(normalizedAddress, 24);

    if (gaps.length === 0) {
      console.log(`[Gap Fixer] No gaps found`);
      res.status(200).json({
        status: "success",
        message: "No gaps detected",
        tokenAddress: normalizedAddress,
        dataRange,
        gaps: [],
        swapsAdded: 0,
      });
      return;
    }

    console.log(`[Gap Fixer] Found ${gaps.length} gaps to fix`);

    // Step 3: Get pool info
    let poolInfo = await getPoolFromRedis(normalizedAddress);
    
    if (!poolInfo) {
      console.log(`[Gap Fixer] Pool not in Redis, searching subgraph...`);
      const pool = await findPoolForToken(normalizedAddress);
      
      if (!pool) {
        res.status(404).json({
          status: "error",
          message: "Could not find pool for this token",
          tokenAddress: normalizedAddress,
        });
        return;
      }

      poolInfo = {
        poolId: pool.id,
        isToken0: pool.token0.id.toLowerCase() === normalizedAddress,
        token0: pool.token0,
        token1: pool.token1,
        feeTier: pool.feeTier,
      };
    }

    console.log(`[Gap Fixer] Using pool ${poolInfo.poolId}`);

    // Step 4: Fill each gap
    let totalSwapsAdded = 0;
    const gapResults = [];

    for (const gap of gaps) {
      console.log(`[Gap Fixer] Filling gap: ${new Date(gap.start * 1000).toISOString()} → ${new Date(gap.end * 1000).toISOString()}`);

      // Fetch swaps for this gap
      const swaps = await fetchSwapsForGap(poolInfo.poolId, gap.start, gap.end);
      
      if (swaps.length === 0) {
        console.log(`[Gap Fixer] No swaps found for this gap`);
        gapResults.push({
          start: new Date(gap.start * 1000).toISOString(),
          end: new Date(gap.end * 1000).toISOString(),
          durationHours: gap.durationHours,
          swapsAdded: 0,
        });
        continue;
      }

      // Process and insert swaps
      const processedSwaps = processSwaps(swaps, normalizedAddress, poolInfo.isToken0);
      
      const insertResult = await bulkInsertSwapsToMySQL(
        processedSwaps,
        normalizedAddress,
        poolInfo.poolId,
        poolInfo.isToken0,
        {
          token0: poolInfo.token0,
          token1: poolInfo.token1,
          feeTier: poolInfo.feeTier,
        }
      );

      totalSwapsAdded += insertResult.inserted;
      
      gapResults.push({
        start: new Date(gap.start * 1000).toISOString(),
        end: new Date(gap.end * 1000).toISOString(),
        durationHours: gap.durationHours,
        swapsAdded: insertResult.inserted,
      });

      console.log(`[Gap Fixer] Gap filled: ${insertResult.inserted} swaps added`);
    }

    // Step 5: Rebuild Redis cache
    await rebuildRedisFromMySQL(normalizedAddress);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`[Gap Fixer] ===== Gap Fix Complete =====`);
    console.log(`[Gap Fixer] Duration: ${duration}s`);
    console.log(`[Gap Fixer] Total swaps added: ${totalSwapsAdded}`);

    res.status(200).json({
      status: "success",
      message: "Gaps fixed successfully",
      tokenAddress: normalizedAddress,
      gapsFixed: gaps.length,
      swapsAdded: totalSwapsAdded,
      duration: `${duration}s`,
      gaps: gapResults,
      dataRange,
    });

  } catch (error: any) {
    console.error(`[Gap Fixer] Error:`, error);
    res.status(500).json({
      status: "error",
      message: "Failed to fix gaps",
      error: error.message,
      tokenAddress: normalizedAddress,
    });
  }
}