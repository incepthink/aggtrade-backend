// src/controllers/baseSushiswapController.ts
import type { Request, Response, NextFunction } from "express";
import type { StoredSwapData, Pool, ChainConfig, NormalizedPool, PoolV3, PairV2 } from "../../types/sushiswap";
import {
  sushiLimiter,
  FULL_SWAP_DATA_TTL,
  UPDATE_LOCK_TTL,
  UPDATE_LOCK_PREFIX,
} from "../../config/sushiswap";
import { fetchPoolsByTVLWithConfig, fetchSwapsWithConfig } from "../../services/sushiswap";
import {
  getFullTimeRange,
  getIncrementalTimeRange,
  processSwaps,
  mergeSwaps,
  needsUpdate,
  validateTokenAddress,
  validateDays,
  isPoolV3,
  isPairV2,
} from "../../utils/sushiswap";

/** Type-safe Redis interface */
export interface RedisOperations {
  getValue: (key: string) => Promise<string | null>;
  storeValue: (key: string, value: string, ttl: number) => Promise<void>;
  deleteValue?: (key: string) => Promise<void>;
}

/** Type-safe request interfaces */
export interface SwapDataRequest {
  tokenAddress?: string;
  days?: string;
  force?: string;
}

export interface ClearCacheRequest {
  tokenAddress?: string;
}

/** Type-safe response interfaces */
export interface SwapDataResponse {
  status: "success" | "error";
  data?: StoredSwapData & {
    metadata: StoredSwapData["metadata"] & {
      totalSwaps: number;
      timeRange: { start: number; end: number; days: number };
    };
  };
  source?: string;
  cached?: boolean;
  tokenAddress?: string;
  count?: number;
  poolId?: string;
  poolTVL?: string;
  chain?: string;
  updateStatus?: "fresh" | "updating" | "updated";
  stats?: {
    totalSwapsStored: number;
    newSwapsFetched: number;
    existingSwaps: number;
  };
  msg?: string;
  message?: string;
  debug?: { error: string; status?: number; [k: string]: unknown };
}

export interface ClearCacheResponse {
  status: "success" | "error";
  msg: string;
  tokenAddress?: string;
  chain?: string;
}

/** Type-safe error class */
export class SushiswapError extends Error {
  public readonly statusCode: number;
  public readonly chain: string;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number = 500,
    chain: string = "unknown",
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "SushiswapError";
    this.statusCode = statusCode;
    this.chain = chain;
    this.context = context;
  }
}

interface ValidatedSwapDataInput {
  tokenAddress: string;
  daysNum: number;
  force: boolean;
}

export abstract class BaseSushiswapController {
  protected readonly config: ChainConfig;
  protected redisOps: RedisOperations;

  constructor(config: ChainConfig) {
    this.config = config;
    // Non-null placeholder to avoid optional/nullable checks everywhere.
    this.redisOps = {
      getValue: async () => {
        throw new Error("Redis not initialized");
      },
      storeValue: async () => {
        throw new Error("Redis not initialized");
      },
    };
  }

  /** For subclasses to inject a concrete Redis implementation */
  protected setRedisOperations(redisOps: RedisOperations): void {
    this.redisOps = redisOps;
  }

  /** Allow sync/async init in subclasses */
  protected abstract initRedis(): Promise<void> | void;

  // ---------- helpers ----------

  private chainTag(): string {
    return `[${String(this.config.chain).toUpperCase()}]`;
  }

  /**
   * Convert normalized pool to StoredSwapData pool format
   */
  private normalizedPoolToStoredPool(normalizedPool: NormalizedPool) {
    return {
      id: normalizedPool.id,
      address: normalizedPool.id,
      token0: normalizedPool.token0,
      token1: normalizedPool.token1,
      feeTier: normalizedPool.feeTier,
      totalValueLockedUSD: parseFloat(normalizedPool.tvlUSD),
      volumeUSD: parseFloat(normalizedPool.volumeUSD),
      version: normalizedPool.version,
    };
  }

  /**
   * Get TVL/volume from Pool (version agnostic)
   */
  private getPoolTVL(pool: Pool): string {
    if (isPoolV3(pool)) {
      return pool.totalValueLockedUSD;
    } else if (isPairV2(pool)) {
      return pool.reserveUSD;
    }
    throw new Error("Unknown pool type");
  }

  private getPoolVolume(pool: Pool): string {
    return pool.volumeUSD;
  }

  // ---------- validation ----------

  private validateSwapDataInput(query: SwapDataRequest): ValidatedSwapDataInput {
    const { tokenAddress, days = "365", force } = query;

    if (!tokenAddress) {
      throw new SushiswapError(
        "tokenAddress parameter is required",
        400,
        String(this.config.chain)
      );
    }

    if (!validateTokenAddress(tokenAddress)) {
      throw new SushiswapError(
        "Invalid address format",
        422,
        String(this.config.chain)
      );
    }

    const validation = validateDays(days);
    if (!validation.isValid) {
      throw new SushiswapError(
        "Days must be a number between 1 and 365",
        400,
        String(this.config.chain)
      );
    }

    return {
      tokenAddress: tokenAddress.toLowerCase(),
      daysNum: validation.daysNum!, // guaranteed by validateDays
      force: Boolean(force),
    };
  }

  // ---------- cache ops ----------

  private async getCachedData(cacheKey: string): Promise<StoredSwapData | null> {
    try {
      const cached = await this.redisOps.getValue(cacheKey);
      if (!cached) return null;

      const parsed: unknown = JSON.parse(cached);

      if (this.isStoredSwapData(parsed)) {
        return parsed;
      }

      console.warn(`${this.chainTag()} Invalid cached data structure`);
      return null;
    } catch (error: unknown) {
      console.warn(`${this.chainTag()} Cache read error:`, error);
      return null;
    }
  }

  private async setCachedData(
    cacheKey: string,
    data: StoredSwapData
  ): Promise<void> {
    try {
      await this.redisOps.storeValue(
        cacheKey,
        JSON.stringify(data),
        FULL_SWAP_DATA_TTL
      );
      console.log(
        `${this.chainTag()} Saved ${data.swaps.length} swaps to Redis`
      );
    } catch (error: unknown) {
      console.error(`${this.chainTag()} Failed to save to Redis:`, error);
      throw new SushiswapError(
        "Failed to cache data",
        500,
        String(this.config.chain),
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  private async checkLock(lockKey: string): Promise<boolean> {
    try {
      const lockExists = await this.redisOps.getValue(lockKey);
      return Boolean(lockExists);
    } catch (error: unknown) {
      console.warn(`${this.chainTag()} Lock check error:`, error);
      return false;
    }
  }

  private async setLock(lockKey: string): Promise<void> {
    try {
      await this.redisOps.storeValue(lockKey, "updating", UPDATE_LOCK_TTL);
    } catch (error: unknown) {
      console.warn(`${this.chainTag()} Failed to set update lock:`, error);
    }
  }

  private async clearLock(lockKey: string): Promise<void> {
    if (this.redisOps.deleteValue) {
      try {
        await this.redisOps.deleteValue(lockKey);
      } catch (error: unknown) {
        console.warn(`${this.chainTag()} Failed to clear update lock:`, error);
      }
    }
  }

  // ---------- type guard ----------

  private isStoredSwapData(obj: unknown): obj is StoredSwapData {
    if (!obj || typeof obj !== "object") return false;
    const data = obj as Record<string, unknown>;
    return (
      Array.isArray(data.swaps) &&
      typeof data.metadata === "object" &&
      data.metadata !== null &&
      typeof (data.metadata as Record<string, unknown>).chain === "string"
    );
  }

  // ---------- response builders ----------

  private buildSuccessResponse(
    data: StoredSwapData,
    filteredSwaps: StoredSwapData["swaps"],
    tokenAddress: string,
    daysNum: number,
    cached: boolean = false,
    updateStatus: "fresh" | "updating" | "updated" = "fresh",
    stats?: {
      totalSwapsStored: number;
      newSwapsFetched: number;
      existingSwaps: number;
    }
  ): SwapDataResponse {
    const requestedStartTime =
      Math.floor(Date.now() / 1000) - daysNum * 24 * 60 * 60;

    const responseData = {
      ...data,
      swaps: filteredSwaps,
      metadata: {
        ...data.metadata,
        totalSwaps: filteredSwaps.length,
        timeRange: {
          start: requestedStartTime * 1000,
          end: Date.now(),
          days: daysNum,
        },
      },
    };

    const response: SwapDataResponse = {
      status: "success",
      data: responseData,
      source: String(this.config.dexId),
      cached,
      tokenAddress,
      count: filteredSwaps.length,
      poolId: data.metadata.pool.id,
      poolTVL: data.metadata.pool.totalValueLockedUSD.toString(),
      chain: String(this.config.chain),
      updateStatus,
    };

    if (stats) response.stats = stats;
    return response;
  }

  private buildErrorResponse(
    error: SushiswapError | Error,
    context?: Record<string, unknown>
  ): SwapDataResponse {
    if (error instanceof SushiswapError) {
      return {
        status: "error",
        msg: error.message,
        debug: { error: error.message, ...context },
      };
    }
    return {
      status: "error",
      msg: "Unexpected server error",
      debug: { error: (error as Error).message, ...context },
    };
  }

  // ---------- main handler ----------

  async getSwapData(
    req: Request<unknown, SwapDataResponse, unknown, SwapDataRequest>,
    res: Response<SwapDataResponse>,
    _next: NextFunction
  ): Promise<void> {
    try {
      const { tokenAddress, daysNum, force } = this.validateSwapDataInput(
        req.query
      );

      console.log(`${this.chainTag()} Incremental request`, {
        tokenAddress,
        days: daysNum,
        force,
      });

      const cacheKey = `${String(this.config.redisPrefix)}${tokenAddress}`;
      const lockKey = `${UPDATE_LOCK_PREFIX}${String(
        this.config.chain
      )}_${tokenAddress}`;

      await sushiLimiter.schedule(async () => {
        try {
          // 1) cached
          const storedData = await this.getCachedData(cacheKey);

          if (storedData) {
            console.log(`${this.chainTag()} Cached`, {
              swapsCount: storedData.swaps.length,
              lastUpdate: storedData.metadata.lastUpdate,
              lastSwapTimestamp: storedData.metadata.lastSwapTimestamp,
            });
          }

          // 2) need update?
          const shouldUpdate =
            Boolean(force) ||
            !storedData ||
            needsUpdate(storedData.metadata.lastUpdate);

          if (!shouldUpdate && storedData) {
            console.log(`${this.chainTag()} Fresh cache -> return`);

            const requestedStartTime =
              Math.floor(Date.now() / 1000) - daysNum * 24 * 60 * 60;

            const filteredSwaps = storedData.swaps.filter(
              (swap) => swap.timestamp >= requestedStartTime * 1000
            );

            const response = this.buildSuccessResponse(
              storedData,
              filteredSwaps,
              tokenAddress,
              daysNum,
              true,
              "fresh"
            );
            res.status(200).json(response);
            return;
          }

          // 3) lock check
          const lockExists = await this.checkLock(lockKey);
          if (lockExists && !force && storedData) {
            console.log(`${this.chainTag()} Lock present -> return stale`);

            const requestedStartTime =
              Math.floor(Date.now() / 1000) - daysNum * 24 * 60 * 60;

            const filteredSwaps = storedData.swaps.filter(
              (swap) => swap.timestamp >= requestedStartTime * 1000
            );

            const response = this.buildSuccessResponse(
              storedData,
              filteredSwaps,
              tokenAddress,
              daysNum,
              true,
              "updating"
            );
            response.message =
              "Data update in progress, returning existing data";
            res.status(200).json(response);
            return;
          }

          // 4) set lock
          await this.setLock(lockKey);
          console.log(`${this.chainTag()} Updating token=${tokenAddress}`);

          // 5) pool selection - use normalized pools
          let selectedPool: NormalizedPool;

          if (storedData?.metadata.pool) {
            // Convert stored pool back to normalized format
            selectedPool = {
              id: storedData.metadata.pool.id,
              token0: storedData.metadata.pool.token0,
              token1: storedData.metadata.pool.token1,
              feeTier: storedData.metadata.pool.feeTier,
              tvlUSD: storedData.metadata.pool.totalValueLockedUSD.toString(),
              volumeUSD: storedData.metadata.pool.volumeUSD.toString(),
              version: storedData.metadata.pool.version || this.config.version,
            };

            console.log(`${this.chainTag()} Using existing pool: ${selectedPool.id}`);
          } else {
            const pools = await fetchPoolsByTVLWithConfig(this.config, tokenAddress);

            if (!pools?.length) {
              throw new SushiswapError(
                `No pools found for this token on ${String(this.config.chain)}`,
                404,
                String(this.config.chain),
                { tokenAddress }
              );
            }

            selectedPool = pools[0]; // pools[0] is already NormalizedPool from the service
            console.log(`${this.chainTag()} Highest TVL pool`, {
              poolId: selectedPool.id,
              tvl: selectedPool.tvlUSD,
            });
          }

          // 6) role + fetch
          const isToken0 =
            selectedPool.token0.id.toLowerCase() === tokenAddress;
          const baseToken = isToken0 ? selectedPool.token0 : selectedPool.token1;
          const quoteToken = isToken0 ? selectedPool.token1 : selectedPool.token0;

          let newSwaps: any[]; // allow util to shape

          if (storedData?.metadata.lastSwapTimestamp) {
            const { startTime, endTime } = getIncrementalTimeRange(
              Math.floor(storedData.metadata.lastSwapTimestamp / 1000)
            );

            console.log(
              `${this.chainTag()} Incremental fetch ${startTime} -> ${endTime}`
            );

            newSwaps = await fetchSwapsWithConfig(
              this.config,
              selectedPool.id,
              startTime,
              endTime,
              50_000
            );
          } else {
            const { startTime, endTime } = getFullTimeRange();

            console.log(`${this.chainTag()} Full fetch ${startTime} -> ${endTime}`);

            newSwaps = await fetchSwapsWithConfig(
              this.config,
              selectedPool.id,
              startTime,
              endTime,
              50_000
            );
          }

          // 7) process + merge
          const processedNewSwaps = processSwaps(
            newSwaps,
            tokenAddress,
            isToken0
          );
          const existingSwaps: StoredSwapData["swaps"] =
            storedData?.swaps || [];
          const allSwaps = mergeSwaps(existingSwaps, processedNewSwaps);

          console.log(
            `${this.chainTag()} Merged ${existingSwaps.length} + ${processedNewSwaps.length} = ${allSwaps.length}`
          );

          // 8) build stored snapshot
          const nowSec = Math.floor(Date.now() / 1000);
          const lastSwapTimestamp =
            allSwaps.length > 0
              ? Math.max(...allSwaps.map((s) => s.timestamp))
              : nowSec * 1000;

          const updatedStoredData: StoredSwapData = {
            swaps: allSwaps,
            metadata: {
              token: {
                address: baseToken.id,
                name: baseToken.name,
                symbol: baseToken.symbol,
                decimals: baseToken.decimals,
              },
              pool: this.normalizedPoolToStoredPool(selectedPool),
              isToken0,
              quoteToken,
              lastUpdate: nowSec,
              lastSwapTimestamp,
              dataRange: {
                start:
                  allSwaps.length > 0
                    ? Math.min(...allSwaps.map((s) => s.timestamp))
                    : nowSec * 1000,
                end: lastSwapTimestamp,
              },
              chain: String(this.config.chain),
              dexId: String(this.config.dexId),
            },
          };

          await this.setCachedData(cacheKey, updatedStoredData);

          // 9) unlock + respond
          await this.clearLock(lockKey);

          const requestedStartTime =
            Math.floor(Date.now() / 1000) - daysNum * 24 * 60 * 60;
          const filteredSwaps = allSwaps.filter(
            (swap) => swap.timestamp >= requestedStartTime * 1000
          );

          const response = this.buildSuccessResponse(
            updatedStoredData,
            filteredSwaps,
            tokenAddress,
            daysNum,
            false,
            "updated",
            {
              totalSwapsStored: allSwaps.length,
              newSwapsFetched: processedNewSwaps.length,
              existingSwaps: existingSwaps.length,
            }
          );

          console.log(
            `${this.chainTag()} Responding with ${filteredSwaps.length} swaps`
          );
          res.status(200).json(response);
        } catch (apiError: unknown) {
          await this.clearLock(lockKey);

          console.error(`${this.chainTag()} Incremental API error:`, apiError);

          if (apiError instanceof SushiswapError) {
            res
              .status(apiError.statusCode)
              .json(this.buildErrorResponse(apiError));
          } else if (apiError instanceof Error) {
            res.status(500).json(this.buildErrorResponse(apiError));
          } else {
            res.status(500).json({
              status: "error",
              msg: "Unknown error occurred",
            });
          }
        }
      });
    } catch (error: unknown) {
      console.error(`${this.chainTag()} Controller error:`, error);

      if (error instanceof SushiswapError) {
        res.status(error.statusCode).json(this.buildErrorResponse(error));
      } else if (error instanceof Error) {
        res.status(500).json(this.buildErrorResponse(error));
      } else {
        res.status(500).json({ status: "error", msg: "Unknown error occurred" });
      }
    }
  }

  // ---------- clear cache ----------

  async clearSwapCache(
    req: Request<unknown, ClearCacheResponse, unknown, ClearCacheRequest>,
    res: Response<ClearCacheResponse>,
    _next: NextFunction
  ): Promise<void> {
    try {
      const { tokenAddress } = req.query;

      if (!tokenAddress) {
        res.status(400).json({
          status: "error",
          msg: "tokenAddress parameter is required",
        });
        return;
      }

      if (!validateTokenAddress(tokenAddress)) {
        res.status(422).json({
          status: "error",
          msg: "Invalid address format",
        });
        return;
      }

      const normalizedAddress = tokenAddress.toLowerCase();
      const cacheKey = `${String(this.config.redisPrefix)}${normalizedAddress}`;

      console.log(
        `${this.chainTag()} Clearing cache for: ${normalizedAddress}`
      );

      if (this.redisOps.deleteValue) {
        await this.redisOps.deleteValue(cacheKey);
      }

      res.status(200).json({
        status: "success",
        msg: "Cache cleared successfully",
        tokenAddress: normalizedAddress,
        chain: String(this.config.chain),
      });
    } catch (error: unknown) {
      console.error(`${this.chainTag()} Clear cache error:`, error);

      res.status(500).json({
        status: "error",
        msg: "Unexpected server error",
      });
    }
  }
}