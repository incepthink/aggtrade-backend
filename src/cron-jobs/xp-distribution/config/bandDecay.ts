/**
 * Band Decay Configuration for XP Calculations
 *
 * This file defines the league system and band decay multipliers used in the
 * XP distribution system. Users are assigned to leagues based on their total
 * eligible volume, and each league has different decay rates for volume bands.
 */

/**
 * League types based on total eligible volume (EV)
 * - Bronze: < $5,000
 * - Silver: $5,000 - $24,999
 * - Gold: $25,000 - $124,999
 * - Diamond: >= $125,000
 */
export type League = 'Bronze' | 'Silver' | 'Gold' | 'Diamond';

/**
 * Defines a volume band with its multiplier
 * Each band applies a different XP multiplier based on eligible volume
 */
export interface BandMultiplier {
  minEV: number;           // Minimum eligible volume for this band (inclusive)
  maxEV: number | null;    // Maximum eligible volume for this band (exclusive), null = infinity
  multiplier: number;      // XP multiplier (0.0 to 1.0)
}

/**
 * Band decay configuration for each league
 *
 * Each league has 4 volume bands with different multipliers:
 * - Higher leagues decay more slowly (higher multipliers)
 * - Diamond league retains the most XP at high volumes
 * - Bronze league penalizes high volume more aggressively
 *
 * Example: Silver league trader with $20k EV on a pair
 * - $0-5k @ 100% = 5,000 weighted
 * - $5k-20k (15k) @ 70% = 10,500 weighted
 * - Weighted EV = 15,500 / 20,000 = 77.5% decay fraction
 */
export const BAND_DECAY_CONFIG: Record<League, BandMultiplier[]> = {
  Bronze: [
    { minEV: 0, maxEV: 5000, multiplier: 1.0 },       // 100% for first $5k
    { minEV: 5000, maxEV: 25000, multiplier: 0.6 },   // 60% for $5k-$25k
    { minEV: 25000, maxEV: 125000, multiplier: 0.3 }, // 30% for $25k-$125k
    { minEV: 125000, maxEV: null, multiplier: 0.1 }   // 10% for $125k+
  ],
  Silver: [
    { minEV: 0, maxEV: 5000, multiplier: 1.0 },       // 100% for first $5k
    { minEV: 5000, maxEV: 25000, multiplier: 0.7 },   // 70% for $5k-$25k
    { minEV: 25000, maxEV: 125000, multiplier: 0.45 }, // 45% for $25k-$125k
    { minEV: 125000, maxEV: null, multiplier: 0.15 }  // 15% for $125k+
  ],
  Gold: [
    { minEV: 0, maxEV: 5000, multiplier: 1.0 },       // 100% for first $5k
    { minEV: 5000, maxEV: 25000, multiplier: 0.8 },   // 80% for $5k-$25k
    { minEV: 25000, maxEV: 125000, multiplier: 0.6 }, // 60% for $25k-$125k
    { minEV: 125000, maxEV: null, multiplier: 0.2 }   // 20% for $125k+
  ],
  Diamond: [
    { minEV: 0, maxEV: 5000, multiplier: 1.0 },       // 100% for first $5k
    { minEV: 5000, maxEV: 25000, multiplier: 0.9 },   // 90% for $5k-$25k
    { minEV: 25000, maxEV: 125000, multiplier: 0.7 }, // 70% for $25k-$125k
    { minEV: 125000, maxEV: null, multiplier: 0.25 }  // 25% for $125k+
  ]
};

/**
 * League thresholds based on total eligible volume across all pairs
 */
export const LEAGUE_THRESHOLDS = {
  DIAMOND: 125000,  // >= $125k = Diamond
  GOLD: 25000,      // >= $25k = Gold
  SILVER: 5000      // >= $5k = Silver
  // < $5k = Bronze (default)
};

/**
 * Fee ceiling multiplier constant
 * XP from fees is capped at: k_fee * total_fees_usd
 * Example: $10 in fees → max 2,000 XP from fees (200 * 10)
 */
export const K_FEE = 200;

/**
 * XP rate per USD of eligible volume
 * XP from volume = XP_RATE_PER_USD * eligible_volume
 * Example: $2,000 EV → 1,000 XP from volume (0.5 * 2000)
 */
export const XP_RATE_PER_USD = 0.5;

/**
 * Unique Pair Bonus (UPB) configuration
 * Rewards users for trading new pairs they've never traded before
 */
export const UPB_CONFIG = {
  XP_PER_NEW_PAIR: 25,   // XP bonus for each new pair traded this week
  MAX_NEW_PAIRS: 4,      // Maximum pairs that count for bonus (cap at +100 XP/week)
  ENABLED: true          // Feature flag - enabled
};
