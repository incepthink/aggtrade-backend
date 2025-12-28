import SushiswapActivity from "../../../models/SushiswapActivity";
import { KatanaLogger } from "../../../utils/logger";

const LOG_PREFIX = "[XP-ELIGIBLE-VOL]";

/**
 * Interface for tracking net volume per wallet/pair group
 * Used in directional netting to aggregate buy/sell activity
 */
interface NetVolume {
  wallet: string;
  pair: string;
  netUsd: number;
  totalFees: number;
  swapIds: number[];
}

/**
 * Interface for per-pair eligible volume and fees
 * Used to track aggregated eligible volume by trading pair
 */
export interface PairEligibleVolume {
  pair: string;           // normalized pair key (e.g., "0xaaa-0xbbb")
  eligibleVolume: number; // sum of absolute net volumes for this pair
  totalFees: number;      // sum of fees for this pair
}

/**
 * HELPER FUNCTION: normalizePair
 *
 * What it does:
 * - Takes two token addresses and creates a normalized pair key
 * - Ensures that USDC→WETH and WETH→USDC both map to the same pair
 *
 * How it works:
 * - Sorts the two token addresses alphabetically
 * - Joins them with a hyphen to create a consistent key
 * - Example: normalizePair("0xBBB", "0xAAA") → "0xaaa-0xbbb"
 *
 * Why: This is critical for directional netting - we need to match
 * reverse swaps (A→B and B→A) as the same trading pair
 */
export const normalizePair = (tokenA: string, tokenB: string): string => {
  const sorted = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
  return `${sorted[0]}-${sorted[1]}`;
};

/**
 * HELPER FUNCTION: getTimeWindow
 *
 * What it does:
 * - Converts a timestamp into a fixed time window bucket
 * - Used for round-trip detection (5-minute windows)
 *
 * How it works:
 * - Converts windowMinutes to milliseconds
 * - Floors the timestamp to the nearest window boundary
 * - Example: If windowMinutes=5, timestamps 10:02, 10:03, 10:04 all → 10:00
 *
 * Why: Enables time-based grouping for 5-min round-trip detection windows
 * Note: Directional netting no longer uses time windows - it groups across entire period
 */
const getTimeWindow = (timestamp: Date, windowMinutes: number): number => {
  const windowMs = windowMinutes * 60 * 1000;
  return Math.floor(timestamp.getTime() / windowMs) * windowMs;
};

/**
 * STEP 2: detectRoundTrips
 *
 * What it does:
 * - Identifies "round-trip" trades where a user swaps A→B then B→A within 5 minutes
 * - These are likely farming attempts to generate fake volume
 * - Returns the IDs of swaps that should be excluded (smaller leg only)
 *
 * How it works:
 * 1. Sort all swaps by timestamp (chronological order)
 * 2. For each swap, look ahead at subsequent swaps within 5-minute window
 * 3. Check if any later swap reverses the token direction (from/to flipped)
 * 4. When a round-trip is found:
 *    - Compare USD volumes of both swaps
 *    - Mark the SMALLER swap for exclusion
 *    - If volumes are equal, exclude the later swap
 * 5. Return a Set of swap IDs to exclude
 *
 * Why: Excludes farming behavior while preserving legitimate net trading.
 * If someone buys $100 then sells $80, we exclude the $80 but keep $20 as real volume.
 */
const detectRoundTrips = (swaps: SushiswapActivity[]): Set<number> => {
  KatanaLogger.info(LOG_PREFIX, "STEP 2: Starting round-trip detection", {
    totalSwaps: swaps.length
  });

  // Set to track which swap IDs should be excluded from eligible volume
  const excludedIds = new Set<number>();

  // Sort swaps chronologically for efficient window-based detection
  // This allows us to use a forward-looking sliding window
  const sortedSwaps = [...swaps].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
  );

  KatanaLogger.info(LOG_PREFIX, "Swaps sorted chronologically", {
    firstSwapTime: sortedSwaps[0]?.timestamp.toISOString(),
    lastSwapTime: sortedSwaps[sortedSwaps.length - 1]?.timestamp.toISOString()
  });

  // Define 5-minute window in milliseconds for round-trip detection
  const fiveMinutesMs = 5 * 60 * 1000;
  let roundTripsFound = 0;

  // Iterate through each swap to find potential round-trips
  for (let i = 0; i < sortedSwaps.length; i++) {
    const swap1 = sortedSwaps[i];

    // Skip if this swap is already marked for exclusion
    if (excludedIds.has(swap1.id)) continue;

    const swap1Time = swap1.timestamp.getTime();

    // Look ahead at subsequent swaps within 5-minute window
    for (let j = i + 1; j < sortedSwaps.length; j++) {
      const swap2 = sortedSwaps[j];
      const swap2Time = swap2.timestamp.getTime();

      // Break if we've exceeded the 5-minute window
      // (optimization: no need to check further swaps)
      if (swap2Time - swap1Time > fiveMinutesMs) break;

      // Skip if swap2 is already marked for exclusion
      if (excludedIds.has(swap2.id)) continue;

      // Check if swap2 reverses swap1 (round-trip detected)
      // Round-trip means: swap1 goes A→B, swap2 goes B→A
      const isRoundTrip =
        swap1.token_from_address.toLowerCase() === swap2.token_to_address.toLowerCase() &&
        swap1.token_to_address.toLowerCase() === swap2.token_from_address.toLowerCase();

      if (isRoundTrip) {
        roundTripsFound++;
        const timeDiffSeconds = (swap2Time - swap1Time) / 1000;

        // Found a round-trip! Now exclude the smaller leg
        // This preserves net trading while removing farming volume
        let excludedId: number;
        let excludedVolume: number;
        let keptVolume: number;

        if (Number(swap1.usd_volume) < Number(swap2.usd_volume)) {
          // Swap1 is smaller → exclude it
          excludedIds.add(swap1.id);
          excludedId = swap1.id;
          excludedVolume = Number(swap1.usd_volume);
          keptVolume = Number(swap2.usd_volume);
        } else if (Number(swap2.usd_volume) < Number(swap1.usd_volume)) {
          // Swap2 is smaller → exclude it
          excludedIds.add(swap2.id);
          excludedId = swap2.id;
          excludedVolume = Number(swap2.usd_volume);
          keptVolume = Number(swap1.usd_volume);
        } else {
          // Volumes are equal → exclude the later swap (swap2)
          excludedIds.add(swap2.id);
          excludedId = swap2.id;
          excludedVolume = Number(swap2.usd_volume);
          keptVolume = Number(swap1.usd_volume);
        }

        KatanaLogger.info(LOG_PREFIX, `Round-trip #${roundTripsFound} detected`, {
          wallet: swap1.wallet_address,
          swap1Id: swap1.id,
          swap1Volume: Number(swap1.usd_volume),
          swap1Direction: `${swap1.token_from_address.slice(0, 8)}→${swap1.token_to_address.slice(0, 8)}`,
          swap1Time: swap1.timestamp.toISOString(),
          swap2Id: swap2.id,
          swap2Volume: Number(swap2.usd_volume),
          swap2Direction: `${swap2.token_from_address.slice(0, 8)}→${swap2.token_to_address.slice(0, 8)}`,
          swap2Time: swap2.timestamp.toISOString(),
          timeDiffSeconds,
          excludedSwapId: excludedId,
          excludedVolume,
          keptVolume,
          netPreserved: Math.abs(keptVolume - excludedVolume)
        });

        // Continue to check for additional round-trips
        // (one swap could potentially be part of multiple round-trips)
      }
    }
  }

  KatanaLogger.info(LOG_PREFIX, "STEP 2: Round-trip detection complete", {
    roundTripsFound,
    swapsExcluded: excludedIds.size,
    excludedSwapIds: Array.from(excludedIds)
  });

  return excludedIds;
};

/**
 * STEP 3: calculateDirectionalNetting
 *
 * What it does:
 * - Groups swaps by (wallet, normalized_pair) across the entire time period
 * - For each group, calculates net buy volume minus sell volume
 * - This identifies wash trading where users buy and sell the same pair
 *
 * How it works:
 * 1. Create groups using key: "{wallet}_{pair}"
 * 2. For each swap in a group:
 *    - If token is token_to_address → it's a BUY (add to buys)
 *    - If token is token_from_address → it's a SELL (add to sells)
 * 3. Calculate net = buys - sells for each token in the pair
 * 4. Return array of NetVolume objects with the net USD value
 *
 * Why: A user who buys $100 and sells $80 of the same pair (at any time)
 * is likely wash trading. We only count the net difference ($20) as real volume.
 */
const calculateDirectionalNetting = (swaps: SushiswapActivity[]): NetVolume[] => {
  KatanaLogger.info(LOG_PREFIX, "STEP 4: Starting directional netting", {
    totalSwaps: swaps.length
  });

  // Map to store aggregated data for each wallet/pair group
  // Key format: "{wallet_address}_{normalized_pair}"
  const groups = new Map<string, {
    wallet: string;
    pair: string;
    buyVolumeUsd: number;
    sellVolumeUsd: number;
    totalFees: number;
    swapIds: number[];
  }>();

  // Process each swap and assign it to the appropriate group
  for (const swap of swaps) {
    // Create normalized pair key (alphabetically sorted tokens)
    const pair = normalizePair(swap.token_from_address, swap.token_to_address);

    // Create unique group key for this wallet/pair combination
    const groupKey = `${swap.wallet_address}_${pair}`;

    const isNewGroup = !groups.has(groupKey);

    // Initialize group if it doesn't exist
    if (isNewGroup) {
      groups.set(groupKey, {
        wallet: swap.wallet_address,
        pair,
        buyVolumeUsd: 0,
        sellVolumeUsd: 0,
        totalFees: 0,
        swapIds: []
      });

      KatanaLogger.info(LOG_PREFIX, "New netting group created", {
        wallet: swap.wallet_address.slice(0, 10),
        pair: `${pair.split('-')[0].slice(0, 8)}/${pair.split('-')[1].slice(0, 8)}`,
        swapId: swap.id
      });
    }

    const group = groups.get(groupKey)!;

    // Determine if this swap is a buy or sell for each token in the pair
    // We need to check both tokens since pair is normalized
    const tokens = pair.split('-');
    const tokenA = tokens[0];
    const tokenB = tokens[1];

    let direction: 'BUY' | 'SELL' | 'UNKNOWN' = 'UNKNOWN';

    // Check direction relative to tokenA
    if (swap.token_to_address.toLowerCase() === tokenA) {
      // User received tokenA → they BOUGHT tokenA (sold tokenB)
      group.buyVolumeUsd += Number(swap.usd_volume);
      direction = 'BUY';
    } else if (swap.token_from_address.toLowerCase() === tokenA) {
      // User sent tokenA → they SOLD tokenA (bought tokenB)
      group.sellVolumeUsd += Number(swap.usd_volume);
      direction = 'SELL';
    }

    // Add fees to the group total (handle null fees as 0)
    const swapFees = swap.fees_usd ? Number(swap.fees_usd) : 0;
    group.totalFees += swapFees;

    KatanaLogger.info(LOG_PREFIX, "Swap classified in netting group", {
      swapId: swap.id,
      wallet: swap.wallet_address.slice(0, 10),
      pair: `${pair.split('-')[0].slice(0, 8)}/${pair.split('-')[1].slice(0, 8)}`,
      direction,
      volume: Number(swap.usd_volume),
      fees: swapFees,
      groupBuyTotal: group.buyVolumeUsd,
      groupSellTotal: group.sellVolumeUsd,
      groupFeesTotal: group.totalFees,
      swapCount: group.swapIds.length + 1
    });

    // Track which swaps contributed to this group
    group.swapIds.push(swap.id);
  }

  KatanaLogger.info(LOG_PREFIX, "Grouping complete, calculating net volumes", {
    totalGroups: groups.size
  });

  // Convert groups to NetVolume array with calculated net values
  const netVolumes: NetVolume[] = [];

  for (const group of groups.values()) {
    // Calculate net = buys - sells
    // Positive net = more buying (accumulation)
    // Negative net = more selling (distribution)
    const netUsd = group.buyVolumeUsd - group.sellVolumeUsd;

    KatanaLogger.info(LOG_PREFIX, "Group net volume calculated", {
      wallet: group.wallet.slice(0, 10),
      pair: `${group.pair.split('-')[0].slice(0, 8)}/${group.pair.split('-')[1].slice(0, 8)}`,
      buyVolume: group.buyVolumeUsd,
      sellVolume: group.sellVolumeUsd,
      netVolume: netUsd,
      absoluteNet: Math.abs(netUsd),
      totalFees: group.totalFees,
      swapCount: group.swapIds.length,
      swapIds: group.swapIds
    });

    netVolumes.push({
      wallet: group.wallet,
      pair: group.pair,
      netUsd,
      totalFees: group.totalFees,
      swapIds: group.swapIds
    });
  }

  KatanaLogger.info(LOG_PREFIX, "STEP 4: Directional netting complete", {
    totalGroups: netVolumes.length,
    totalAbsoluteNet: netVolumes.reduce((sum, nv) => sum + Math.abs(nv.netUsd), 0)
  });

  return netVolumes;
};

/**
 * MAIN FUNCTION: getEligibleVolumeAndFees
 *
 * What it does:
 * - Takes an array of swaps and returns the "eligible" USD volume and total fees
 * - Eligible volume excludes farming activity and wash trading
 * - Applies four filters: minimum size, minimum impact, round-trip detection, and directional netting
 *
 * How it works:
 * STEP 1: Filter out dust trades (< $8 USD) and low-impact swaps (< 1bp) // verified
 * STEP 2: Detect and exclude round-trip farming pairs (5-minute reversals)
 * STEP 3: Remove excluded swaps from the array
 * STEP 4: Apply directional netting (per wallet/pair, net buys - sells across entire period)
 * STEP 5: Sum the absolute values of all net volumes and total fees // verified
 *
 * Why: This algorithm identifies legitimate trading volume by filtering out:
 * - Dust trades that don't represent meaningful activity
 * - Low-impact trades that may indicate wash trading or self-matching
 * - Round-trip farming (quick reversals to generate fake volume)
 * - Wash trading (offsetting buys and sells in the same pair, regardless of timing)
 */
export const getEligibleVolumeAndFees = (swaps: SushiswapActivity[]): {
  perPairData: PairEligibleVolume[];
  totalEligibleVolume: number;
  totalFees: number;
} => {
  const startTime = Date.now();

  // Calculate initial statistics
  const totalRawVolume = swaps.reduce((sum, swap) => sum + Number(swap.usd_volume), 0);
  const uniqueWallets = new Set(swaps.map(s => s.wallet_address)).size;
  const uniquePairs = new Set(
    swaps.map(s => normalizePair(s.token_from_address, s.token_to_address))
  ).size;

  KatanaLogger.info(LOG_PREFIX, "=== STARTING ELIGIBLE VOLUME CALCULATION ===", {
    totalSwaps: swaps.length,
    totalRawVolume,
    uniqueWallets,
    uniquePairs,
    timeRange: swaps.length > 0 ? {
      earliest: new Date(Math.min(...swaps.map(s => s.timestamp.getTime()))).toISOString(),
      latest: new Date(Math.max(...swaps.map(s => s.timestamp.getTime()))).toISOString()
    } : null
  });

  // EDGE CASE: Empty array returns 0
  if (swaps.length === 0) {
    KatanaLogger.info(LOG_PREFIX, "No swaps provided, returning 0");
    return { perPairData: [], totalEligibleVolume: 0, totalFees: 0 };
  }

  // ============================================================================
  // STEP 1: MINIMUM FILL SIZE AND MINIMUM IMPACT FILTERS
  // ============================================================================
  // What: Remove small "dust" trades (< $10 USD) and low-impact swaps (< 1bp)
  // Why: - Trades under $10 are too small to be meaningful and may be spam
  //      - Trades with < 1bp impact may indicate wash trading or self-matching
  // How: Filter on both usd_volume and price_impact fields

  const minFillSize = 8; // $10 USD minimum
  // const minImpact = 0.0001; // 1 basis point (1bp = 0.01% = 0.0001) - COMMENTED OUT TEMPORARILY

  const filteredBySize = swaps.filter(swap => Number(swap.usd_volume) >= minFillSize);
  const filteredOutBySize = swaps.length - filteredBySize.length;
  const volumeFilteredOutBySize = totalRawVolume - filteredBySize.reduce((sum, s) => sum + Number(s.usd_volume), 0);

  KatanaLogger.info(LOG_PREFIX, "STEP 1a: Minimum fill size filter complete", {
    minFillSize,
    swapsBefore: swaps.length,
    swapsAfter: filteredBySize.length,
    swapsRemoved: filteredOutBySize,
    volumeRemoved: volumeFilteredOutBySize,
    volumeRemaining: filteredBySize.reduce((sum, s) => sum + Number(s.usd_volume), 0)
  });

  // EDGE CASE: All swaps filtered out by size
  if (filteredBySize.length === 0) {
    KatanaLogger.info(LOG_PREFIX, "All swaps filtered out by minimum size, returning 0");
    return { perPairData: [], totalEligibleVolume: 0, totalFees: 0 };
  }

  // COMMENTED OUT TEMPORARILY - minImpact filter
  // Now apply minimum impact filter
  // const filteredBySizeAndImpact = filteredBySize.filter(swap => Number(swap.price_impact) >= minImpact);
  // const filteredOutByImpact = filteredBySize.length - filteredBySizeAndImpact.length;
  // const volumeFilteredOutByImpact = filteredBySize.reduce((sum, s) => sum + Number(s.usd_volume), 0) -
  //                                    filteredBySizeAndImpact.reduce((sum, s) => sum + Number(s.usd_volume), 0);

  // KatanaLogger.info(LOG_PREFIX, "STEP 1b: Minimum impact filter complete", {
  //   minImpactBp: '1bp (0.01%)',
  //   minImpactDecimal: minImpact,
  //   swapsBefore: filteredBySize.length,
  //   swapsAfter: filteredBySizeAndImpact.length,
  //   swapsRemoved: filteredOutByImpact,
  //   volumeRemoved: volumeFilteredOutByImpact,
  //   volumeRemaining: filteredBySizeAndImpact.reduce((sum, s) => sum + Number(s.usd_volume), 0)
  // });

  // // EDGE CASE: All swaps filtered out by impact
  // if (filteredBySizeAndImpact.length === 0) {
  //   KatanaLogger.info(LOG_PREFIX, "All swaps filtered out by minimum impact, returning 0");
  //   return { perPairData: [], totalEligibleVolume: 0, totalFees: 0 };
  // }

  // Bypass impact filter - use size-filtered swaps directly
  const filteredBySizeAndImpact = filteredBySize;

  // ============================================================================
  // STEP 2: ROUND-TRIP DETECTION (5-minute windows)
  // ============================================================================
  // What: Find swaps that reverse within 5 minutes (A→B then B→A)
  // Why: This is farming behavior to generate fake volume
  // How: detectRoundTrips() sorts chronologically and finds reverse pairs,
  //      excludes the smaller leg of each round-trip

  const excludedIds = detectRoundTrips(filteredBySizeAndImpact);

  // ============================================================================
  // STEP 3: REMOVE EXCLUDED SWAPS
  // ============================================================================
  // What: Filter out swaps marked as round-trip farming
  // Why: These swaps don't represent legitimate trading intent
  // How: Exclude any swap whose ID is in the excludedIds Set

  const afterRoundTripRemoval = filteredBySizeAndImpact.filter(
    swap => !excludedIds.has(swap.id)
  );

  const roundTripVolumeRemoved = filteredBySizeAndImpact
    .filter(swap => excludedIds.has(swap.id))
    .reduce((sum, s) => sum + Number(s.usd_volume), 0);

  KatanaLogger.info(LOG_PREFIX, "STEP 3: Round-trip removal complete", {
    swapsBefore: filteredBySizeAndImpact.length,
    swapsAfter: afterRoundTripRemoval.length,
    swapsRemoved: filteredBySizeAndImpact.length - afterRoundTripRemoval.length,
    volumeRemoved: roundTripVolumeRemoved,
    volumeRemaining: afterRoundTripRemoval.reduce((sum, s) => sum + Number(s.usd_volume), 0)
  });

  // EDGE CASE: All swaps were round-trips
  if (afterRoundTripRemoval.length === 0) {
    KatanaLogger.info(LOG_PREFIX, "All swaps were round-trips, returning 0");
    return { perPairData: [], totalEligibleVolume: 0, totalFees: 0 };
  }

  // ============================================================================
  // STEP 4: DIRECTIONAL NETTING (per wallet/pair across entire period)
  // ============================================================================
  // What: Group swaps by wallet/pair and calculate net buys - sells
  // Why: Identifies wash trading where users offset their own trades
  // How: calculateDirectionalNetting() groups swaps and returns net volumes
  //      Example: $100 buy + $80 sell = $20 net (regardless of timing)

  const netVolumes = calculateDirectionalNetting(afterRoundTripRemoval);

  // ============================================================================
  // STEP 5: AGGREGATE ELIGIBLE VOLUME AND FEES BY PAIR
  // ============================================================================
  // What: Group net volumes by trading pair and sum absolute values
  // Why: Need per-pair breakdown for band decay calculations
  // How: Create a Map grouped by pair, then sum volumes and fees per pair
  //      Example: WETH-USDC has net +$100 and -$50 → pair EV = $150

  KatanaLogger.info(LOG_PREFIX, "STEP 5: Aggregating eligible volume and fees by pair");

  // Group net volumes by pair
  const pairMap = new Map<string, { eligibleVolume: number; totalFees: number }>();

  for (const netVol of netVolumes) {
    const existing = pairMap.get(netVol.pair) || { eligibleVolume: 0, totalFees: 0 };

    // Add absolute net volume and fees to the pair's totals
    existing.eligibleVolume += Math.abs(netVol.netUsd);
    existing.totalFees += netVol.totalFees;

    pairMap.set(netVol.pair, existing);
  }

  // Convert Map to array of PairEligibleVolume objects
  const perPairData: PairEligibleVolume[] = Array.from(pairMap.entries()).map(([pair, data]) => ({
    pair,
    eligibleVolume: data.eligibleVolume,
    totalFees: data.totalFees
  }));

  // Calculate global totals across all pairs
  const totalEligibleVolume = perPairData.reduce((sum, pairData) => sum + pairData.eligibleVolume, 0);
  const totalFees = perPairData.reduce((sum, pairData) => sum + pairData.totalFees, 0);

  const totalNettingReduction = afterRoundTripRemoval.reduce((sum, s) => sum + Number(s.usd_volume), 0) - totalEligibleVolume;

  KatanaLogger.info(LOG_PREFIX, "=== ELIGIBLE VOLUME AND FEES CALCULATION COMPLETE ===", {
    originalSwaps: swaps.length,
    originalVolume: totalRawVolume,
    totalEligibleVolume,
    totalFees,
    uniquePairs: perPairData.length,
    perPairBreakdown: perPairData.map(p => ({
      pair: `${p.pair.split('-')[0].slice(0, 8)}/${p.pair.split('-')[1].slice(0, 8)}`,
      eligibleVolume: p.eligibleVolume,
      totalFees: p.totalFees
    })),
    totalReduction: totalRawVolume - totalEligibleVolume,
    reductionPercentage: ((totalRawVolume - totalEligibleVolume) / totalRawVolume * 100).toFixed(2) + '%',
    breakdown: {
      step1a_sizeFilter: {
        swapsRemoved: filteredOutBySize,
        volumeRemoved: volumeFilteredOutBySize
      },
      // COMMENTED OUT TEMPORARILY - minImpact filter
      // step1b_impactFilter: {
      //   swapsRemoved: filteredOutByImpact,
      //   volumeRemoved: volumeFilteredOutByImpact
      // },
      step2_roundTrips: {
        swapsRemoved: filteredBySizeAndImpact.length - afterRoundTripRemoval.length,
        volumeRemoved: roundTripVolumeRemoved
      },
      step4_netting: {
        groupsCreated: netVolumes.length,
        volumeReduced: totalNettingReduction
      }
    },
    executionTimeMs: Date.now() - startTime
  });

  return { perPairData, totalEligibleVolume, totalFees };
};

