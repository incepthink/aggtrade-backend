/**
 * XP Preview Controller
 *
 * Provides real-time XP preview endpoints with Redis caching.
 * Cache is invalidated when users perform swaps.
 */

import type { Request, Response, NextFunction } from "express"
import { calculateXPForWallet } from "../../services/xpCalculation"
import { getCurrentWeekRange } from "../../cron-jobs/xp-distribution/utils/timeUtils"
import { redis } from "../../redis"
import { KatanaLogger } from "../../utils/logger"
import type { XPPreviewResult } from "../../types/xp"

const LOG_PREFIX = "[XP-PREVIEW]"

/**
 * Generate Redis cache key for XP preview
 * Format: xp:preview:{wallet_address_lowercase}:{week_start_timestamp}
 */
function getCacheKey(walletAddress: string, weekStart: Date): string {
  return `xp:preview:${walletAddress.toLowerCase()}:${weekStart.getTime()}`
}

/**
 * GET /api/xp/preview/:walletAddress
 * Get real-time XP preview for a wallet address
 *
 * Response includes:
 * - All XP calculation data (swap XP, pair bonus, league, etc.)
 * - cached: true/false flag indicating if data came from cache
 * - calculated_at: timestamp when data was calculated
 */
export const getXPPreview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { walletAddress } = req.params

    if (!walletAddress) {
      return res.status(400).json({
        error: 'Missing required parameter: walletAddress'
      })
    }

    // Normalize wallet address
    const normalizedWallet = walletAddress.toLowerCase()

    // Get current week range
    const { weekStart, weekEnd } = getCurrentWeekRange()

    // Generate cache key
    const cacheKey = getCacheKey(normalizedWallet, weekStart)

    KatanaLogger.info(LOG_PREFIX, "Fetching XP preview", {
      walletAddress: normalizedWallet,
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      cacheKey
    })

    // Check Redis cache
    const cachedData = await redis.get(cacheKey)

    if (cachedData) {
      KatanaLogger.info(LOG_PREFIX, "Cache hit", {
        walletAddress: normalizedWallet,
        cacheKey
      })

      const parsedData = JSON.parse(cachedData)
      return res.status(200).json({
        ...parsedData,
        cached: true
      })
    }

    KatanaLogger.info(LOG_PREFIX, "Cache miss - calculating XP", {
      walletAddress: normalizedWallet,
      cacheKey
    })

    // Calculate XP using the shared service
    const xpResult = await calculateXPForWallet(
      normalizedWallet,
      weekStart,
      weekEnd
    )

    if (!xpResult) {
      return res.status(404).json({
        error: 'Unable to calculate XP for wallet address',
        walletAddress: normalizedWallet
      })
    }

    // Prepare response data
    const responseData = {
      wallet_address: xpResult.walletAddress,
      user_id: xpResult.userId,
      week_start: xpResult.weekStart.toISOString(),
      week_end: xpResult.weekEnd.toISOString(),
      league: xpResult.league,
      swap_xp_raw: xpResult.swap_xp_raw,
      swap_xp_decayed: xpResult.swap_xp_decayed,
      pair_bonus_xp: xpResult.pair_bonus_xp,
      total_xp: xpResult.total_xp,
      eligible_volume: xpResult.eligible_volume,
      total_fees: xpResult.total_fees,
      unique_pairs_count: xpResult.unique_pairs_count,
      new_pairs_count: xpResult.new_pairs_count,
      total_swaps: xpResult.total_swaps,
      per_pair_results: xpResult.perPairResults,
      new_pairs: xpResult.newPairs,
      swap_type_breakdown: xpResult.swapTypeBreakdown,
      is_preview: true,
      calculated_at: new Date().toISOString()
    }

    // Store in Redis without expiration (cache persists until invalidated)
    await redis.set(cacheKey, JSON.stringify(responseData))

    KatanaLogger.info(LOG_PREFIX, "XP calculated and cached", {
      walletAddress: normalizedWallet,
      total_xp: xpResult.total_xp,
      league: xpResult.league,
      cacheKey
    })

    return res.status(200).json({
      ...responseData,
      cached: false
    })

  } catch (error) {
    KatanaLogger.error(LOG_PREFIX, "Error getting XP preview", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    })
    next(error)
  }
}

/**
 * Invalidate XP cache for a wallet address
 * Called when user performs a swap to ensure fresh data on next preview
 *
 * @param walletAddress - Wallet address (will be normalized to lowercase)
 */
export async function invalidateXPCache(walletAddress: string): Promise<void> {
  try {
    const normalizedWallet = walletAddress.toLowerCase()
    const { weekStart } = getCurrentWeekRange()
    const cacheKey = getCacheKey(normalizedWallet, weekStart)

    const result = await redis.del(cacheKey)

    if (result === 1) {
      KatanaLogger.info(LOG_PREFIX, "Cache invalidated", {
        walletAddress: normalizedWallet,
        cacheKey
      })
    } else {
      KatanaLogger.info(LOG_PREFIX, "No cache to invalidate", {
        walletAddress: normalizedWallet,
        cacheKey
      })
    }
  } catch (error) {
    KatanaLogger.error(LOG_PREFIX, "Error invalidating cache", {
      walletAddress,
      error: error instanceof Error ? error.message : String(error)
    })
    // Don't throw - cache invalidation failure shouldn't block swap creation
  }
}
