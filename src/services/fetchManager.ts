// services/fetchManager.ts
import {
  StoredSwapData,
  SwapDataWithSqrt,
  FetchConfig,
  ProcessedSwap,
} from "../types/katanaSqrtPrice.types";
import {
  BATCH_SIZE,
  MAX_SKIP,
  MAX_FAILED_RANGES,
  BATCH_DELAY,
  ERROR_DELAY,
  FETCH_LOG_PREFIX,
} from "../constants/katanaSqrtPrice.constants";
import { KatanaLogger } from "../utils/logger";
import { MemoryManager } from "./memoryManager";
import { PriceCalculator } from "./priceCalculator";
import { ApiService } from "./apiService";

export class FetchManager {
  /**
   * Fetch swaps using ONLY skip-based pagination (no timestamp-based pagination).
   * Notes:
   * - The GraphQL query in ApiService must use `orderDirection: desc` (newest-first).
   * - We can only paginate up to the Graph's skip limit (e.g., 5000). We stop when `skip > config.maxSkip`.
   * - We collect up to `config.maxSwaps` swaps and save them TOGETHER in a single Redis document at the end.
   */
  static async fetchSwapsWithOptimizedPersistence(
    config: FetchConfig,
    cacheKey: string,
    existingData: StoredSwapData | null,
    scalingFactor: number,
    tokenAddress: string,
    isToken0: boolean
  ): Promise<void> {
    const fetchStartTime = Date.now();

    KatanaLogger.info(FETCH_LOG_PREFIX, "Starting skip-only fetch (single save)", {
      poolId: config.poolId.substring(0, 10) + "...",
      timeRange: `${config.startTime}-${config.endTime}`,
      batchSize: config.batchSize,
      maxSwaps: config.maxSwaps,
      maxSkip: config.maxSkip,
      hasExistingData: !!existingData,
    });

    // Pagination tracking
    let batchNumber = 0;
    let skip = 0;
    let hasMore = true;

    // Bookkeeping for progress (seconds)
    let latestSeenTsSec = config.startTime;

    // Collect ALL raw swaps here; we'll process & save ONCE at the end.
    const allRawSwaps: SwapDataWithSqrt[] = [];

    // Deduplicate across pages (and vs. stored) using a Set of IDs
    const existingSwapIds: Set<string> = existingData
      ? MemoryManager.createSwapIdSet(existingData.swaps as ProcessedSwap[])
      : new Set<string>();

    // Initialize metadata scaffold; final data will overwrite swaps
    const partialData: StoredSwapData = this.initializePartialData(
      existingData,
      config,
      isToken0
    );

    while (hasMore && allRawSwaps.length < config.maxSwaps) {
      if (skip > config.maxSkip) {
        KatanaLogger.warn(FETCH_LOG_PREFIX, "Reached max skip cap; stopping.", {
          skip,
          maxSkip: config.maxSkip,
        });
        break;
      }

      const remaining = config.maxSwaps - allRawSwaps.length;
      const first = Math.min(config.batchSize, remaining);

      const batchConfig = {
        poolId: config.poolId,
        startTime: config.startTime,
        endTime: config.endTime,
        first,
        skip,
      };

      KatanaLogger.batch(FETCH_LOG_PREFIX, batchNumber + 1, "skip", batchConfig);

      try {
        // Expect newest-first due to ApiService query (orderDirection: desc)
        const swaps: SwapDataWithSqrt[] = await ApiService.fetchSwapsWithSqrtPrice(
          batchConfig.poolId,
          batchConfig.startTime,
          batchConfig.endTime,
          batchConfig.first,
          batchConfig.skip
        );

        const pageCount = swaps.length;

        // Filter out IDs we already know about (from storage or earlier pages)
        const fresh = swaps.filter((s: SwapDataWithSqrt) => !existingSwapIds.has(s.id));
        for (const s of fresh) existingSwapIds.add(s.id);

        // Append into our single buffer
        allRawSwaps.push(...fresh);

        // Track newest timestamp seen (for progress)
        if (swaps.length > 0) {
          const newestTs = swaps
            .map((s: SwapDataWithSqrt) => parseInt(s.timestamp, 10))
            .reduce((a: number, b: number) => Math.max(a, b), latestSeenTsSec);
          if (Number.isFinite(newestTs)) latestSeenTsSec = newestTs;
        }

        batchNumber++;

        // Stop conditions
        if (pageCount < first) {
          hasMore = false;
        } else {
          skip += first; // skip-only pagination
        }

        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
      } catch (error: any) {
        // Record failure and keep going (still skip-only)
        await this.handleBatchError(
          error,
          batchNumber,
          partialData,
          cacheKey,
          config.startTime,
          config.endTime,
          latestSeenTsSec
        );

        batchNumber++;

        // Too many failures? bail.
        if (partialData.metadata.fetchProgress.failedRanges.length >= MAX_FAILED_RANGES) {
          KatanaLogger.error(FETCH_LOG_PREFIX, "Too many batch failures, stopping fetch", {
            failedRanges: partialData.metadata.fetchProgress.failedRanges.length,
          });
          break;
        }

        // If it's clearly the skip-cap, stop
        if (
          typeof error?.message === "string" &&
          error.message.toLowerCase().includes("skip") &&
          error.message.toLowerCase().includes("5000")
        ) {
          KatanaLogger.warn(FETCH_LOG_PREFIX, "Skip cap error encountered; stopping.");
          break;
        }

        // Otherwise, attempt to continue by skipping ahead
        skip += Math.min(config.batchSize, config.maxSwaps);
        await new Promise((resolve) => setTimeout(resolve, ERROR_DELAY));
      }
    }

    // ---- FINAL SINGLE SAVE: process all collected swaps and write ONE Redis document ----
    await this.processAllAndSave(
      allRawSwaps,
      partialData,
      cacheKey,
      batchNumber,
      latestSeenTsSec,
      true, // complete
      {
        tokenAddress,
        isToken0,
        scalingFactor,
      }
    );

    const totalDuration = Date.now() - fetchStartTime;
    KatanaLogger.performance(
      FETCH_LOG_PREFIX,
      "fetchSwapsWithOptimizedPersistence",
      fetchStartTime,
      {
        totalBatches: batchNumber,
        totalSwaps: partialData.swaps.length,
        durationMinutes: `${(totalDuration / 60000).toFixed(2)}min`,
        failedRanges: partialData.metadata.fetchProgress.failedRanges.length,
      }
    );
  }

  /**
   * Initialize partial data structure used across the fetch.
   */
  private static initializePartialData(
    existingData: StoredSwapData | null,
    config: FetchConfig,
    isToken0: boolean
  ): StoredSwapData {
    if (existingData) {
      return {
        ...existingData,
        metadata: {
          ...existingData.metadata,
          fetchProgress:
            existingData.metadata.fetchProgress || {
              lastFetchedTimestamp: config.startTime,
              totalBatches: Math.ceil(config.maxSwaps / config.batchSize),
              completedBatches: 0,
              isComplete: false,
              failedRanges: [],
              lastBatchSize: config.batchSize,
            },
        },
      };
    }

    return {
      swaps: [],
      metadata: {
        token: {} as any,
        pool: {} as any,
        isToken0,
        quoteToken: {} as any,
        lastUpdate: Math.floor(Date.now() / 1000),
        lastSwapTimestamp: config.startTime * 1000,
        dataRange: {
          start: config.startTime * 1000,
          end: config.endTime * 1000,
        },
        chain: "katana",
        dexId: "katana-sushiswap",
        fetchProgress: {
          lastFetchedTimestamp: config.startTime,
          totalBatches: Math.ceil(config.maxSwaps / config.batchSize),
          completedBatches: 0,
          isComplete: false,
          failedRanges: [],
          lastBatchSize: config.batchSize,
        },
      },
    };
  }

  /**
   * Process ALL collected raw swaps (≤ 6000 by config), REPLACE partialData.swaps,
   * then persist everything TOGETHER in a single Redis document.
   */
  private static async processAllAndSave(
    allRawSwaps: SwapDataWithSqrt[],
    partialData: StoredSwapData,
    cacheKey: string,
    batchNumber: number,
    lastProcessedTimestampSec: number,
    isComplete: boolean,
    processingConfig: {
      tokenAddress: string;
      isToken0: boolean;
      scalingFactor: number;
    }
  ): Promise<void> {
    const processStartTime = Date.now();

    try {
      // Ensure we don't exceed the contract: keep only up to config.maxSwaps (<= 6000 typical)
      // The caller loop already limits, but we clamp here for safety.
      const limited = allRawSwaps.slice(0);

      // Sort ascending to provide chronological order to downstream consumers
      const sorted: SwapDataWithSqrt[] = limited.sort(
        (a: SwapDataWithSqrt, b: SwapDataWithSqrt) =>
          parseInt(a.timestamp, 10) - parseInt(b.timestamp, 10)
      );

      // Scale + convert into ProcessedSwap[]
      const processed: ProcessedSwap[] =
        PriceCalculator.processSwapsWithHybridScaling(
          sorted,
          processingConfig.tokenAddress,
          processingConfig.isToken0,
          processingConfig.scalingFactor
        );

      // REPLACE (do NOT merge): we want exactly these (≤6000) in a single document
      partialData.swaps = processed;

      // Update metadata window
      if (processed.length > 0) {
        const firstTs = processed[0].timestamp;
        const lastTs = processed[processed.length - 1].timestamp;
        partialData.metadata.lastSwapTimestamp = lastTs;
        partialData.metadata.dataRange.start = firstTs;
        partialData.metadata.dataRange.end = lastTs;
      }

      // Persist ONCE (MemoryManager will store as a single value since size is small enough)
      await MemoryManager.saveWithOptimalStrategy(
        cacheKey,
        partialData,
        batchNumber,
        lastProcessedTimestampSec,
        isComplete
      );

      KatanaLogger.performance(
        FETCH_LOG_PREFIX,
        "processAllAndSave",
        processStartTime,
        {
          keptCount: processed.length,
          lastProcessedTimestampSec,
          isComplete,
        }
      );
    } catch (error: any) {
      KatanaLogger.error(
        FETCH_LOG_PREFIX,
        "Failed to process all swaps and save",
        error,
        { collectedCount: allRawSwaps.length, batchNumber }
      );
      throw error;
    }
  }

  /**
   * Handle batch fetch errors: record a coarse failed range and persist progress.
   */
  private static async handleBatchError(
    error: any,
    batchNumber: number,
    partialData: StoredSwapData,
    cacheKey: string,
    startTime: number,
    endTime: number,
    lastProcessedTimestampSec: number
  ): Promise<void> {
    KatanaLogger.error(
      FETCH_LOG_PREFIX,
      `Error in batch ${batchNumber + 1}`,
      error
    );

    partialData.metadata.fetchProgress.failedRanges.push({
      start: startTime,
      end: endTime,
      error: (error && error.message) || "unknown error",
    });

    try {
      await MemoryManager.saveWithOptimalStrategy(
        cacheKey,
        partialData,
        batchNumber,
        lastProcessedTimestampSec,
        false
      );
    } catch (saveError: any) {
      KatanaLogger.error(
        FETCH_LOG_PREFIX,
        "Failed to save progress after error",
        saveError
      );
    }
  }

  /**
   * Calculate time ranges for different fetch strategies (kept for compatibility).
   */
  static getTimeRange(
    strategy: "full" | "incremental" | "resume",
    lastSwapTimestamp?: number,
    lastFetchedTimestamp?: number,
    fullDataDays: number = 365
  ): { startTime: number; endTime: number } {
    const endTime = Math.floor(Date.now() / 1000);

    switch (strategy) {
      case "full": {
        const startTime = endTime - fullDataDays * 24 * 60 * 60;
        KatanaLogger.info(FETCH_LOG_PREFIX, "Full time range calculated", {
          startTime,
          endTime,
          days: fullDataDays,
        });
        return { startTime, endTime };
      }

      case "incremental": {
        if (!lastSwapTimestamp) {
          throw new Error("lastSwapTimestamp required for incremental fetch");
        }
        const incrementalStart = Math.floor(lastSwapTimestamp / 1000) + 1;
        KatanaLogger.info(FETCH_LOG_PREFIX, "Incremental time range calculated", {
          startTime: incrementalStart,
          endTime,
          lastSwapTimestamp,
        });
        return { startTime: incrementalStart, endTime };
      }

      case "resume": {
        if (!lastFetchedTimestamp) {
          throw new Error("lastFetchedTimestamp required for resume fetch");
        }
        const resumeStart = lastFetchedTimestamp + 1;
        KatanaLogger.info(FETCH_LOG_PREFIX, "Resume time range calculated", {
          startTime: resumeStart,
          endTime,
          lastFetchedTimestamp,
        });
        return { startTime: resumeStart, endTime };
      }

      default:
        throw new Error(`Unknown fetch strategy: ${strategy}`);
    }
  }

  /**
   * Create fetch configuration
   */
  static createFetchConfig(
    poolId: string,
    startTime: number,
    endTime: number,
    maxSwaps: number = 6000 // "last N" default aligned with your requirement
  ): FetchConfig {
    const config: FetchConfig = {
      poolId,
      startTime,
      endTime,
      maxSwaps,
      batchSize: BATCH_SIZE,
      maxSkip: MAX_SKIP, // must be <= 5000 to respect The Graph's skip cap
      saveProgressEveryNBatches: 999999, // effectively disable mid-run saves (we save once at the end)
    };

    KatanaLogger.info(FETCH_LOG_PREFIX, "Fetch configuration created", config);
    return config;
  }

  /**
   * Validate fetch configuration
   */
  static validateFetchConfig(config: FetchConfig): boolean {
    const issues: string[] = [];

    if (!config.poolId || config.poolId.length !== 42) {
      issues.push("Invalid poolId format");
    }
    if (config.startTime >= config.endTime) {
      issues.push("startTime must be before endTime");
    }
    if (config.maxSwaps <= 0) {
      issues.push("maxSwaps must be positive");
    }
    if (config.batchSize <= 0 || config.batchSize > 1000) {
      issues.push("batchSize must be between 1 and 1000");
    }

    if (issues.length > 0) {
      KatanaLogger.error(
        FETCH_LOG_PREFIX,
        "Invalid fetch configuration",
        undefined,
        { issues, config }
      );
      return false;
    }

    return true;
  }

  /**
   * Estimate fetch duration and resource usage
   */
  static estimateFetchRequirements(config: FetchConfig): {
    estimatedBatches: number;
    estimatedDurationMinutes: number;
    estimatedMemoryMB: number;
  } {
    const effectiveMax = Math.min(config.maxSwaps, config.maxSkip + config.batchSize);
    const estimatedBatches = Math.ceil(effectiveMax / config.batchSize);
    const estimatedDurationMinutes = estimatedBatches * 0.75; // ~45s/batch incl. delays
    const estimatedMemoryMB = (effectiveMax * 200) / (1024 * 1024); // ~200B per swap

    const estimates = {
      estimatedBatches,
      estimatedDurationMinutes,
      estimatedMemoryMB,
    };

    KatanaLogger.info(FETCH_LOG_PREFIX, "Fetch requirements estimated", estimates);
    return estimates;
  }
}
