// src/scripts/backfillSushiswapActivity.ts

import sequelize from '../utils/db/sequelize';
import { Op } from 'sequelize';
import User from '../models/User';
import SushiswapActivity from '../models/SushiswapActivity';
import { fetchPoolsByTVL, fetchFullSwaps } from '../utils/katana/dataFetching';
import type { FullSwapData } from '../utils/katana/types';

/**
 * Backfill script for populating sushiswap_activity table with historical swap data
 * Date range: December 2-23, 2025
 * Volume-based selection:
 * - Dec 2-16: $25,000 - $50,000 USD/day
 * - Dec 17-23: $60,000 - $80,000 USD/day
 * Skips days that already have >= minimum volume for that period
 */

const CHAIN_ID = 747474; // Katana/Ronin
const START_DATE = new Date('2025-12-02T00:00:00Z');
const END_DATE = new Date('2025-12-23T23:59:59Z');

// Volume ranges by date period
interface VolumeRange {
  startDate: string;
  endDate: string;
  min: number;
  max: number;
}

const VOLUME_RANGES: VolumeRange[] = [
  { startDate: '2025-12-02', endDate: '2025-12-16', min: 25000, max: 50000 },
  { startDate: '2025-12-17', endDate: '2025-12-23', min: 60000, max: 80000 },
];

/**
 * Get volume range for a specific date
 */
function getVolumeRangeForDate(date: Date): { min: number; max: number } {
  const dateStr = date.toISOString().split('T')[0];

  for (const range of VOLUME_RANGES) {
    if (dateStr >= range.startDate && dateStr <= range.endDate) {
      return { min: range.min, max: range.max };
    }
  }

  // Default fallback
  return { min: 25000, max: 50000 };
}

// Token addresses to search for top pools
const COMMON_TOKENS = [
  '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62', // WETH
  '0x203a662b0bd271a6ed5a60edfbd04bfce608fd36', // USDC
  "0x0913da6da4b42f538b445599b46bb4622342cf52", // WBTC
  "0xecac9c5f704e954931349da37f60e39f515c11c1", // LBTC
  "0x6c16e26013f2431e8b2e1ba7067ecccad0db6c52", // JitoSOL
  "0x17bff452dae47e07cea877ff0e1aba17eb62b0ab", // SUSHI
  "0x9893989433e7a383cb313953e4c2365107dc19a7", // weETH
  "0x80eede496655fb9047dd39d9f418d5483ed600df", // frxUSD
  "0x1e5efca3d0db2c6d5c67a4491845c43253eb9e4e", // MORPHO
  "0x2dca96907fde857dd3d816880a0df407eeb2d2f2", // USDT
  "0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072", // BTCK
  "0x4772d2e014f9fc3a820c444e3313968e9a5c8121", // yUSD
  "0x7fb4d0f51544f24f385a421db6e7d4fc71ad8e5c", // wstETH
  "0x9b8df6e244526ab5f6e6400d331db28c8fdddb55", // uSOL
];

const CLASSIC_RATIO = [0.60, 0.70]; // 60-70% of volume

/**
 * Get existing volume for a specific date from the database
 */
async function getExistingDailyVolume(date: Date): Promise<number> {
  const startOfDay = new Date(date);
  startOfDay.setUTCHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setUTCHours(23, 59, 59, 999);

  const result = await SushiswapActivity.sum('usd_volume', {
    where: {
      chain_id: CHAIN_ID,
      block_timestamp: {
        [Op.gte]: startOfDay,
        [Op.lte]: endOfDay,
      },
    },
  });

  return result || 0;
}

interface DailySwapSelection {
  date: string;
  targetVolume: number;
  actualVolume: number;
  classicSwaps: FullSwapData[];
  limitOrderSwaps: FullSwapData[];
}

/**
 * Shuffle array using Fisher-Yates algorithm
 */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Select swaps based on volume target, split between CLASSIC and LIMIT_ORDER
 * Returns swaps that sum up to approximately the target volume
 */
function selectSwapsByVolume(
  swaps: FullSwapData[],
  targetVolume: number,
  classicRatio: number
): { classic: FullSwapData[]; limit: FullSwapData[]; actualVolume: number } {
  if (swaps.length === 0) {
    return { classic: [], limit: [], actualVolume: 0 };
  }

  // Shuffle swaps for randomness
  const shuffled = shuffleArray(swaps);

  // Calculate target volumes for each type
  const classicTarget = targetVolume * classicRatio;
  const limitTarget = targetVolume * (1 - classicRatio);

  const classicSwaps: FullSwapData[] = [];
  const limitSwaps: FullSwapData[] = [];
  let classicVolume = 0;
  let limitVolume = 0;

  // First pass: select swaps for classic
  for (const swap of shuffled) {
    if (classicVolume >= classicTarget) break;

    const swapVolume = parseFloat(swap.amountUSD);
    if (classicVolume + swapVolume <= classicTarget * 1.1) { // Allow 10% overflow
      classicSwaps.push(swap);
      classicVolume += swapVolume;
    }
  }

  // Second pass: select different swaps for limit orders
  const remainingSwaps = shuffled.filter(swap => !classicSwaps.includes(swap));
  for (const swap of remainingSwaps) {
    if (limitVolume >= limitTarget) break;

    const swapVolume = parseFloat(swap.amountUSD);
    if (limitVolume + swapVolume <= limitTarget * 1.1) { // Allow 10% overflow
      limitSwaps.push(swap);
      limitVolume += swapVolume;
    }
  }

  const actualVolume = classicVolume + limitVolume;
  return { classic: classicSwaps, limit: limitSwaps, actualVolume };
}

/**
 * Get all dates in the range
 */
function getAllDatesInRange(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  const current = new Date(start);

  while (current <= end) {
    dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

/**
 * Filter swaps by specific date (day precision)
 */
function filterSwapsByDate(swaps: FullSwapData[], targetDate: Date): FullSwapData[] {
  const targetDay = targetDate.getUTCDate();
  const targetMonth = targetDate.getUTCMonth();
  const targetYear = targetDate.getUTCFullYear();

  return swaps.filter(swap => {
    const swapDate = new Date(parseInt(swap.timestamp) * 1000);
    return (
      swapDate.getUTCDate() === targetDay &&
      swapDate.getUTCMonth() === targetMonth &&
      swapDate.getUTCFullYear() === targetYear
    );
  });
}

/**
 * Transform a full swap into SushiswapActivity record
 */
async function transformSwapToActivity(
  swap: FullSwapData,
  swapType: 'CLASSIC' | 'LIMIT_ORDER',
  userCache: Map<string, any>
): Promise<any> {
  // Get user from cache (should already exist)
  const walletKey = swap.sender.toLowerCase();
  let user = userCache.get(walletKey);

  if (!user) {
    // Fallback: find user in DB if not in cache
    user = await User.findByWallet(swap.sender, CHAIN_ID);
    if (user) {
      userCache.set(walletKey, user);
    } else {
      throw new Error(`User not found for wallet ${swap.sender}`);
    }
  }

  // Determine token direction based on amount signs
  const amount0 = parseFloat(swap.amount0);
  const amount1 = parseFloat(swap.amount1);

  let tokenFromAddress: string;
  let tokenFromSymbol: string;
  let tokenFromAmount: string;
  let tokenToAddress: string;
  let tokenToSymbol: string;
  let tokenToAmount: string;

  // Negative amount = token out (from), Positive amount = token in (to)
  if (amount0 < 0) {
    tokenFromAddress = swap.token0.id;
    tokenFromSymbol = swap.token0.symbol;
    tokenFromAmount = Math.abs(amount0).toString();
    tokenToAddress = swap.token1.id;
    tokenToSymbol = swap.token1.symbol;
    tokenToAmount = Math.abs(amount1).toString();
  } else {
    tokenFromAddress = swap.token1.id;
    tokenFromSymbol = swap.token1.symbol;
    tokenFromAmount = Math.abs(amount1).toString();
    tokenToAddress = swap.token0.id;
    tokenToSymbol = swap.token0.symbol;
    tokenToAmount = Math.abs(amount0).toString();
  }

  // Calculate execution price
  const executionPrice = Math.abs(parseFloat(tokenToAmount) / parseFloat(tokenFromAmount));

  const baseRecord = {
    user_id: user.id,
    wallet_address: swap.sender.toLowerCase(),
    swap_type: swapType,
    tx_hash: swap.transaction.id,
    chain_id: CHAIN_ID,
    block_number: parseInt(swap.transaction.blockNumber),
    block_timestamp: new Date(parseInt(swap.timestamp) * 1000),
    token_from_address: tokenFromAddress.toLowerCase(),
    token_from_symbol: tokenFromSymbol,
    token_from_amount: tokenFromAmount,
    token_to_address: tokenToAddress.toLowerCase(),
    token_to_symbol: tokenToSymbol,
    token_to_amount: tokenToAmount,
    usd_volume: parseFloat(swap.amountUSD),
    execution_price: executionPrice,
    pool_id: swap.pool.id.toLowerCase(),
    timestamp: new Date(parseInt(swap.timestamp) * 1000),
    status: 'success',
    metadata: {
      original_swap_id: swap.id,
      sqrtPriceX96: swap.sqrtPriceX96,
      tick: swap.tick,
      logIndex: swap.logIndex,
      recipient: swap.recipient,
      origin: swap.origin,
    },
  };

  if (swapType === 'LIMIT_ORDER') {
    return {
      ...baseRecord,
      order_id: `LO_${swap.id}`,
      filled_src_amount: tokenFromAmount,
      filled_dst_amount: tokenToAmount,
      is_partial_fill: false,
      progress: 100.00,
    };
  } else {
    return {
      ...baseRecord,
      order_id: null,
      filled_src_amount: null,
      filled_dst_amount: null,
      is_partial_fill: false,
      progress: null,
    };
  }
}

/**
 * Main backfill function
 */
async function backfillSushiswapActivity() {
  console.log('\n=== Backfill Sushiswap Activity Script ===\n');

  try {
    // Step 1: Connect to database
    console.log('⏳ Connecting to database...');
    await sequelize.authenticate();
    console.log('✓ Database connected\n');

    // Step 2: Fetch top pools by TVL
    console.log('⏳ Fetching top pools by TVL...');
    let allPools: any[] = [];
    for (const tokenAddress of COMMON_TOKENS) {
      const pools = await fetchPoolsByTVL(tokenAddress);
      allPools.push(...pools.slice(0, 10)); // Top 10 pools per token to get more diverse users
    }

    // Deduplicate pools
    const uniquePools = Array.from(new Set(allPools.map(p => p.id))).map(id =>
      allPools.find(p => p.id === id)
    );

    console.log(`✓ Fetched ${uniquePools.length} unique pools`);
    uniquePools.forEach((pool, idx) => {
      console.log(`  ${idx + 1}. ${pool.token0.symbol}/${pool.token1.symbol} (TVL: $${parseFloat(pool.totalValueLockedUSD).toFixed(2)})`);
    });
    console.log();

    // Step 3: Fetch all swaps from pools in date range
    console.log('⏳ Fetching swaps from subgraph...');
    const startTime = Math.floor(START_DATE.getTime() / 1000);
    const endTime = Math.floor(END_DATE.getTime() / 1000);

    let allSwaps: FullSwapData[] = [];
    for (const pool of uniquePools) {
      console.log(`  Fetching from ${pool.token0.symbol}/${pool.token1.symbol}...`);
      const swaps = await fetchFullSwaps(pool.id, startTime, endTime, 2000); // Increased limit to get more swaps
      allSwaps.push(...swaps);
    }

    console.log(`✓ Fetched ${allSwaps.length} total swaps (${START_DATE.toISOString().split('T')[0]} to ${END_DATE.toISOString().split('T')[0]})`);

    // Count unique users in fetched swaps
    const uniqueSwapUsers = new Set(allSwaps.map(s => s.sender.toLowerCase()));
    console.log(`✓ Found ${uniqueSwapUsers.size} unique wallet addresses in fetched swaps\n`);

    if (allSwaps.length === 0) {
      console.log('❌ No swaps found in the specified date range. Exiting.');
      return;
    }

    // Step 4: Select swaps by volume for each day
    console.log('⏳ Selecting swaps by volume for each day...\n');
    const dates = getAllDatesInRange(START_DATE, END_DATE);
    const dailySelections: DailySwapSelection[] = [];

    console.log('Daily Volume Distribution:');
    let runningTotal = 0;
    let skippedDays = 0;

    for (const date of dates) {
      const dateStr = date.toISOString().split('T')[0];

      // Get volume range for this date
      const { min: minVolume, max: maxVolume } = getVolumeRangeForDate(date);

      // Check existing volume in database
      const existingVolume = await getExistingDailyVolume(date);

      // Skip if existing volume is already in the target range (>= min) or exceeds it
      if (existingVolume >= minVolume) {
        console.log(`  ${dateStr}: SKIPPED - Existing volume $${Math.round(existingVolume).toLocaleString()} already >= $${minVolume.toLocaleString()}`);
        skippedDays++;
        continue;
      }

      // Generate a random total target for this day within the volume range
      const dailyTotalTarget = minVolume + Math.random() * (maxVolume - minVolume);

      // Calculate how much we need to add to reach the target
      let targetVolume = dailyTotalTarget - existingVolume;

      // Get swaps for this day
      const daySwaps = filterSwapsByDate(allSwaps, date);

      if (daySwaps.length === 0) {
        console.log(`  ${dateStr}: No swaps available (skipped)`);
        continue;
      }

      // Random classic ratio (60-70% ± 5%)
      const baseRatio = CLASSIC_RATIO[0] + Math.random() * (CLASSIC_RATIO[1] - CLASSIC_RATIO[0]);
      const ratioVariance = (Math.random() - 0.5) * 0.1; // ±5%
      const classicRatio = Math.max(0.55, Math.min(0.75, baseRatio + ratioVariance));

      // Select swaps by volume
      const { classic, limit, actualVolume } = selectSwapsByVolume(
        daySwaps,
        targetVolume,
        classicRatio
      );

      dailySelections.push({
        date: dateStr,
        targetVolume,
        actualVolume,
        classicSwaps: classic,
        limitOrderSwaps: limit,
      });

      runningTotal += actualVolume;

      const dayTotal = existingVolume + actualVolume;
      const existingLabel = existingVolume > 0 ? ` | Existing: $${Math.round(existingVolume).toLocaleString()}` : '';
      const rangeLabel = `[${(minVolume/1000).toFixed(0)}k-${(maxVolume/1000).toFixed(0)}k]`;
      console.log(
        `  ${dateStr} ${rangeLabel}: Target $${Math.round(dailyTotalTarget).toLocaleString()} | Adding $${Math.round(actualVolume).toLocaleString()} ` +
        `(${classic.length} CLASSIC, ${limit.length} LIMIT)${existingLabel} | Day Total: $${Math.round(dayTotal).toLocaleString()}`
      );
    }

    if (skippedDays > 0) {
      console.log(`\n✓ Skipped ${skippedDays} days that already had sufficient volume`);
    }

    // Calculate totals
    const totalClassic = dailySelections.reduce((sum, day) => sum + day.classicSwaps.length, 0);
    const totalLimitOrder = dailySelections.reduce((sum, day) => sum + day.limitOrderSwaps.length, 0);
    const totalSwaps = totalClassic + totalLimitOrder;
    const totalVolume = dailySelections.reduce((sum, day) => sum + day.actualVolume, 0);
    const classicVolume = dailySelections.reduce((sum, day) => {
      return sum + day.classicSwaps.reduce((s, swap) => s + parseFloat(swap.amountUSD), 0);
    }, 0);
    const limitVolume = dailySelections.reduce((sum, day) => {
      return sum + day.limitOrderSwaps.reduce((s, swap) => s + parseFloat(swap.amountUSD), 0);
    }, 0);

    console.log(`\n✓ Total selected: ${totalClassic} CLASSIC + ${totalLimitOrder} LIMIT_ORDER = ${totalSwaps} swaps`);
    console.log(`✓ Total volume: $${Math.round(totalVolume).toLocaleString()} USD`);
    console.log(`  - CLASSIC: $${Math.round(classicVolume).toLocaleString()} (${((classicVolume / totalVolume) * 100).toFixed(1)}%)`);
    console.log(`  - LIMIT_ORDER: $${Math.round(limitVolume).toLocaleString()} (${((limitVolume / totalVolume) * 100).toFixed(1)}%)\n`);

    // Step 5: Pre-create all users WITHOUT hooks to avoid lock contention
    console.log('⏳ Pre-creating users...\n');

    const uniqueWallets = new Set<string>();
    for (const day of dailySelections) {
      for (const swap of [...day.classicSwaps, ...day.limitOrderSwaps]) {
        uniqueWallets.add(swap.sender.toLowerCase());
      }
    }

    console.log(`Found ${uniqueWallets.size} unique wallet addresses`);

    // Create users in bulk WITHOUT triggering hooks
    const userRecords = Array.from(uniqueWallets).map(wallet => ({
      wallet_address: wallet,
      chain_id: CHAIN_ID,
      is_active: true,
      token_addresses: [],
      last_balance_check: null,
    }));

    // Bulk create users, ignore duplicates, and disable hooks
    const createdUsers = await User.bulkCreate(userRecords, {
      ignoreDuplicates: true,
      hooks: false, // Disable afterCreate hook to prevent referral code creation
      validate: true,
    });

    console.log(`✓ Created ${createdUsers.length} new users (${uniqueWallets.size - createdUsers.length} already existed)\n`);

    // Build user cache
    console.log('⏳ Building user cache...');
    const userCache = new Map<string, any>();
    const allUsers = await User.findAll({
      where: {
        wallet_address: Array.from(uniqueWallets),
        chain_id: CHAIN_ID,
      },
    });

    for (const user of allUsers) {
      userCache.set(user.wallet_address.toLowerCase(), user);
    }
    console.log(`✓ Cached ${userCache.size} users\n`);

    // Step 6: Transform and insert data
    console.log('⏳ Transforming and inserting swaps...\n');

    const activityRecords: any[] = [];

    for (const day of dailySelections) {
      // Process CLASSIC swaps
      for (const swap of day.classicSwaps) {
        const record = await transformSwapToActivity(swap, 'CLASSIC', userCache);
        activityRecords.push(record);
      }

      // Process LIMIT_ORDER swaps
      for (const swap of day.limitOrderSwaps) {
        const record = await transformSwapToActivity(swap, 'LIMIT_ORDER', userCache);
        activityRecords.push(record);
      }
    }

    console.log(`✓ Transformed ${activityRecords.length} swap records\n`);

    // Bulk insert with error handling
    console.log('⏳ Inserting into database...');
    try {
      const inserted = await SushiswapActivity.bulkCreate(activityRecords, {
        ignoreDuplicates: true, // Skip duplicates based on unique tx_hash
      });

      console.log(`✓ Inserted ${inserted.length} swap activities\n`);
    } catch (error: any) {
      console.error('❌ Error during bulk insert:', error.message);

      // Try individual inserts if bulk fails
      console.log('⏳ Attempting individual inserts...');
      let successCount = 0;
      let skipCount = 0;

      for (const record of activityRecords) {
        try {
          await SushiswapActivity.create(record);
          successCount++;
        } catch (err: any) {
          if (err.message.includes('Duplicate') || err.message.includes('unique')) {
            skipCount++;
          } else {
            console.error(`  Error inserting tx ${record.tx_hash}:`, err.message);
          }
        }
      }

      console.log(`✓ Individually inserted ${successCount} records (skipped ${skipCount} duplicates)\n`);
    }

    // Step 7: Verification
    console.log('⏳ Verifying inserted records...');
    const classicCount = await SushiswapActivity.count({ where: { swap_type: 'CLASSIC' } });
    const limitOrderCount = await SushiswapActivity.count({ where: { swap_type: 'LIMIT_ORDER' } });

    console.log('✓ Verification complete:');
    console.log(`  Total CLASSIC swaps in DB: ${classicCount}`);
    console.log(`  Total LIMIT_ORDER swaps in DB: ${limitOrderCount}`);
    console.log(`  Total swaps in DB: ${classicCount + limitOrderCount}\n`);

    console.log('✅ Backfill completed successfully!\n');

  } catch (error) {
    console.error('\n❌ Error during backfill:', error);
    throw error;
  } finally {
    await sequelize.close();
  }
}

// Run the script
backfillSushiswapActivity()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
