/**
 * Swap Selector Service
 *
 * Fetches swap data from the indexer and selects swaps based on volume budget.
 * Handles CLASSIC vs LIMIT_ORDER distribution with randomization.
 */

import { Op } from 'sequelize'
import User from '../../../models/User'
import SushiswapActivity from '../../../models/SushiswapActivity'
import { fetchPoolsByTVL, fetchFullSwaps } from '../../../utils/katana/dataFetching'
import type { FullSwapData, Pool } from '../../../utils/katana/types'
import type { SwapSelection, ActivityRecord } from '../types'
import {
  CHAIN_ID,
  COMMON_TOKENS,
  POOLS_PER_TOKEN,
  MAX_SWAPS_PER_POOL,
  SWAP_RATIO_CONFIG,
} from '../config'
import { KatanaLogger } from '../../../utils/logger'

const PREFIX = '[SwapSelector]'

// Pool cache to avoid repeated fetches
let poolCache: Pool[] | null = null
let poolCacheTime: number = 0
const POOL_CACHE_TTL = 30 * 60 * 1000 // 30 minutes

/**
 * Fisher-Yates shuffle for randomizing arrays
 */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

/**
 * Fetch all pools from common tokens
 * Uses caching to avoid repeated fetches
 */
export async function fetchPools(forceRefresh: boolean = false): Promise<Pool[]> {
  const now = Date.now()

  // Return cached pools if valid
  if (!forceRefresh && poolCache && now - poolCacheTime < POOL_CACHE_TTL) {
    KatanaLogger.info(PREFIX, `Using cached pools (${poolCache.length} pools)`)
    return poolCache
  }

  KatanaLogger.info(PREFIX, 'Fetching pools from subgraph...')

  const allPools: Pool[] = []

  for (const tokenAddress of COMMON_TOKENS) {
    try {
      const pools = await fetchPoolsByTVL(tokenAddress)
      allPools.push(...pools.slice(0, POOLS_PER_TOKEN))
    } catch (error) {
      KatanaLogger.warn(PREFIX, `Failed to fetch pools for token ${tokenAddress}`)
    }
  }

  // Deduplicate by pool ID
  const uniquePools = Array.from(
    new Map(allPools.map(p => [p.id, p])).values()
  )

  poolCache = uniquePools
  poolCacheTime = now

  KatanaLogger.info(PREFIX, `Fetched ${uniquePools.length} unique pools`)

  return uniquePools
}

/**
 * Fetch swaps for a specific date range
 */
export async function fetchSwapsForDateRange(
  startTime: number,
  endTime: number,
  pools?: Pool[]
): Promise<FullSwapData[]> {
  const targetPools = pools || await fetchPools()
  const allSwaps: FullSwapData[] = []

  KatanaLogger.info(PREFIX, `Fetching swaps from ${new Date(startTime * 1000).toISOString()} to ${new Date(endTime * 1000).toISOString()}`)

  for (const pool of targetPools) {
    try {
      const swaps = await fetchFullSwaps(pool.id, startTime, endTime, MAX_SWAPS_PER_POOL)
      allSwaps.push(...swaps)
    } catch (error) {
      KatanaLogger.warn(PREFIX, `Failed to fetch swaps from pool ${pool.id}`)
    }
  }

  KatanaLogger.info(PREFIX, `Fetched ${allSwaps.length} total swaps`)

  return allSwaps
}

/**
 * Fetch swaps for a specific day
 */
export async function fetchSwapsForDay(date: string): Promise<FullSwapData[]> {
  const startOfDay = new Date(`${date}T00:00:00.000Z`)
  const endOfDay = new Date(`${date}T23:59:59.999Z`)

  const startTime = Math.floor(startOfDay.getTime() / 1000)
  const endTime = Math.floor(endOfDay.getTime() / 1000)

  return fetchSwapsForDateRange(startTime, endTime)
}

/**
 * Fetch swaps for a specific hour
 */
export async function fetchSwapsForHour(date: string, hour: number): Promise<FullSwapData[]> {
  const startOfHour = new Date(`${date}T${hour.toString().padStart(2, '0')}:00:00.000Z`)
  const endOfHour = new Date(`${date}T${hour.toString().padStart(2, '0')}:59:59.999Z`)

  const startTime = Math.floor(startOfHour.getTime() / 1000)
  const endTime = Math.floor(endOfHour.getTime() / 1000)

  return fetchSwapsForDateRange(startTime, endTime)
}

/**
 * Filter swaps to only include those within a specific hour
 */
export function filterSwapsByHour(swaps: FullSwapData[], date: string, hour: number): FullSwapData[] {
  const startOfHour = new Date(`${date}T${hour.toString().padStart(2, '0')}:00:00.000Z`).getTime() / 1000
  const endOfHour = new Date(`${date}T${hour.toString().padStart(2, '0')}:59:59.999Z`).getTime() / 1000

  return swaps.filter(swap => {
    const timestamp = parseInt(swap.timestamp)
    return timestamp >= startOfHour && timestamp <= endOfHour
  })
}

/**
 * Check if a swap already exists in the database
 */
export async function swapExists(txHash: string): Promise<boolean> {
  const existing = await SushiswapActivity.findOne({
    where: { tx_hash: txHash },
    attributes: ['id'],
  })
  return !!existing
}

/**
 * Filter out swaps that already exist in the database
 */
export async function filterNewSwaps(swaps: FullSwapData[]): Promise<FullSwapData[]> {
  if (swaps.length === 0) return []

  const txHashes = swaps.map(s => s.transaction.id)

  const existingHashes = await SushiswapActivity.findAll({
    where: { tx_hash: { [Op.in]: txHashes } },
    attributes: ['tx_hash'],
    raw: true,
  })

  const existingSet = new Set(existingHashes.map((r: any) => r.tx_hash))

  return swaps.filter(s => !existingSet.has(s.transaction.id))
}

/**
 * Calculate classic ratio for this run with randomization
 */
function getClassicRatio(): number {
  const baseRatio = SWAP_RATIO_CONFIG.CLASSIC_MIN +
    Math.random() * (SWAP_RATIO_CONFIG.CLASSIC_MAX - SWAP_RATIO_CONFIG.CLASSIC_MIN)

  const variance = (Math.random() - 0.5) * 2 * SWAP_RATIO_CONFIG.VARIANCE
  const finalRatio = baseRatio + variance

  return Math.max(SWAP_RATIO_CONFIG.CLASSIC_MIN, Math.min(SWAP_RATIO_CONFIG.CLASSIC_MAX, finalRatio))
}

/**
 * Select swaps to match a target volume budget
 * Distributes between CLASSIC and LIMIT_ORDER types
 */
export function selectSwapsByVolume(
  swaps: FullSwapData[],
  targetVolume: number
): SwapSelection {
  if (swaps.length === 0 || targetVolume <= 0) {
    return {
      classicSwaps: [],
      limitOrderSwaps: [],
      totalVolume: 0,
      classicVolume: 0,
      limitVolume: 0,
      classicCount: 0,
      limitCount: 0,
    }
  }

  // Shuffle for randomness
  const shuffled = shuffleArray(swaps)

  // Calculate target volumes for each type
  const classicRatio = getClassicRatio()
  const classicTarget = targetVolume * classicRatio
  const limitTarget = targetVolume * (1 - classicRatio)

  const classicSwaps: FullSwapData[] = []
  const limitSwaps: FullSwapData[] = []
  let classicVolume = 0
  let limitVolume = 0

  // First pass: select swaps for CLASSIC
  for (const swap of shuffled) {
    if (classicVolume >= classicTarget) break

    const swapVolume = parseFloat(swap.amountUSD)
    // Allow 10% overflow to get closer to target
    if (classicVolume + swapVolume <= classicTarget * 1.1) {
      classicSwaps.push(swap)
      classicVolume += swapVolume
    }
  }

  // Second pass: select different swaps for LIMIT_ORDER
  const usedSwapIds = new Set(classicSwaps.map(s => s.id))
  const remainingSwaps = shuffled.filter(s => !usedSwapIds.has(s.id))

  for (const swap of remainingSwaps) {
    if (limitVolume >= limitTarget) break

    const swapVolume = parseFloat(swap.amountUSD)
    if (limitVolume + swapVolume <= limitTarget * 1.1) {
      limitSwaps.push(swap)
      limitVolume += swapVolume
    }
  }

  const totalVolume = classicVolume + limitVolume

  return {
    classicSwaps,
    limitOrderSwaps: limitSwaps,
    totalVolume,
    classicVolume,
    limitVolume,
    classicCount: classicSwaps.length,
    limitCount: limitSwaps.length,
  }
}

/**
 * Ensure users exist for all swaps
 * Creates users in bulk without hooks
 */
export async function ensureUsersExist(swaps: FullSwapData[]): Promise<Map<string, any>> {
  const wallets = new Set(swaps.map(s => s.sender.toLowerCase()))
  const walletArray = Array.from(wallets)

  KatanaLogger.info(PREFIX, `Ensuring ${walletArray.length} users exist...`)

  // Bulk create users without hooks
  const userRecords = walletArray.map(wallet => ({
    wallet_address: wallet,
    chain_id: CHAIN_ID,
    is_active: true,
    token_addresses: [],
    last_balance_check: null,
  }))

  await User.bulkCreate(userRecords, {
    ignoreDuplicates: true,
    hooks: false,
    validate: true,
  })

  // Build user cache
  const allUsers = await User.findAll({
    where: {
      wallet_address: walletArray,
      chain_id: CHAIN_ID,
    },
    raw: true,
  })

  const userCache = new Map<string, any>()
  for (const user of allUsers) {
    userCache.set((user as any).wallet_address.toLowerCase(), user)
  }

  KatanaLogger.info(PREFIX, `Cached ${userCache.size} users`)

  return userCache
}

/**
 * Transform a swap into an activity record
 */
export async function transformSwapToActivity(
  swap: FullSwapData,
  swapType: 'CLASSIC' | 'LIMIT_ORDER',
  userCache: Map<string, any>
): Promise<ActivityRecord> {
  const walletKey = swap.sender.toLowerCase()
  const user = userCache.get(walletKey)

  if (!user) {
    throw new Error(`User not found for wallet ${swap.sender}`)
  }

  // Determine token direction based on amount signs
  const amount0 = parseFloat(swap.amount0)
  const amount1 = parseFloat(swap.amount1)

  let tokenFromAddress: string
  let tokenFromSymbol: string
  let tokenFromAmount: string
  let tokenToAddress: string
  let tokenToSymbol: string
  let tokenToAmount: string

  // Negative amount = token out (from), Positive amount = token in (to)
  if (amount0 < 0) {
    tokenFromAddress = swap.token0.id
    tokenFromSymbol = swap.token0.symbol
    tokenFromAmount = Math.abs(amount0).toString()
    tokenToAddress = swap.token1.id
    tokenToSymbol = swap.token1.symbol
    tokenToAmount = Math.abs(amount1).toString()
  } else {
    tokenFromAddress = swap.token1.id
    tokenFromSymbol = swap.token1.symbol
    tokenFromAmount = Math.abs(amount1).toString()
    tokenToAddress = swap.token0.id
    tokenToSymbol = swap.token0.symbol
    tokenToAmount = Math.abs(amount0).toString()
  }

  const executionPrice = Math.abs(parseFloat(tokenToAmount) / parseFloat(tokenFromAmount)) || 0

  const baseRecord: ActivityRecord = {
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
    is_partial_fill: false,
    metadata: {
      original_swap_id: swap.id,
      sqrtPriceX96: swap.sqrtPriceX96,
      tick: swap.tick,
      logIndex: swap.logIndex,
      recipient: swap.recipient,
      origin: swap.origin,
    },
  }

  if (swapType === 'LIMIT_ORDER') {
    return {
      ...baseRecord,
      order_id: `LO_${swap.id}`,
      filled_src_amount: tokenFromAmount,
      filled_dst_amount: tokenToAmount,
      progress: 100.00,
    }
  }

  return baseRecord
}

/**
 * Transform selected swaps into activity records
 */
export async function transformSwapsToActivities(
  selection: SwapSelection,
  userCache: Map<string, any>
): Promise<ActivityRecord[]> {
  const activities: ActivityRecord[] = []

  // Transform CLASSIC swaps
  for (const swap of selection.classicSwaps) {
    const activity = await transformSwapToActivity(swap, 'CLASSIC', userCache)
    activities.push(activity)
  }

  // Transform LIMIT_ORDER swaps
  for (const swap of selection.limitOrderSwaps) {
    const activity = await transformSwapToActivity(swap, 'LIMIT_ORDER', userCache)
    activities.push(activity)
  }

  return activities
}

/**
 * Insert activity records into the database
 */
export async function insertActivities(activities: ActivityRecord[]): Promise<number> {
  if (activities.length === 0) return 0

  try {
    const inserted = await SushiswapActivity.bulkCreate(activities as any, {
      ignoreDuplicates: true,
    })

    KatanaLogger.info(PREFIX, `Inserted ${inserted.length} activity records`)
    return inserted.length
  } catch (error: any) {
    KatanaLogger.error(PREFIX, `Bulk insert failed: ${error.message}`)

    // Fallback to individual inserts
    let successCount = 0
    for (const activity of activities) {
      try {
        await SushiswapActivity.create(activity as any)
        successCount++
      } catch (err: any) {
        if (!err.message.includes('Duplicate') && !err.message.includes('unique')) {
          KatanaLogger.warn(PREFIX, `Failed to insert ${activity.tx_hash}: ${err.message}`)
        }
      }
    }

    KatanaLogger.info(PREFIX, `Individually inserted ${successCount} records`)
    return successCount
  }
}

/**
 * Log swap selection summary
 */
export function logSwapSelection(selection: SwapSelection, targetVolume: number): void {
  const pctAchieved = targetVolume > 0
    ? ((selection.totalVolume / targetVolume) * 100).toFixed(1)
    : '0.0'

  KatanaLogger.info(PREFIX, `Swap Selection:`)
  KatanaLogger.info(PREFIX, `  Target: $${targetVolume.toLocaleString()}`)
  KatanaLogger.info(PREFIX, `  Selected: $${Math.round(selection.totalVolume).toLocaleString()} (${pctAchieved}%)`)
  KatanaLogger.info(PREFIX, `  CLASSIC: ${selection.classicCount} swaps ($${Math.round(selection.classicVolume).toLocaleString()})`)
  KatanaLogger.info(PREFIX, `  LIMIT: ${selection.limitCount} swaps ($${Math.round(selection.limitVolume).toLocaleString()})`)
}
