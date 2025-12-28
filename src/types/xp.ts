/**
 * XP Calculation Result Types
 *
 * These types define the structure of XP calculation results
 * used by both the weekly settlement job and the real-time preview endpoint.
 */

import { PairXPResult } from '../cron-jobs/xp-distribution/services/bandDecay'

/**
 * Per-pair result with calculation breakdown
 * Extends PairXPResult to include fees in metadata
 */
export interface XPPairResult {
  pair: string
  eligibleVolume: number
  totalFees: number
  xp_raw: number
  xp_decayed: number
  decayFraction: number
}

/**
 * Swap type breakdown for activity tracking
 */
export interface SwapTypeBreakdown {
  classic: number
  limitOrder: number
  total: number
  classicVolume?: number
  limitOrderVolume?: number
}

/**
 * Complete XP calculation result for a wallet
 * This is the return type for calculateXPForWallet()
 */
export interface XPPreviewResult {
  // Wallet info
  walletAddress: string
  userId: number | null

  // Time range
  weekStart: Date
  weekEnd: Date

  // League and XP totals
  league: 'bronze' | 'silver' | 'gold' | 'diamond'
  swap_xp_raw: number
  swap_xp_decayed: number
  pair_bonus_xp: number
  total_xp: number

  // Volume and fees
  eligible_volume: number
  total_fees: number

  // Pair statistics
  unique_pairs_count: number
  new_pairs_count: number
  total_swaps: number

  // Detailed breakdowns
  perPairResults: XPPairResult[]
  newPairs: string[]
  swapTypeBreakdown: SwapTypeBreakdown
}
