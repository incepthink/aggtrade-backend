// services/apiService.ts
import axios from "axios";
import Bottleneck from "bottleneck";
import {
  SushiGraphResponse,
  Pool,
  SwapDataWithSqrt
} from "../types/katanaSqrtPrice.types";
import {
  KATANA_SUBGRAPH_URL,
  SUSHI_API_BASE,
  KATANA_CHAIN_ID,
  RATE_LIMIT_RESERVOIR,
  RATE_LIMIT_REFRESH_AMOUNT,
  RATE_LIMIT_REFRESH_INTERVAL,
  RATE_LIMIT_MAX_CONCURRENT,
  RATE_LIMIT_MIN_TIME,
  GRAPHQL_TIMEOUT,
  API_TIMEOUT,
  POOLS_TIMEOUT,
  LOG_PREFIX
} from "../constants/katanaSqrtPrice.constants";
import { KatanaLogger } from "../utils/logger";

type RateLimiterStatus = {
  reservoir: number | null;
  running: number;
  queued: number;
};

export class ApiService {
  private static sushiLimiter = new Bottleneck({
    reservoir: RATE_LIMIT_RESERVOIR,
    reservoirRefreshAmount: RATE_LIMIT_REFRESH_AMOUNT,
    reservoirRefreshInterval: RATE_LIMIT_REFRESH_INTERVAL,
    maxConcurrent: RATE_LIMIT_MAX_CONCURRENT,
    minTime: RATE_LIMIT_MIN_TIME
  });

  /**
   * Fetch current token price from Sushi API
   */
  static async fetchSushiPrice(tokenAddress: string): Promise<number | null> {
    const startTime = Date.now();
    const url = `${SUSHI_API_BASE}/${KATANA_CHAIN_ID}/${tokenAddress}`;

    try {
      KatanaLogger.api(LOG_PREFIX, "GET", url);

      const { data } = await axios.get(url, {
        timeout: API_TIMEOUT
      });

      const price = data ?? null;
      const duration = Date.now() - startTime;

      KatanaLogger.api(LOG_PREFIX, "GET", url, 200, duration, { price });

      return price;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const status = error?.response?.status;

      KatanaLogger.api(LOG_PREFIX, "GET", url, status, duration);
      KatanaLogger.error(LOG_PREFIX, "Failed to fetch Sushi price", error, {
        tokenAddress,
        url
      });

      return null;
    }
  }

  /**
   * Get GraphQL query to find pools by TVL
   */
  private static getPoolsByTVLQuery(): string {
    return `
      query GetPoolsByTVL($tokenAddress: String!) {
        pools(
          where: {
            or: [
              { token0: $tokenAddress },
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
          token0Price
          token1Price
          sqrtPrice
          tick
        }
      }
    `;
  }

  /**
   * Fetch pools by TVL for a token
   */
  static async fetchPoolsByTVL(tokenAddress: string): Promise<Pool[]> {
    const startTime = Date.now();

    try {
      const query = this.getPoolsByTVLQuery();
      const variables = { tokenAddress };

      KatanaLogger.api(
        LOG_PREFIX,
        "POST",
        KATANA_SUBGRAPH_URL,
        undefined,
        undefined,
        { query: "GetPoolsByTVL", tokenAddress }
      );

      const response = await axios.post<SushiGraphResponse>(
        KATANA_SUBGRAPH_URL,
        { query, variables },
        {
          timeout: POOLS_TIMEOUT,
          headers: { "Content-Type": "application/json" }
        }
      );

      const duration = Date.now() - startTime;

      if (!response.data?.data?.pools) {
        KatanaLogger.api(
          LOG_PREFIX,
          "POST",
          KATANA_SUBGRAPH_URL,
          response.status,
          duration,
          { error: "Invalid response structure" }
        );
        return [];
      }

      const pools = response.data.data.pools;

      KatanaLogger.api(
        LOG_PREFIX,
        "POST",
        KATANA_SUBGRAPH_URL,
        response.status,
        duration,
        { poolCount: pools.length, topPoolTVL: pools[0]?.totalValueLockedUSD }
      );

      return pools;
    } catch (error: any) {
      const duration = Date.now() - startTime;

      KatanaLogger.api(
        LOG_PREFIX,
        "POST",
        KATANA_SUBGRAPH_URL,
        error?.response?.status,
        duration
      );
      KatanaLogger.error(LOG_PREFIX, "Failed to fetch pools by TVL", error, {
        tokenAddress
      });

      return [];
    }
  }

  /**
   * Get GraphQL query for swap data with sqrtPriceX96
   */
  private static getSwapsWithSqrtPriceQuery(): string {
    return `
      query GetSwapsWithSqrtPrice(
        $poolId: String!,
        $startTime: Int!,
        $endTime: Int!,
        $first: Int!,
        $skip: Int!
      ) {
        swaps(
          where: {
            pool: $poolId,
            timestamp_gte: $startTime,
            timestamp_lte: $endTime
          }
          orderBy: timestamp
          orderDirection: desc
          first: $first
          skip: $skip
        ) {
          id
          timestamp
          sqrtPriceX96
          tick
          token0 { id symbol name decimals }
          token1 { id symbol name decimals }
          amount0USD
          amount1USD
          amountUSD
          pool { id }
        }
      }
    `;
  }

  /**
   * Fetch swaps with rate limiting
   */
  static async fetchSwapsWithSqrtPrice(
    poolId: string,
    startTime: number,
    endTime: number,
    first: number,
    skip: number
  ): Promise<SwapDataWithSqrt[]> {
    return this.sushiLimiter.schedule(async () => {
      const requestStartTime = Date.now();

      try {
        const query = this.getSwapsWithSqrtPriceQuery();
        const variables = { poolId, startTime, endTime, first, skip };

        KatanaLogger.api(
          LOG_PREFIX,
          "POST",
          KATANA_SUBGRAPH_URL,
          undefined,
          undefined,
          {
            query: "GetSwapsWithSqrtPrice",
            poolId: poolId.substring(0, 10) + "...",
            timeRange: `${startTime}-${endTime}`,
            pagination: { first, skip }
          }
        );

        const response = await axios.post<SushiGraphResponse>(
          KATANA_SUBGRAPH_URL,
          { query, variables },
          {
            timeout: GRAPHQL_TIMEOUT,
            headers: { "Content-Type": "application/json" }
          }
        );

        const duration = Date.now() - requestStartTime;

        // Validate structure
        if (!response?.data?.data) {
          const errorMsg = `Invalid response structure: ${JSON.stringify(response?.data)}`;
          KatanaLogger.api(
            LOG_PREFIX,
            "POST",
            KATANA_SUBGRAPH_URL,
            response?.status,
            duration,
            { error: errorMsg }
          );
          throw new Error(errorMsg);
        }

        // GraphQL errors
        if (response.data.errors?.length) {
          const errorMsg = response.data.errors[0]?.message ?? "GraphQL error";
          KatanaLogger.api(
            LOG_PREFIX,
            "POST",
            KATANA_SUBGRAPH_URL,
            response.status,
            duration,
            { graphqlError: errorMsg }
          );
          throw new Error(errorMsg);
        }

        const swaps = response.data.data.swaps ?? [];

        KatanaLogger.api(
          LOG_PREFIX,
          "POST",
          KATANA_SUBGRAPH_URL,
          response.status,
          duration,
          { swapCount: swaps.length, requestedCount: first }
        );

        return swaps;
      } catch (error: any) {
        const duration = Date.now() - requestStartTime;

        KatanaLogger.api(
          LOG_PREFIX,
          "POST",
          KATANA_SUBGRAPH_URL,
          error?.response?.status,
          duration
        );

        KatanaLogger.error(LOG_PREFIX, "Failed to fetch swaps", error, {
          poolId,
          startTime,
          endTime,
          first,
          skip
        });

        throw error;
      }
    });
  }

  /**
   * Check rate limiter status (TS-safe across Bottleneck typings)
   */
  static async getRateLimiterStatus(): Promise<RateLimiterStatus> {
    const reservoir = await this.sushiLimiter.currentReservoir();

    // Some Bottleneck typings include counts(), some don't.
    // We safely probe it via `any` while keeping a typed return.
    const limiterAny = this.sushiLimiter as unknown as {
      counts?: () => { [k: string]: number };
      jobsRunning?: () => number;
      jobsQueued?: () => number;
    };

    let running = 0;
    let queued = 0;

    const counts = limiterAny.counts?.();
    if (counts) {
      // Common keys seen across versions; prefer EXECUTING & QUEUED.
      running =
        (counts as any).EXECUTING ??
        (counts as any).RUNNING ??
        0;
      queued =
        (counts as any).QUEUED ??
        (counts as any).WAITING ??
        0;
    } else {
      // Fallback to runtime helpers if present
      running = limiterAny.jobsRunning?.() ?? 0;
      queued = limiterAny.jobsQueued?.() ?? 0;
    }

    return { reservoir, running, queued };
  }

  /**
   * Wait for rate limiter if needed
   */
  static async waitForRateLimit(): Promise<void> {
    const status = await this.getRateLimiterStatus();

    if (status.queued > 5) {
      KatanaLogger.warn(LOG_PREFIX, "High queue depth, waiting", status);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
