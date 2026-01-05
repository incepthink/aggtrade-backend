/**
 * Unique Pair Bonus (UPB) Service
 *
 * Calculates weekly XP bonus for trading unique pairs within the current week.
 * Formula: 25 XP per unique pair, capped at 4 pairs (100 XP maximum).
 */

import { KatanaLogger } from "../../../utils/logger"
import { PairEligibleVolume } from "./eligibleVolume"
import { UPB_CONFIG } from "../config/bandDecay"

const LOG_PREFIX = "[XP-UPB]"

/**
 * Result interface for unique pair bonus calculation
 */
export interface UniquePairBonusResult {
  xp_pair_bonus: number        // XP bonus awarded (0-100)
  countOfNewPairs: number       // Total count of unique pairs this week
  cappedCount: number           // Count after applying cap (max 4)
  newPairs: string[]            // List of unique pair keys from this week
  totalHistoricalPairs: number  // Always 0 (historical tracking removed)
}

/**
 * Calculate unique pair bonus for a user
 *
 * @param userId - User ID to calculate bonus for (not used in current implementation)
 * @param thisWeekEligiblePairs - This week's eligible pairs from getEligibleVolumeAndFees
 * @param weekStart - Start of the current week (not used in current implementation)
 * @returns UniquePairBonusResult with bonus details
 *
 * Algorithm:
 * 1. Count unique pairs from this week's eligible pairs
 * 2. Apply formula: 25 * min(count, 4)
 */
export async function calculateUniquePairBonus(
  userId: number,
  thisWeekEligiblePairs: PairEligibleVolume[],
  weekStart: Date
): Promise<UniquePairBonusResult> {
  const startTime = Date.now()

  // Check if UPB is enabled in config
  if (!UPB_CONFIG.ENABLED) {
    KatanaLogger.info(LOG_PREFIX, "UPB is disabled in config, returning 0 bonus")
    return {
      xp_pair_bonus: 0,
      countOfNewPairs: 0,
      cappedCount: 0,
      newPairs: [],
      totalHistoricalPairs: 0
    }
  }

  KatanaLogger.info(LOG_PREFIX, "Starting unique pair bonus calculation", {
    userId,
    weekStart: weekStart.toISOString(),
    thisWeekEligiblePairs: thisWeekEligiblePairs.length
  })

  // Edge case: No eligible pairs this week
  if (thisWeekEligiblePairs.length === 0) {
    KatanaLogger.info(LOG_PREFIX, "No eligible pairs this week, returning 0 bonus")
    return {
      xp_pair_bonus: 0,
      countOfNewPairs: 0,
      cappedCount: 0,
      newPairs: [],
      totalHistoricalPairs: 0
    }
  }

  // ============================================================================
  // STEP 1: Count unique pairs from this week
  // ============================================================================

  const uniquePairsThisWeek = thisWeekEligiblePairs.map(p => p.pair)
  const countOfNewPairs = uniquePairsThisWeek.length

  KatanaLogger.info(LOG_PREFIX, "Unique pairs identified from this week", {
    countOfUniquePairs: countOfNewPairs,
    uniquePairsList: uniquePairsThisWeek.map(p => {
      const [token0, token1] = p.split('-')
      return `${token0.slice(0, 8)}/${token1.slice(0, 8)}`
    })
  })

  // ============================================================================
  // STEP 2: Apply formula with cap
  // ============================================================================

  const cappedCount = Math.min(countOfNewPairs, UPB_CONFIG.MAX_NEW_PAIRS)
  const xp_pair_bonus = UPB_CONFIG.XP_PER_NEW_PAIR * cappedCount

  KatanaLogger.info(LOG_PREFIX, "Unique pair bonus calculated", {
    countOfUniquePairs: countOfNewPairs,
    cappedCount,
    xp_pair_bonus,
    formula: `${UPB_CONFIG.XP_PER_NEW_PAIR} * min(${countOfNewPairs}, ${UPB_CONFIG.MAX_NEW_PAIRS}) = ${xp_pair_bonus}`,
    executionTimeMs: Date.now() - startTime
  })

  return {
    xp_pair_bonus,
    countOfNewPairs,
    cappedCount,
    newPairs: uniquePairsThisWeek,
    totalHistoricalPairs: 0
  }
}
