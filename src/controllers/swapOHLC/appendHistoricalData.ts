// src/controllers/appendHistoricalData.ts
import type { Request, Response, NextFunction } from "express";
import axios from "axios";
import Bottleneck from "bottleneck";
import KatanaSwap from "../../models/KatanaSwap";
import type { Transaction } from "sequelize";
import sequelize from "../../utils/db/sequelize";
import { getValue } from "../../redis/katanaTokens";

/* ===========================
 * Types
 * =========================== */

interface SwapData {
  id: string;
  timestamp: string;
  token0: { id: string; symbol: string; name: string; decimals: string };
  token1: { id: string; symbol: string; name: string; decimals: string };
  token0PriceUSD: string;
  token1PriceUSD: string;
  amount0USD: string;
  amount1USD: string;
  amountUSD: string;
  pool: { id: string };
}

interface ProcessedSwap {
  id: string;
  timestamp: number; // ms
  tokenPriceUSD: number;
  tokenVolumeUSD: number;
  totalVolumeUSD: number;
}

interface SushiGraphResponse {
  data: { swaps?: SwapData[] };
  errors?: any[];
}

interface ExistingSwapInfo {
  pool_id: string;
  pool_token0_address: string;
  pool_token0_symbol: string;
  pool_token1_address: string;
  pool_token1_symbol: string;
  pool_fee_tier: number;
  is_token0: boolean;
}

interface RedisSwapData {
  swaps: ProcessedSwap[];
  metadata: {
    pool: {
      id: string;
      token0: any;
      token1: any;
      feeTier: string;
      totalValueLockedUSD: number;
      volumeUSD: number;
    };
    isToken0: boolean;
    lastSwapTimestamp: number;
  };
}

/* ===========================
 * Config / Constants
 * =========================== */

const sushiLimiter = new Bottleneck({
  reservoir: 60,
  reservoirRefreshAmount: 60,
  reservoirRefreshInterval: 60 * 1000, // per minute
  maxConcurrent: 2,
  minTime: 1000,
});

const KATANA_SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/106601/sushi-v-3-katana-2/version/latest";

const MAX_SKIP_LIMIT = 5000;
const MAX_TOTAL_SWAPS = 6000;
const UPDATE_LOCK_TIMEOUT = 60 * 60 * 1000; // 1 hour (ms)

// Redis cache configuration
const FULL_SWAP_DATA_PREFIX = "full_swaps_katana_";

// In-memory lock to prevent concurrent updates for same token
const updateLocks = new Map<string, number>();

/* ===========================
 * Helpers
 * =========================== */

function getHistoricalSwapsQuery() {
  return `
    query GetHistoricalSwaps($poolId: String!, $olderThan: Int!, $first: Int!, $skip: Int!) {
      swaps(
        where: { pool: $poolId, timestamp_lt: $olderThan }
        orderBy: timestamp
        orderDirection: desc
        first: $first
        skip: $skip
      ) {
        id
        timestamp
        token0 { id symbol name decimals }
        token1 { id symbol name decimals }
        token0PriceUSD
        token1PriceUSD
        amount0USD
        amount1USD
        amountUSD
        pool { id }
      }
    }
  `;
}

function processSwaps(rawSwaps: SwapData[], isToken0: boolean): ProcessedSwap[] {
  return rawSwaps.map((swap) => ({
    id: swap.id,
    timestamp: parseInt(swap.timestamp, 10) * 1000, // sec -> ms
    tokenPriceUSD: isToken0
      ? parseFloat(swap.token0PriceUSD || "0")
      : parseFloat(swap.token1PriceUSD || "0"),
    tokenVolumeUSD: isToken0
      ? Math.abs(parseFloat(swap.amount0USD || "0"))
      : Math.abs(parseFloat(swap.amount1USD || "0")),
    totalVolumeUSD: parseFloat(swap.amountUSD || "0"),
  }));
}

function convertToModelFormat(
  processed: ProcessedSwap[],
  existingSwap: ExistingSwapInfo,
  tokenAddress: string
): any[] {
  const tokenAddr = tokenAddress.toLowerCase();
  return processed.map((swap) => ({
    id: swap.id,
    pool_id: existingSwap.pool_id,
    pool_token0_address: existingSwap.pool_token0_address,
    pool_token0_symbol: existingSwap.pool_token0_symbol,
    pool_token1_address: existingSwap.pool_token1_address,
    pool_token1_symbol: existingSwap.pool_token1_symbol,
    pool_fee_tier: existingSwap.pool_fee_tier,
    token_address: tokenAddr,
    is_token0: existingSwap.is_token0,
    timestamp: new Date(swap.timestamp),
    block_number: 0, // not provided by this query
    token_price_usd: swap.tokenPriceUSD,
    token_volume_usd: swap.tokenVolumeUSD,
    total_volume_usd: swap.totalVolumeUSD,
    tx_hash: swap.id.split("-")[0], // txhash-logIndex
  }));
}

/**
 * Load swap data from Redis cache
 */
async function loadRedisSwapData(tokenAddress: string): Promise<RedisSwapData | null> {
  try {
    const cacheKey = `${FULL_SWAP_DATA_PREFIX}${tokenAddress.toLowerCase()}`;
    console.log(`[Redis Fallback] Loading data from Redis key: ${cacheKey}`);
    
    const cached = await getValue(cacheKey);
    if (!cached) {
      console.log(`[Redis Fallback] No data found in Redis`);
      return null;
    }

    const redisData = JSON.parse(cached) as RedisSwapData;
    console.log(`[Redis Fallback] Found Redis data:`, {
      swapsCount: redisData.swaps.length,
      poolId: redisData.metadata.pool.id,
      lastSwapTimestamp: redisData.metadata.lastSwapTimestamp,
    });

    return redisData;
  } catch (error) {
    console.error(`[Redis Fallback] Error loading from Redis:`, error);
    return null;
  }
}

/**
 * Convert Redis data to ExistingSwapInfo format
 */
function createSwapInfoFromRedis(redisData: RedisSwapData): ExistingSwapInfo {
  return {
    pool_id: redisData.metadata.pool.id,
    pool_token0_address: redisData.metadata.pool.token0.id,
    pool_token0_symbol: redisData.metadata.pool.token0.symbol,
    pool_token1_address: redisData.metadata.pool.token1.id,
    pool_token1_symbol: redisData.metadata.pool.token1.symbol,
    pool_fee_tier: parseInt(redisData.metadata.pool.feeTier),
    is_token0: redisData.metadata.isToken0,
  };
}

async function fetchHistoricalSwaps(
  poolId: string,
  olderThanTimestampSec: number,
  maxSwaps: number = MAX_TOTAL_SWAPS
): Promise<SwapData[]> {
  const all: SwapData[] = [];
  let hasMore = true;
  let skip = 0;
  const batchSize = 1000;

  console.log(
    `[Historical MySQL] Fetching swaps for pool ${poolId} older than ${new Date(
      olderThanTimestampSec * 1000
    ).toISOString()}`
  );

  while (hasMore && all.length < maxSwaps && skip <= MAX_SKIP_LIMIT) {
    const remaining = maxSwaps - all.length;
    const first = Math.min(batchSize, remaining);

    if (MAX_SKIP_LIMIT - skip <= 0 && skip > 0) {
      console.log(`[Historical MySQL] Reached maximum skip limit (${MAX_SKIP_LIMIT})`);
      break;
    }

    try {
      const response = await axios.post<SushiGraphResponse>(
        KATANA_SUBGRAPH_URL,
        {
          query: getHistoricalSwapsQuery(),
          variables: { poolId, olderThan: olderThanTimestampSec, first, skip },
        },
        { timeout: 15000, headers: { "Content-Type": "application/json" } }
      );

      const swaps = response.data?.data?.swaps ?? [];
      if (!swaps.length) {
        hasMore = false;
        break;
      }

      all.push(...swaps);

      if (swaps.length < first) {
        hasMore = false;
      } else {
        skip += batchSize;
      }

      console.log(
        `[Historical MySQL] Batch: skip=${skip}, received=${swaps.length}, total=${all.length}`
      );
    } catch (e: any) {
      console.error(
        `[Historical MySQL] Error fetching batch at skip ${skip}:`,
        e?.message ?? e
      );
      break;
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`[Historical MySQL] Fetch complete: ${all.length} swaps`);
  return all;
}

function checkUpdateLock(tokenAddress: string): boolean {
  const t = updateLocks.get(tokenAddress);
  if (!t) return false;
  if (Date.now() - t > UPDATE_LOCK_TIMEOUT) {
    updateLocks.delete(tokenAddress);
    return false;
  }
  return true;
}
function setUpdateLock(tokenAddress: string): void {
  updateLocks.set(tokenAddress, Date.now());
}
function clearUpdateLock(tokenAddress: string): void {
  updateLocks.delete(tokenAddress);
}

/* ===========================
 * Controller
 * =========================== */

export async function appendHistoricalKatanaSwapData(
  req: Request<
    {},
    {},
    {},
    { tokenAddress?: string; batchCount?: string }
  >,
  res: Response,
  _next: NextFunction
): Promise<void> {
  // Simple option: declare as union and use optional chaining for rollback/commit
  let transaction: Transaction | null = null;

  try {
    const { tokenAddress, batchCount = "1" } = req.query;

    // Validation
    if (!tokenAddress) {
      res.status(400).json({ status: "error", msg: "tokenAddress parameter is required" });
      return;
    }
    if (!/^0x[a-f0-9]{40}$/i.test(tokenAddress)) {
      res.status(422).json({ status: "error", msg: "Invalid tokenAddress format" });
      return;
    }

    const batchCountNum = parseInt(batchCount, 10);
    if (isNaN(batchCountNum) || batchCountNum < 1 || batchCountNum > 5) {
      res.status(400).json({
        status: "error",
        msg: "batchCount must be a number between 1 and 5",
      });
      return;
    }

    const normalizedAddress = tokenAddress.toLowerCase();

    console.log(
      `[Historical MySQL] Starting historical data append for: ${normalizedAddress}, batches: ${batchCountNum}`
    );

    await sushiLimiter.schedule(async () => {
      try {
        // Lock
        if (checkUpdateLock(normalizedAddress)) {
          res.status(423).json({
            status: "error",
            msg: "Update in progress for this token. Please try again later.",
            tokenAddress: normalizedAddress,
          });
          return;
        }
        setUpdateLock(normalizedAddress);

        // Step 1: Check MySQL first, then fallback to Redis if no data
        const existingCount = await KatanaSwap.count({
          where: { token_address: normalizedAddress },
        });

        let poolIdToUse: string;
        let oldestTimestamp: Date;
        let existingSwapForPoolInfo: ExistingSwapInfo;

        if (existingCount === 0) {
          console.log(`[Historical MySQL] No existing MySQL data, checking Redis...`);
          
          // Load from Redis
          const redisData = await loadRedisSwapData(normalizedAddress);
          
          if (!redisData) {
            clearUpdateLock(normalizedAddress);
            res.status(404).json({
              status: "error",
              msg: "No existing data found in MySQL or Redis. Please run regular fetch first to establish baseline data.",
              tokenAddress: normalizedAddress,
            });
            return;
          }

          // Use Redis data to determine pool and timestamp
          poolIdToUse = redisData.metadata.pool.id;
          oldestTimestamp = new Date(
            Math.min(...redisData.swaps.map(s => s.timestamp)) // Find oldest swap from Redis
          );
          existingSwapForPoolInfo = createSwapInfoFromRedis(redisData);

          console.log(`[Historical MySQL] Using Redis data:`, {
            poolId: poolIdToUse,
            oldestSwap: oldestTimestamp.toISOString(),
            swapsCount: redisData.swaps.length,
            isToken0: existingSwapForPoolInfo.is_token0,
          });

        } else {
          console.log(`[Historical MySQL] Found existing MySQL data: ${existingCount} swaps`);
          
          // Use MySQL data (existing logic)
          const [oldestSwap, existingSwapForPoolInfoRaw] = await Promise.all([
            KatanaSwap.findOne({
              attributes: ["timestamp"],
              where: { token_address: normalizedAddress },
              order: [["timestamp", "ASC"]],
              raw: true,
            }) as Promise<{ timestamp: Date } | null>,
            KatanaSwap.findOne({
              attributes: [
                "pool_id",
                "pool_token0_address",
                "pool_token0_symbol",
                "pool_token1_address",
                "pool_token1_symbol",
                "pool_fee_tier",
                "is_token0",
              ],
              where: { token_address: normalizedAddress },
              raw: true,
            }) as Promise<ExistingSwapInfo | null>,
          ]);

          if (!oldestSwap || !existingSwapForPoolInfoRaw) {
            clearUpdateLock(normalizedAddress);
            res.status(404).json({
              status: "error",
              msg: "No existing swap data found",
              tokenAddress: normalizedAddress,
            });
            return;
          }

          poolIdToUse = existingSwapForPoolInfoRaw.pool_id;
          oldestTimestamp = oldestSwap.timestamp;
          existingSwapForPoolInfo = existingSwapForPoolInfoRaw;
        }

        console.log(`[Historical MySQL] Current data stats:`, {
          totalSwaps: existingCount,
          oldestSwap: oldestTimestamp.toISOString(),
          poolId: existingSwapForPoolInfo.pool_id,
          isToken0: existingSwapForPoolInfo.is_token0,
          dataSource: existingCount > 0 ? 'MySQL' : 'Redis',
        });

        const isToken0 = existingSwapForPoolInfo.is_token0;

        console.log(`[Historical MySQL] Using pool: ${poolIdToUse}, isToken0: ${isToken0}`);

        // Fetch historical in batches
        let allHistorical: ProcessedSwap[] = [];

        const currentOldestSec = Math.floor(oldestTimestamp.getTime() / 1000);
        console.log(
          `[Historical MySQL] Current oldest timestamp: ${currentOldestSec} (${new Date(
            currentOldestSec * 1000
          ).toISOString()})`
        );

        for (let batch = 1; batch <= batchCountNum; batch++) {
          const olderThanSec =
            batch === 1
              ? currentOldestSec
              : Math.min(...allHistorical.map((s) => Math.floor(s.timestamp / 1000)));

          console.log(
            `[Historical MySQL] Starting batch ${batch}/${batchCountNum}, fetching swaps older than ${new Date(
              olderThanSec * 1000
            ).toISOString()}`
          );

          const historicalRaw = await fetchHistoricalSwaps(
            poolIdToUse.toLowerCase(),
            olderThanSec,
            MAX_TOTAL_SWAPS
          );

          if (historicalRaw.length === 0) {
            console.log(`[Historical MySQL] No more historical data available in batch ${batch}`);
            break;
          }

          const processed = processSwaps(historicalRaw, isToken0);
          allHistorical = [...allHistorical, ...processed];

          console.log(
            `[Historical MySQL] Batch ${batch} complete: ${processed.length} swaps added, total historical: ${allHistorical.length}`
          );

          if (processed.length > 0) {
            const newestInBatch = Math.max(...processed.map((s) => s.timestamp));
            const oldestInBatch = Math.min(...processed.map((s) => s.timestamp));
            console.log(
              `[Historical MySQL] Batch ${batch} time range: ${new Date(
                newestInBatch
              ).toISOString()} to ${new Date(oldestInBatch).toISOString()}`
            );
          }

          if (batch < batchCountNum) {
            console.log(`[Historical MySQL] Waiting 2 seconds before next batch...`);
            await new Promise((r) => setTimeout(r, 2000));
          }
        }

        if (allHistorical.length === 0) {
          clearUpdateLock(normalizedAddress);
          res.status(200).json({
            status: "success",
            msg: "No additional historical data found",
            tokenAddress: normalizedAddress,
            poolId: poolIdToUse,
            chain: "katana",
            stats: {
              existingSwaps: existingCount,
              historicalSwapsAdded: 0,
              totalSwaps: existingCount,
              batchesProcessed: 0,
            },
          });
          return;
        }

        console.log(`[Historical MySQL] Total historical swaps fetched: ${allHistorical.length}`);

        // Insert
        transaction = await sequelize.transaction();
        try {
          const rows = convertToModelFormat(allHistorical, existingSwapForPoolInfo, normalizedAddress);

          await KatanaSwap.bulkCreate(rows, {
            transaction,
            ignoreDuplicates: true,
          });

          await transaction.commit();
          transaction = null;

          console.log(`[Historical MySQL] Successfully inserted ${rows.length} swaps`);
        } catch (insertError: any) {
          await transaction?.rollback();
          transaction = null;
          throw insertError;
        }

        // Final stats
        const finalCount = await KatanaSwap.count({
          where: { token_address: normalizedAddress, pool_id: poolIdToUse.toLowerCase() },
        });

        const [oldestFinal, newestFinal] = await Promise.all([
          KatanaSwap.findOne({
            attributes: ["timestamp"],
            where: { token_address: normalizedAddress, pool_id: poolIdToUse.toLowerCase() },
            order: [["timestamp", "ASC"]],
            raw: true,
          }) as Promise<{ timestamp: Date } | null>,
          KatanaSwap.findOne({
            attributes: ["timestamp"],
            where: { token_address: normalizedAddress, pool_id: poolIdToUse.toLowerCase() },
            order: [["timestamp", "DESC"]],
            raw: true,
          }) as Promise<{ timestamp: Date } | null>,
        ]);

        clearUpdateLock(normalizedAddress);

        res.status(200).json({
          status: "success",
          msg: "Historical data appended successfully",
          tokenAddress: normalizedAddress,
          poolId: poolIdToUse.toLowerCase(),
          chain: "katana",
          dataSource: existingCount > 0 ? 'MySQL' : 'Redis-initiated',
          stats: {
            existingSwaps: existingCount,
            historicalSwapsAdded: allHistorical.length,
            totalSwaps: finalCount,
            batchesProcessed: batchCountNum,
          },
          dataRange: {
            oldStart: oldestTimestamp.toISOString(),
            newStart: oldestFinal?.timestamp.toISOString(),
            end: newestFinal?.timestamp.toISOString(),
            totalDaysAdded: oldestFinal
              ? Math.floor(
                  (oldestTimestamp.getTime() - oldestFinal.timestamp.getTime()) /
                    (24 * 60 * 60 * 1000)
                )
              : 0,
          },
          limits: { maxSwapsPerBatch: MAX_TOTAL_SWAPS, maxSkip: MAX_SKIP_LIMIT },
        });
      } catch (apiError: any) {
        await transaction?.rollback(); // optional chaining — simple & safe
        transaction = null;

        clearUpdateLock(normalizedAddress);

        console.error(`[Historical MySQL] API error:`, apiError?.message);
        res.status(500).json({
          status: "error",
          msg: "Failed to append historical swap data",
          debug: { error: apiError?.message },
        });
      } finally {
        // In case of any unhandled path where txn remained open:
        await transaction?.rollback().catch(() => {});
        transaction = null;
      }
    });
  } catch (error: any) {
    //@ts-ignore
    await transaction?.rollback().catch(() => {});
    transaction = null;

    if (req.query.tokenAddress) {
      clearUpdateLock(req.query.tokenAddress.toLowerCase());
    }

    console.error("[Historical MySQL] Controller error:", error);
    res.status(500).json({
      status: "error",
      msg: "Unexpected server error",
      debug: { error: error?.message },
    });
  }
}