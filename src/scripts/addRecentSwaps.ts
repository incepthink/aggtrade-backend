// src/scripts/addRecentSwaps.ts

import sequelize from '../utils/db/sequelize';
import User from '../models/User';
import SushiswapActivity from '../models/SushiswapActivity';
import { fetchPoolsByTVL, fetchFullSwaps } from '../utils/katana/dataFetching';
import type { FullSwapData } from '../utils/katana/types';

const CHAIN_ID = 747474;
const HOURS_TO_BACKFILL = 23;
const MAX_VOLUME_USD = 10; // Volume cap: $10 USD

// Token addresses to fetch pools for
const COMMON_TOKENS = [
  '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62', // WETH
  '0x203a662b0bd271a6ed5a60edfbd04bfce608fd36', // USDC
  '0x0913da6da4b42f538b445599b46bb4622342cf52', // WBTC
];

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
 * Group swaps by hour bucket
 */
function groupSwapsByHour(
  swaps: FullSwapData[],
  startTime: number,
  endTime: number
): Map<number, FullSwapData[]> {
  const swapsByHour = new Map<number, FullSwapData[]>();

  // Initialize all hour buckets (0-22 for 23 hours)
  for (let i = 0; i < HOURS_TO_BACKFILL; i++) {
    swapsByHour.set(i, []);
  }

  // Group swaps into hour buckets
  for (const swap of swaps) {
    const swapTimestamp = parseInt(swap.timestamp);
    const hoursSinceStart = Math.floor((swapTimestamp - startTime) / 3600);

    if (hoursSinceStart >= 0 && hoursSinceStart < HOURS_TO_BACKFILL) {
      const bucket = swapsByHour.get(hoursSinceStart) || [];
      bucket.push(swap);
      swapsByHour.set(hoursSinceStart, bucket);
    }
  }

  return swapsByHour;
}

/**
 * Select 1-2 swaps per hour bucket
 */
function selectSwapsPerHour(
  swapsByHour: Map<number, FullSwapData[]>
): FullSwapData[] {
  const selected: FullSwapData[] = [];

  for (const [hourIndex, swaps] of swapsByHour.entries()) {
    if (swaps.length === 0) {
      console.log(`  Hour ${hourIndex}: No swaps available (skipped)`);
      continue;
    }

    // Shuffle swaps in this hour
    const shuffled = shuffleArray(swaps);

    // Select 1-2 swaps (70% chance 1, 30% chance 2)
    const count = Math.random() < 0.7 ? 1 : 2;
    const toSelect = Math.min(count, shuffled.length);

    for (let i = 0; i < toSelect; i++) {
      selected.push(shuffled[i]);
    }

    console.log(`  Hour ${hourIndex}: Selected ${toSelect} swap(s) from ${swaps.length} available`);
  }

  return selected;
}

/**
 * Transform swap to SushiswapActivity record
 */
async function transformSwapToActivity(
  swap: FullSwapData
): Promise<any> {
  // Get or create user
  const { user } = await User.findOrCreateUser(swap.sender, CHAIN_ID);

  // Randomly assign CLASSIC or LIMIT_ORDER (50/50)
  const swapType: 'CLASSIC' | 'LIMIT_ORDER' = Math.random() < 0.5 ? 'CLASSIC' : 'LIMIT_ORDER';

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
 * Transform all swaps to SushiswapActivity records
 */
async function transformSwaps(swaps: FullSwapData[]): Promise<any[]> {
  const records: any[] = [];

  for (const swap of swaps) {
    const record = await transformSwapToActivity(swap);
    records.push(record);
  }

  return records;
}

/**
 * Main function
 */
async function main() {
  console.log('\n=== Add Recent Swaps Script ===\n');

  try {
    // 1. Connect to database
    console.log('⏳ Connecting to database...');
    await sequelize.authenticate();
    console.log('✓ Database connected\n');

    // 2. Calculate time range (23 hours ago to now)
    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - (HOURS_TO_BACKFILL * 60 * 60);

    console.log('⏳ Time range:');
    console.log(`  Start: ${new Date(startTime * 1000).toISOString()}`);
    console.log(`  End:   ${new Date(endTime * 1000).toISOString()}`);
    console.log(`  Duration: ${HOURS_TO_BACKFILL} hours\n`);

    // 3. Fetch top pools by TVL (WETH, USDC, WBTC pairs)
    console.log('⏳ Fetching top pools by TVL...');
    let allPools: any[] = [];
    for (const tokenAddress of COMMON_TOKENS) {
      const pools = await fetchPoolsByTVL(tokenAddress);
      allPools.push(...pools.slice(0, 3)); // Top 3 pools per token
    }

    // Deduplicate pools by id
    const uniquePools = Array.from(new Set(allPools.map(p => p.id))).map(id =>
      allPools.find(p => p.id === id)
    );

    // Take top pools by TVL
    const topPools = uniquePools
      .sort((a, b) => parseFloat(b.totalValueLockedUSD) - parseFloat(a.totalValueLockedUSD))
      .slice(0, 5); // Top 5 pools overall

    console.log(`✓ Selected ${topPools.length} pools:`);
    topPools.forEach((pool, idx) => {
      console.log(`  ${idx + 1}. ${pool.token0.symbol}/${pool.token1.symbol} (TVL: $${parseFloat(pool.totalValueLockedUSD).toFixed(2)})`);
    });
    console.log();

    // 4. Fetch all swaps from those pools
    console.log('⏳ Fetching swaps from subgraph...');
    let allSwaps: FullSwapData[] = [];
    for (const pool of topPools) {
      console.log(`  Fetching from ${pool.token0.symbol}/${pool.token1.symbol}...`);
      const swaps = await fetchFullSwaps(pool.id, startTime, endTime, 1000);
      allSwaps.push(...swaps);
    }
    console.log(`✓ Fetched ${allSwaps.length} total swaps\n`);

    // 5. Filter swaps by volume cap (≤ $10 USD)
    console.log(`⏳ Filtering swaps with volume ≤ $${MAX_VOLUME_USD}...`);
    const smallSwaps = allSwaps.filter(swap => parseFloat(swap.amountUSD) <= MAX_VOLUME_USD);
    console.log(`✓ Filtered to ${smallSwaps.length} swaps ≤ $${MAX_VOLUME_USD}\n`);

    if (smallSwaps.length === 0) {
      console.log('❌ No swaps found with volume ≤ $10. Exiting.');
      return;
    }

    // 6. Group swaps by hour
    console.log('⏳ Grouping swaps by hour...\n');
    const swapsByHour = groupSwapsByHour(smallSwaps, startTime, endTime);

    // 7. Select 1-2 swaps per hour
    console.log('⏳ Selecting swaps per hour:\n');
    const selectedSwaps = selectSwapsPerHour(swapsByHour);
    console.log(`\n✓ Selected ${selectedSwaps.length} total swaps\n`);

    if (selectedSwaps.length === 0) {
      console.log('❌ No swaps selected. Exiting.');
      return;
    }

    // 8. Transform and create users
    console.log('⏳ Transforming swaps and creating users...');
    const activityRecords = await transformSwaps(selectedSwaps);
    console.log(`✓ Transformed ${activityRecords.length} swap records\n`);

    // 9. Bulk insert
    console.log('⏳ Inserting into sushiswap_activity...');
    const inserted = await SushiswapActivity.bulkCreate(activityRecords, {
      ignoreDuplicates: true,
    });
    console.log(`✓ Inserted ${inserted.length} swap activities\n`);

    // 10. Print summary
    const totalVolume = activityRecords.reduce((sum, r) => sum + r.usd_volume, 0);
    const avgVolume = totalVolume / activityRecords.length;
    const classicCount = activityRecords.filter(r => r.swap_type === 'CLASSIC').length;
    const limitCount = activityRecords.filter(r => r.swap_type === 'LIMIT_ORDER').length;

    console.log('=== Summary ===');
    console.log(`✅ Inserted ${activityRecords.length} swaps across ${HOURS_TO_BACKFILL} hours`);
    console.log(`   - CLASSIC: ${classicCount}`);
    console.log(`   - LIMIT_ORDER: ${limitCount}`);
    console.log(`   Total volume: $${totalVolume.toFixed(2)}`);
    console.log(`   Avg volume: $${avgVolume.toFixed(2)}`);
    console.log(`   Max volume: $${MAX_VOLUME_USD.toFixed(2)}\n`);

  } catch (error) {
    console.error('\n❌ Error during script execution:', error);
    throw error;
  } finally {
    await sequelize.close();
  }
}

// Run the script
main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
