/**
 * Unique Pair Bonus (UPB) Service
 *
 * Calculates weekly XP bonus for trading new pairs (first-time ever).
 * Formula: 25 XP per new pair, capped at 4 pairs (100 XP maximum).
 */

import { Op } from "sequelize"
import SushiswapActivity from "../../../models/SushiswapActivity"
import { KatanaLogger } from "../../../utils/logger"
import { normalizePair, PairEligibleVolume } from "./eligibleVolume"
import { UPB_CONFIG } from "../config/bandDecay"

const LOG_PREFIX = "[XP-UPB]"

/**
 * Result interface for unique pair bonus calculation
 */
export interface UniquePairBonusResult {
  xp_pair_bonus: number        // XP bonus awarded (0-100)
  countOfNewPairs: number       // Total count of new pairs found
  cappedCount: number           // Count after applying cap (max 4)
  newPairs: string[]            // List of new pair keys
  totalHistoricalPairs: number  // Count of all historical pairs
}

/**
 * Calculate unique pair bonus for a user
 *
 * @param userId - User ID to calculate bonus for
 * @param thisWeekEligiblePairs - This week's eligible pairs from getEligibleVolumeAndFees
 * @param weekStart - Start of the current week (Monday 00:00 UTC)
 * @returns UniquePairBonusResult with bonus details
 *
 * Algorithm:
 * 1. Query all historical swaps before weekStart
 * 2. Build Set of all historical pairs (normalized)
 * 3. Compare this week's pairs against historical Set
 * 4. Count pairs in this week but NOT in historical (new pairs)
 * 5. Apply formula: 25 * min(count, 4)
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
  // STEP 1: Query all historical swaps (before this week)
  // ============================================================================

  KatanaLogger.info(LOG_PREFIX, "Querying historical swaps", {
    userId,
    beforeTimestamp: weekStart.toISOString()
  })

  const historicalSwaps = await SushiswapActivity.findAll({
    where: {
      user_id: userId,
      swap_type: {
        [Op.in]: ['CLASSIC', 'LIMIT_ORDER']
      },
      status: "success",
      timestamp: {
        [Op.lt]: weekStart
      }
    },
    attributes: ["token_from_address", "token_to_address"]
  })

  KatanaLogger.info(LOG_PREFIX, "Historical swaps fetched", {
    totalHistoricalSwaps: historicalSwaps.length,
    queryTimeMs: Date.now() - startTime
  })

  // ============================================================================
  // STEP 2: Build Set of all historical pairs (normalized)
  // ============================================================================

  const historicalPairs = new Set<string>()

  for (const swap of historicalSwaps) {
    const pair = normalizePair(swap.token_from_address, swap.token_to_address)
    historicalPairs.add(pair)
  }

  KatanaLogger.info(LOG_PREFIX, "Historical pairs normalized", {
    totalHistoricalSwaps: historicalSwaps.length,
    uniqueHistoricalPairs: historicalPairs.size
  })

  // ============================================================================
  // STEP 3: Compare this week's pairs against historical Set
  // ============================================================================

  const newPairs: string[] = []

  for (const pairData of thisWeekEligiblePairs) {
    if (!historicalPairs.has(pairData.pair)) {
      newPairs.push(pairData.pair)
      KatanaLogger.info(LOG_PREFIX, "New pair identified", {
        pair: pairData.pair,
        eligibleVolume: pairData.eligibleVolume,
        totalFees: pairData.totalFees
      })
    }
  }

  const countOfNewPairs = newPairs.length

  KatanaLogger.info(LOG_PREFIX, "New pairs identified", {
    countOfNewPairs,
    newPairsList: newPairs.map(p => {
      const [token0, token1] = p.split('-')
      return `${token0.slice(0, 8)}/${token1.slice(0, 8)}`
    })
  })

  // Edge case: No new pairs found
  if (countOfNewPairs === 0) {
    KatanaLogger.info(LOG_PREFIX, "No new pairs found, returning 0 bonus")
    return {
      xp_pair_bonus: 0,
      countOfNewPairs: 0,
      cappedCount: 0,
      newPairs: [],
      totalHistoricalPairs: historicalPairs.size
    }
  }

  // ============================================================================
  // STEP 4: Apply formula with cap
  // ============================================================================

  const cappedCount = Math.min(countOfNewPairs, UPB_CONFIG.MAX_NEW_PAIRS)
  const xp_pair_bonus = UPB_CONFIG.XP_PER_NEW_PAIR * cappedCount

  KatanaLogger.info(LOG_PREFIX, "Unique pair bonus calculated", {
    countOfNewPairs,
    cappedCount,
    xp_pair_bonus,
    formula: `${UPB_CONFIG.XP_PER_NEW_PAIR} * min(${countOfNewPairs}, ${UPB_CONFIG.MAX_NEW_PAIRS}) = ${xp_pair_bonus}`,
    totalHistoricalPairs: historicalPairs.size,
    executionTimeMs: Date.now() - startTime
  })

  return {
    xp_pair_bonus,
    countOfNewPairs,
    cappedCount,
    newPairs,
    totalHistoricalPairs: historicalPairs.size
  }
}
