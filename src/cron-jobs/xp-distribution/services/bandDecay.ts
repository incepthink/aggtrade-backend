/**
 * Band Decay Service for XP Calculations
 *
 * This module handles the application of league-based band decay to XP calculations.
 * It determines user leagues based on total eligible volume and applies volume band
 * multipliers to each trading pair's XP.
 */

import {
  League,
  BAND_DECAY_CONFIG,
  LEAGUE_THRESHOLDS,
  K_FEE,
  XP_RATE_PER_USD
} from '../config/bandDecay';
import { PairEligibleVolume } from './eligibleVolume';
import { KatanaLogger } from '../../../utils/logger';

const LOG_PREFIX = '[XP-BAND-DECAY]';

/**
 * Result interface for per-pair XP calculations
 * Contains detailed breakdown of XP calculation for each trading pair
 */
export interface PairXPResult {
  pair: string;              // Normalized pair key (e.g., "0xaaa-0xbbb")
  eligibleVolume: number;    // Eligible volume for this pair
  totalFees: number;         // Total fees paid on this pair
  xp_vol: number;            // XP from volume (0.5 * EV)
  xp_fee_ceiling: number;    // XP ceiling from fees (200 * fees)
  xp_swap_raw: number;       // Raw XP before decay = min(xp_vol, xp_fee_ceiling)
  xp_swap_decayed: number;   // Final XP after band decay
  decayFraction: number;     // Decay multiplier (weighted_EV / actual_EV)
}

/**
 * Determines the user's league based on total eligible volume
 *
 * League thresholds:
 * - Diamond: >= $125,000
 * - Gold: >= $25,000
 * - Silver: >= $5,000
 * - Bronze: < $5,000
 *
 * @param totalEligibleVolume - Total eligible volume across all pairs
 * @returns The user's league
 */
export const determineLeague = (totalEligibleVolume: number): League => {
  if (totalEligibleVolume >= LEAGUE_THRESHOLDS.DIAMOND) {
    KatanaLogger.info(LOG_PREFIX, 'League determined: Diamond', {
      totalEligibleVolume,
      threshold: LEAGUE_THRESHOLDS.DIAMOND
    });
    return 'Diamond';
  }

  if (totalEligibleVolume >= LEAGUE_THRESHOLDS.GOLD) {
    KatanaLogger.info(LOG_PREFIX, 'League determined: Gold', {
      totalEligibleVolume,
      threshold: LEAGUE_THRESHOLDS.GOLD
    });
    return 'Gold';
  }

  if (totalEligibleVolume >= LEAGUE_THRESHOLDS.SILVER) {
    KatanaLogger.info(LOG_PREFIX, 'League determined: Silver', {
      totalEligibleVolume,
      threshold: LEAGUE_THRESHOLDS.SILVER
    });
    return 'Silver';
  }

  KatanaLogger.info(LOG_PREFIX, 'League determined: Bronze', {
    totalEligibleVolume
  });
  return 'Bronze';
};

/**
 * Calculates the band decay fraction for a given eligible volume and league
 *
 * The decay fraction is calculated by applying league-specific multipliers
 * to volume bands, then dividing weighted EV by actual EV.
 *
 * Example (Silver league, $20k EV):
 * - Band 1: $0-5k @ 100% = 5,000 weighted
 * - Band 2: $5k-20k (15k) @ 70% = 10,500 weighted
 * - Weighted EV = 15,500
 * - Decay fraction = 15,500 / 20,000 = 0.775
 *
 * @param eligibleVolume - Eligible volume for the pair
 * @param league - User's league
 * @returns Decay fraction (0.0 to 1.0)
 */
const calculateBandDecayFraction = (eligibleVolume: number, league: League): number => {
  // Edge case: zero volume = no decay needed
  if (eligibleVolume === 0) {
    return 1.0;
  }

  const bands = BAND_DECAY_CONFIG[league];
  let weightedEV = 0;
  let remainingEV = eligibleVolume;

  KatanaLogger.info(LOG_PREFIX, 'Calculating band decay fraction', {
    eligibleVolume,
    league,
    totalBands: bands.length
  });

  // Process each band in order
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];

    // Calculate how much EV falls within this band
    const bandSize = band.maxEV ? band.maxEV - band.minEV : Infinity;
    const evInBand = Math.min(remainingEV, bandSize);

    // Apply multiplier to EV in this band
    const weightedEvInBand = evInBand * band.multiplier;
    weightedEV += weightedEvInBand;

    KatanaLogger.info(LOG_PREFIX, `Band ${i + 1} calculation`, {
      bandRange: band.maxEV ? `$${band.minEV}-$${band.maxEV}` : `$${band.minEV}+`,
      multiplier: band.multiplier,
      evInBand,
      weightedEvInBand,
      cumulativeWeightedEV: weightedEV
    });

    // Reduce remaining EV
    remainingEV -= evInBand;

    // Stop if all EV has been processed
    if (remainingEV <= 0) {
      break;
    }
  }

  const decayFraction = weightedEV / eligibleVolume;

  KatanaLogger.info(LOG_PREFIX, 'Band decay fraction calculated', {
    eligibleVolume,
    weightedEV,
    decayFraction,
    decayPercentage: (decayFraction * 100).toFixed(2) + '%'
  });

  return decayFraction;
};

/**
 * Applies band decay to XP calculations for each trading pair
 *
 * For each pair:
 * 1. Calculate raw XP: xp_swap_raw = min(0.5 * EV, 200 * fees)
 * 2. Calculate band decay fraction based on pair's EV and user's league
 * 3. Apply decay: xp_swap_decayed = xp_swap_raw * decay_fraction
 * 4. Sum all decayed XP across pairs
 *
 * @param perPairData - Array of per-pair eligible volumes and fees
 * @param league - User's league
 * @returns Object containing per-pair XP results and total XP
 */
export const apply_band_decay_by_pair = (
  perPairData: PairEligibleVolume[],
  league: League
): {
  perPairResults: PairXPResult[];
  totalXP: number;
} => {
  KatanaLogger.info(LOG_PREFIX, '=== STARTING BAND DECAY APPLICATION ===', {
    totalPairs: perPairData.length,
    league
  });

  const perPairResults: PairXPResult[] = [];
  let totalXP = 0;

  // Process each pair
  for (const pairData of perPairData) {
    KatanaLogger.info(LOG_PREFIX, 'Processing pair', {
      pair: `${pairData.pair.split('-')[0].slice(0, 8)}/${pairData.pair.split('-')[1].slice(0, 8)}`,
      eligibleVolume: pairData.eligibleVolume,
      totalFees: pairData.totalFees
    });

    // STEP 1: Calculate XP from volume
    const xp_vol = XP_RATE_PER_USD * pairData.eligibleVolume;

    // STEP 2: Calculate XP ceiling from fees
    const xp_fee_ceiling = K_FEE * pairData.totalFees;

    // STEP 3: Calculate raw XP (before decay)
    const xp_swap_raw = Math.min(xp_vol, xp_fee_ceiling);

    KatanaLogger.info(LOG_PREFIX, 'Raw XP calculation', {
      xp_vol,
      xp_fee_ceiling,
      xp_swap_raw,
      limitedBy: xp_vol <= xp_fee_ceiling ? 'volume' : 'fees'
    });

    // STEP 4: Calculate band decay fraction
    const decayFraction = calculateBandDecayFraction(pairData.eligibleVolume, league);

    // STEP 5: Apply decay to get final XP
    const xp_swap_decayed = xp_swap_raw * decayFraction;

    KatanaLogger.info(LOG_PREFIX, 'Pair XP calculation complete', {
      pair: `${pairData.pair.split('-')[0].slice(0, 8)}/${pairData.pair.split('-')[1].slice(0, 8)}`,
      xp_swap_raw,
      decayFraction,
      xp_swap_decayed,
      xpReduction: xp_swap_raw - xp_swap_decayed,
      reductionPercentage: ((1 - decayFraction) * 100).toFixed(2) + '%'
    });

    // Store result
    const result: PairXPResult = {
      pair: pairData.pair,
      eligibleVolume: pairData.eligibleVolume,
      totalFees: pairData.totalFees,
      xp_vol,
      xp_fee_ceiling,
      xp_swap_raw,
      xp_swap_decayed,
      decayFraction
    };

    perPairResults.push(result);
    totalXP += xp_swap_decayed;
  }

  KatanaLogger.info(LOG_PREFIX, '=== BAND DECAY APPLICATION COMPLETE ===', {
    totalPairs: perPairResults.length,
    totalXP,
    league,
    perPairBreakdown: perPairResults.map(r => ({
      pair: `${r.pair.split('-')[0].slice(0, 8)}/${r.pair.split('-')[1].slice(0, 8)}`,
      eligibleVolume: r.eligibleVolume,
      xp_swap_raw: r.xp_swap_raw,
      xp_swap_decayed: r.xp_swap_decayed,
      decayFraction: r.decayFraction
    }))
  });

  return {
    perPairResults,
    totalXP
  };
};
