import type { Request, Response, NextFunction } from "express";
import { fetchPoolsWithMetrics } from '../../utils/katana/dataFetching';
import { processPools } from '../../utils/katana/pool/poolProcessing';
import {
  loadPoolsDataFromRedis,
  savePoolsDataToRedis,
  needsPoolsUpdate,
} from '../../utils/katana/pool/redisPoolOperations';
import { getTokenLogos, getTradableTokenAddresses } from '../../utils/katana/pool/poolFiltering';
/**
 * Get all Katana pools with calculated metrics
 * Uses Redis cache with 30-minute TTL
 * Only returns pools where both tokens are tradable
 * Includes token logo URIs from database
 */
export async function getKatanaPools(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    console.log('[Katana Pools] Processing request...');

    // Try to load from cache
    const cachedData = await loadPoolsDataFromRedis();

    // If cache exists and is fresh, return it
    if (cachedData && !needsPoolsUpdate(cachedData.metadata.lastUpdate)) {
      console.log('[Katana Pools] Returning cached data');
      
      res.status(200).json({
        status: "success",
        data: {
          pools: cachedData.pools,
          count: cachedData.pools.length,
        },
        chain: "katana",
        timestamp: Date.now(),
        cached: true,
        cacheAge: Math.floor(Date.now() / 1000) - cachedData.metadata.lastUpdate,
      });
      return;
    }

    console.log('[Katana Pools] Fetching fresh data from subgraph...');

    // Get tradable token addresses and logos from database
    const [tradableTokens, tokenLogos] = await Promise.all([
      getTradableTokenAddresses(),
      getTokenLogos(),
    ]);
    
    console.log(`[Katana Pools] Found ${tradableTokens.size} tradable tokens with ${tokenLogos.size} logos`);

    // Fetch raw pool data from subgraph
    const rawPools = await fetchPoolsWithMetrics();
    console.log(`[Katana Pools] Fetched ${rawPools.length} total pools from subgraph`);

    if (!rawPools || rawPools.length === 0) {
      res.status(404).json({
        status: "error",
        msg: "No pools found",
        chain: "katana",
      });
      return;
    }

    // Filter pools - keep only those where BOTH tokens are tradable
    const filteredPools = rawPools.filter((pool) => {
      const token0Tradable = tradableTokens.has(pool.token0.id.toLowerCase());
      const token1Tradable = tradableTokens.has(pool.token1.id.toLowerCase());
      return token0Tradable && token1Tradable;
    });

    console.log(`[Katana Pools] Filtered to ${filteredPools.length} pools with tradable tokens`);

    if (filteredPools.length === 0) {
      res.status(404).json({
        status: "error",
        msg: "No pools found with tradable tokens",
        chain: "katana",
      });
      return;
    }

    // Process filtered pools into frontend format (with logos)
    const processedPools = processPools(filteredPools, tokenLogos);

    // Save to cache
    await savePoolsDataToRedis(processedPools);

    console.log('[Katana Pools] Processed and cached pools:', {
      total: processedPools.length,
      topPool: processedPools[0]?.name,
      topPoolTVL: processedPools[0]?.liquidityUSD,
    });

    res.status(200).json({
      status: "success",
      data: {
        pools: processedPools,
        count: processedPools.length,
      },
      chain: "katana",
      timestamp: Date.now(),
      cached: false,
      filtered: {
        totalFromSubgraph: rawPools.length,
        afterFiltering: processedPools.length,
        tradableTokensCount: tradableTokens.size,
      },
    });

  } catch (error: any) {
    console.error("[Katana Pools] Error:", error.message);
    res.status(500).json({
      status: "error",
      msg: "Failed to fetch pools data",
      chain: "katana",
      debug: { error: error.message },
    });
  }
}