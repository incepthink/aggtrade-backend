/**
 * XP Calculation Service
 *
 * Provides pure calculation functions for XP calculations.
 * Used by both:
 * - Weekly settlement job (src/cron-jobs/xp-distribution/index.ts)
 * - Real-time preview endpoint
 *
 * This service performs NO database writes - only reads and calculations.
 */

import { Op } from "sequelize"
import { User } from "../models"
import SushiswapActivity from "../models/SushiswapActivity"
import { getEligibleVolumeAndFees } from "../cron-jobs/xp-distribution/services/eligibleVolume"
import { determineLeague, apply_band_decay_by_pair } from "../cron-jobs/xp-distribution/services/bandDecay"
import { calculateUniquePairBonus, UniquePairBonusResult } from "../cron-jobs/xp-distribution/services/uniquePairBonus"
import { XPPreviewResult, XPPairResult } from "../types/xp"
import { KatanaLogger } from "../utils/logger"

const LOG_PREFIX = "[XP-CALCULATION-SERVICE]"

/**
 * Calculate XP for a specific wallet address over a time period
 *
 * @param walletAddress - Wallet address to calculate XP for (will be normalized to lowercase)
 * @param weekStart - Start of the calculation period
 * @param weekEnd - End of the calculation period
 * @returns XPPreviewResult with all calculated values, or null if no swaps found
 *
 * Algorithm:
 * 1. Fetch all successful swaps for the wallet in the time range
 * 2. Calculate eligible volume and fees (with farming/wash-trading filters)
 * 3. Determine league based on total eligible volume
 * 4. Apply band decay per pair to calculate XP
 * 5. Calculate unique pair bonus (if user_id exists)
 * 6. Return complete breakdown
 *
 * Edge cases handled:
 * - Wallet with no swaps: returns result with 0 XP
 * - Wallet without user_id: calculates XP but no unique pair bonus
 * - Invalid wallet address: returns null
 */
export async function calculateXPForWallet(
  walletAddress: string,
  weekStart: Date,
  weekEnd: Date
): Promise<XPPreviewResult | null> {
  const startTime = Date.now()

  // Normalize wallet address
  const normalizedWallet = walletAddress.toLowerCase()

  KatanaLogger.info(LOG_PREFIX, "Starting XP calculation for wallet", {
    walletAddress: normalizedWallet,
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString()
  })

  // ============================================================================
  // STEP 1: Fetch swaps for the wallet in the time range
  // ============================================================================

  const swaps = await SushiswapActivity.findAll({
    where: {
      wallet_address: normalizedWallet,
      swap_type: {
        [Op.in]: ['CLASSIC', 'LIMIT_ORDER']
      },
      status: 'success',
      timestamp: {
        [Op.gte]: weekStart,
        [Op.lt]: weekEnd
      }
    }
  })

  KatanaLogger.info(LOG_PREFIX, "Swaps fetched", {
    walletAddress: normalizedWallet,
    totalSwaps: swaps.length,
    fetchTimeMs: Date.now() - startTime
  })

  // Calculate swap type breakdown
  const classicSwaps = swaps.filter(s => s.swap_type === 'CLASSIC')
  const limitOrderSwaps = swaps.filter(s => s.swap_type === 'LIMIT_ORDER')

  const swapTypeBreakdown = {
    classic: classicSwaps.length,
    limitOrder: limitOrderSwaps.length,
    total: swaps.length,
    classicVolume: classicSwaps.reduce((sum, s) => sum + Number(s.usd_volume), 0),
    limitOrderVolume: limitOrderSwaps.reduce((sum, s) => sum + Number(s.usd_volume), 0)
  }

  // ============================================================================
  // EDGE CASE: No swaps found
  // ============================================================================

  if (swaps.length === 0) {
    KatanaLogger.info(LOG_PREFIX, "No swaps found for wallet", {
      walletAddress: normalizedWallet
    })

    // Try to find user_id if exists
    const user = await User.findOne({ where: { wallet_address: normalizedWallet } })

    return {
      walletAddress: normalizedWallet,
      userId: user?.id || null,
      weekStart,
      weekEnd,
      league: 'bronze',
      swap_xp_raw: 0,
      swap_xp_decayed: 0,
      pair_bonus_xp: 0,
      total_xp: 0,
      eligible_volume: 0,
      total_fees: 0,
      unique_pairs_count: 0,
      new_pairs_count: 0,
      total_swaps: 0,
      perPairResults: [],
      newPairs: [],
      swapTypeBreakdown: {
        classic: 0,
        limitOrder: 0,
        total: 0,
        classicVolume: 0,
        limitOrderVolume: 0
      }
    }
  }

  // ============================================================================
  // STEP 2: Calculate eligible volume and fees
  // ============================================================================

  const { perPairData, totalEligibleVolume, totalFees } = getEligibleVolumeAndFees(swaps)

  KatanaLogger.info(LOG_PREFIX, "Eligible volume calculated", {
    walletAddress: normalizedWallet,
    totalEligibleVolume,
    totalFees,
    uniquePairs: perPairData.length
  })

  // ============================================================================
  // STEP 3: Determine league based on total eligible volume
  // ============================================================================

  const league = determineLeague(totalEligibleVolume)

  KatanaLogger.info(LOG_PREFIX, "League determined", {
    walletAddress: normalizedWallet,
    league,
    totalEligibleVolume
  })

  // ============================================================================
  // STEP 4: Apply band decay per pair
  // ============================================================================

  const { perPairResults, totalXP } = apply_band_decay_by_pair(perPairData, league)

  KatanaLogger.info(LOG_PREFIX, "Band decay applied", {
    walletAddress: normalizedWallet,
    totalXP,
    pairsProcessed: perPairResults.length
  })

  // ============================================================================
  // STEP 5: Calculate unique pair bonus (if user exists)
  // ============================================================================

  let upbResult: UniquePairBonusResult = {
    totalHistoricalPairs: 0,
    countOfNewPairs: 0,
    cappedCount: 0,
    xp_pair_bonus: 0,
    newPairs: []
  }

  // Get user_id from the first swap (all swaps have same wallet)
  const userId = swaps[0].user_id

  if (userId) {
    upbResult = await calculateUniquePairBonus(userId, perPairData, weekStart)
    KatanaLogger.info(LOG_PREFIX, "Unique pair bonus calculated", {
      walletAddress: normalizedWallet,
      userId,
      pairBonusXP: upbResult.xp_pair_bonus,
      newPairsCount: upbResult.countOfNewPairs
    })
  } else {
    KatanaLogger.info(LOG_PREFIX, "No user_id found, skipping unique pair bonus", {
      walletAddress: normalizedWallet
    })
  }

  // ============================================================================
  // STEP 6: Calculate final totals
  // ============================================================================

  const swap_xp_raw = perPairResults.reduce((sum, r) => sum + r.xp_swap_raw, 0)
  const swap_xp_decayed = totalXP
  const pair_bonus_xp = upbResult.xp_pair_bonus
  const total_xp = swap_xp_decayed + pair_bonus_xp

  // Convert perPairResults to XPPairResult format
  const perPairResultsFormatted: XPPairResult[] = perPairResults.map(r => ({
    pair: r.pair,
    eligibleVolume: r.eligibleVolume,
    totalFees: r.totalFees,
    xp_raw: r.xp_swap_raw,
    xp_decayed: r.xp_swap_decayed,
    decayFraction: r.decayFraction
  }))

  const result: XPPreviewResult = {
    walletAddress: normalizedWallet,
    userId: userId || null,
    weekStart,
    weekEnd,
    league: league.toLowerCase() as 'bronze' | 'silver' | 'gold' | 'diamond',
    swap_xp_raw,
    swap_xp_decayed,
    pair_bonus_xp,
    total_xp,
    eligible_volume: totalEligibleVolume,
    total_fees: totalFees,
    unique_pairs_count: perPairData.length,
    new_pairs_count: upbResult.countOfNewPairs,
    total_swaps: swaps.length,
    perPairResults: perPairResultsFormatted,
    newPairs: upbResult.newPairs,
    swapTypeBreakdown
  }

  KatanaLogger.info(LOG_PREFIX, "XP calculation complete", {
    walletAddress: normalizedWallet,
    total_xp,
    league,
    executionTimeMs: Date.now() - startTime
  })

  return result
}
