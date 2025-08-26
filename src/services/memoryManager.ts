// services/memoryManager.ts
import { getValue, storeValue } from "../redis/katanaTokens";
import {
  StoredSwapData,
  CompressedSwapData,
  CompressedSwap,
  ProcessedSwap,
} from "../types/katanaSqrtPrice.types";
import {
  SQRT_PRICE_DATA_TTL,
  MAX_DATA_SIZE_MB,
  RECENT_DATA_DAYS,
  MEMORY_LOG_PREFIX,
} from "../constants/katanaSqrtPrice.constants";
import { KatanaLogger } from "../utils/logger";

export class MemoryManager {
  /**
   * Create swap ID set for O(1) duplicate detection
   */
  static createSwapIdSet(swaps: ProcessedSwap[]): Set<string> {
    const startTime = Date.now();
    const idSet = new Set(swaps.map((swap) => swap.id));

    KatanaLogger.performance(MEMORY_LOG_PREFIX, "createSwapIdSet", startTime, {
      swapCount: swaps.length,
      uniqueIds: idSet.size,
    });

    return idSet;
  }

  /**
   * Efficiently merge swaps with Set-based duplicate detection
   */
  static mergeSwapsEfficient(
    existingSwaps: ProcessedSwap[],
    newSwaps: ProcessedSwap[]
  ): ProcessedSwap[] {
    const startTime = Date.now();

    if (newSwaps.length === 0) {
      KatanaLogger.debug(MEMORY_LOG_PREFIX, "No new swaps to merge");
      return existingSwaps;
    }

    const existingIds = this.createSwapIdSet(existingSwaps);

    // Only add truly new swaps
    const uniqueNewSwaps = newSwaps.filter((swap) => !existingIds.has(swap.id));

    KatanaLogger.info(MEMORY_LOG_PREFIX, "Merge analysis", {
      existingCount: existingSwaps.length,
      newCount: newSwaps.length,
      uniqueNewCount: uniqueNewSwaps.length,
      duplicatesFiltered: newSwaps.length - uniqueNewSwaps.length,
    });

    if (uniqueNewSwaps.length === 0) {
      KatanaLogger.warn(MEMORY_LOG_PREFIX, "All new swaps were duplicates");
      return existingSwaps;
    }

    // Combine and sort
    const mergedSwaps = [...existingSwaps, ...uniqueNewSwaps];
    mergedSwaps.sort((a, b) => a.timestamp - b.timestamp);

    KatanaLogger.performance(
      MEMORY_LOG_PREFIX,
      "mergeSwapsEfficient",
      startTime,
      { finalCount: mergedSwaps.length }
    );

    return mergedSwaps;
  }

  /**
   * Convert to compressed format to reduce Redis memory usage
   */
  static compressSwapData(data: StoredSwapData): CompressedSwapData {
    const startTime = Date.now();

    const compressed: CompressedSwapData = {
      swaps: data.swaps.map(
        (swap): CompressedSwap => ({
          id: swap.id,
          ts: swap.timestamp,
          rp: swap.rawPoolPrice,
          tv: swap.tokenVolumeUSD,
          ttv: swap.totalVolumeUSD,
          sp: swap.sqrtPriceX96,
          tk: swap.tick,
        })
      ),
      metadata: data.metadata,
    };

    const originalSize = JSON.stringify(data).length;
    const compressedSize = JSON.stringify(compressed).length;
    const compressionRatio =
      ((originalSize - compressedSize) / originalSize) * 100;

    KatanaLogger.performance(MEMORY_LOG_PREFIX, "compressSwapData", startTime, {
      originalSize,
      compressedSize,
      compressionRatio: `${compressionRatio.toFixed(1)}%`,
      swapCount: data.swaps.length,
    });

    return compressed;
  }

  /**
   * Decompress back to full format
   */
  static decompressSwapData(compressed: CompressedSwapData): StoredSwapData {
    const startTime = Date.now();

    // Read scalingFactor from the correct location with a safe fallback
    const sf =
      compressed.metadata?.pool?.scalingFactor !== undefined
        ? compressed.metadata.pool.scalingFactor
        : 1;

    const decompressed: StoredSwapData = {
      swaps: compressed.swaps.map(
        (swap): ProcessedSwap => ({
          id: swap.id,
          timestamp: swap.ts,
          poolPrice: swap.rp * sf, // Recalculate on load using scalingFactor
          rawPoolPrice: swap.rp,
          tokenVolumeUSD: swap.tv,
          totalVolumeUSD: swap.ttv,
          sqrtPriceX96: swap.sp,
          tick: swap.tk,
        })
      ),
      metadata: compressed.metadata,
    };

    KatanaLogger.performance(
      MEMORY_LOG_PREFIX,
      "decompressSwapData",
      startTime,
      { swapCount: compressed.swaps.length }
    );

    return decompressed;
  }

  /**
   * Check data size (for logging/diagnostics only).
   * We always store as a single document (no chunking), but we still log size.
   */
  static calculateDataSize(data: unknown): { sizeInMB: number } {
    const jsonString = JSON.stringify(data);
    const sizeInMB = Buffer.byteLength(jsonString, "utf8") / (1024 * 1024);

    KatanaLogger.memory(MEMORY_LOG_PREFIX, "Data size calculated", sizeInMB);

    return { sizeInMB };
  }

  /**
   * Save only recent data if memory constrained (fallback)
   */
  static async saveOnlyRecentData(
    cacheKey: string,
    partialData: StoredSwapData,
    lastFetchedTimestamp: number
  ): Promise<void> {
    const startTime = Date.now();

    try {
      const cutoffTime =
        Date.now() - RECENT_DATA_DAYS * 24 * 60 * 60 * 1000;
      const recentSwaps = partialData.swaps.filter(
        (swap) => swap.timestamp >= cutoffTime
      );

      KatanaLogger.info(MEMORY_LOG_PREFIX, "Saving reduced dataset", {
        originalCount: partialData.swaps.length,
        recentCount: recentSwaps.length,
        cutoffDays: RECENT_DATA_DAYS,
      });

      const reducedData: StoredSwapData = {
        ...partialData,
        swaps: recentSwaps,
      };

      const compressed = this.compressSwapData(reducedData);
      await storeValue(
        `${cacheKey}_recent`,
        JSON.stringify(compressed),
        SQRT_PRICE_DATA_TTL
      );

      KatanaLogger.performance(
        MEMORY_LOG_PREFIX,
        "saveOnlyRecentData",
        startTime,
        { savedCount: recentSwaps.length }
      );
    } catch (error) {
      KatanaLogger.error(
        MEMORY_LOG_PREFIX,
        "Failed to save reduced data",
        error
      );
      throw error;
    }
  }

  /**
   * Main save function — ALWAYS stores as a SINGLE document (no chunking).
   */
  static async saveWithOptimalStrategy(
    cacheKey: string,
    partialData: StoredSwapData,
    batchNumber: number,
    lastFetchedTimestamp: number,
    isComplete: boolean = false
  ): Promise<void> {
    const startTime = Date.now();

    try {
      // Update fetch progress
      if (!partialData.metadata.fetchProgress) {
        partialData.metadata.fetchProgress = {
          lastFetchedTimestamp: lastFetchedTimestamp,
          totalBatches: Math.ceil(30000 / 1000), // Default for diagnostics
          completedBatches: 0,
          isComplete: false,
          failedRanges: [],
          lastBatchSize: 1000,
        };
      }

      partialData.metadata.fetchProgress.lastFetchedTimestamp =
        lastFetchedTimestamp;
      partialData.metadata.fetchProgress.completedBatches = batchNumber;
      partialData.metadata.fetchProgress.isComplete = isComplete;

      // Compress data first
      const compressed = this.compressSwapData(partialData);
      const { sizeInMB } = this.calculateDataSize(compressed);

      // Always store a single document
      if (sizeInMB > MAX_DATA_SIZE_MB) {
        KatanaLogger.warn(
          MEMORY_LOG_PREFIX,
          "Data size exceeds recommended threshold, still storing as single document",
          { sizeInMB, thresholdMB: MAX_DATA_SIZE_MB }
        );
      }

      await storeValue(cacheKey, JSON.stringify(compressed), SQRT_PRICE_DATA_TTL);
      KatanaLogger.cache(MEMORY_LOG_PREFIX, "save", cacheKey, { sizeInMB });

      KatanaLogger.progress(
        MEMORY_LOG_PREFIX,
        batchNumber,
        partialData.metadata.fetchProgress.totalBatches,
        {
          swapCount: partialData.swaps.length,
          lastTimestamp: lastFetchedTimestamp,
        }
      );
    } catch (error: any) {
      KatanaLogger.error(MEMORY_LOG_PREFIX, "Save failed", error);

      // Fallback strategy
      if (error.message?.includes("OOM") || error.message?.includes("memory")) {
        KatanaLogger.warn(
          MEMORY_LOG_PREFIX,
          "Memory error detected, trying fallback (recent-only)"
        );
        await this.saveOnlyRecentData(
          cacheKey,
          partialData,
          lastFetchedTimestamp
        );
      } else {
        throw error;
      }
    }

    KatanaLogger.performance(
      MEMORY_LOG_PREFIX,
      "saveWithOptimalStrategy",
      startTime
    );
  }

  /**
   * Load stored data (single document) with recent-data fallback.
   */
  static async loadStoredData(cacheKey: string): Promise<StoredSwapData | null> {
    const startTime = Date.now();

    try {
      // Try to load main compressed data
      const cached = await getValue(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        KatanaLogger.cache(MEMORY_LOG_PREFIX, "hit", cacheKey);

        // If compressed format, decompress
        if (parsed.swaps && parsed.swaps[0] && "ts" in parsed.swaps[0]) {
          return this.decompressSwapData(parsed);
        }
        // Legacy format
        return parsed as StoredSwapData;
      }

      // Try to load recent-data fallback
      const recentCached = await getValue(`${cacheKey}_recent`);
      if (recentCached) {
        const parsed = JSON.parse(recentCached);
        KatanaLogger.cache(MEMORY_LOG_PREFIX, "hit", `${cacheKey}_recent`);
        return this.decompressSwapData(parsed);
      }

      KatanaLogger.cache(MEMORY_LOG_PREFIX, "miss", cacheKey);
      return null;
    } catch (error) {
      KatanaLogger.error(MEMORY_LOG_PREFIX, "Failed to load stored data", error);
      return null;
    } finally {
      KatanaLogger.performance(
        MEMORY_LOG_PREFIX,
        "loadStoredData",
        startTime
      );
    }
  }
}
