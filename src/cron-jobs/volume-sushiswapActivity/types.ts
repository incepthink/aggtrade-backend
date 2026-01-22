/**
 * Volume Sushiswap Activity Cron Job - Type Definitions
 */

import type { FullSwapData, Pool } from '../../utils/katana/types'

/**
 * Daily volume target state
 */
export interface DailyVolumeState {
  date: string               // YYYY-MM-DD format
  targetVolume: number       // Daily target in USD
  currentVolume: number      // Current volume added today
  remainingVolume: number    // targetVolume - currentVolume
  hoursRemaining: number     // Hours left in the day
  lastHourlyRun: number      // Last hour that was processed (0-23)
}

/**
 * Hourly budget calculation result
 */
export interface HourlyBudget {
  baseAmount: number         // Base calculated amount
  adjustedAmount: number     // Amount after variance applied
  minCap: number             // Minimum cap applied
  maxCap: number             // Maximum cap applied
  finalAmount: number        // Final budget for this hour
}

/**
 * Selected swaps for insertion
 */
export interface SwapSelection {
  classicSwaps: FullSwapData[]
  limitOrderSwaps: FullSwapData[]
  totalVolume: number
  classicVolume: number
  limitVolume: number
  classicCount: number
  limitCount: number
}

/**
 * Result of hourly processing
 */
export interface HourlyProcessingResult {
  success: boolean
  date: string
  hour: number
  budget: number
  volumeAdded: number
  swapsInserted: number
  classicCount: number
  limitCount: number
  error?: string
}

/**
 * Backfill day result
 */
export interface BackfillDayResult {
  date: string
  success: boolean
  targetVolume: number
  actualVolume: number
  swapsInserted: number
  classicCount: number
  limitCount: number
  skipped: boolean
  skipReason?: string
  error?: string
}

/**
 * Overall backfill result
 */
export interface BackfillResult {
  success: boolean
  daysProcessed: number
  daysSkipped: number
  daysFailed: number
  totalVolumeAdded: number
  totalSwapsInserted: number
  dayResults: BackfillDayResult[]
  errors: string[]
}

/**
 * Pool cache entry
 */
export interface PoolCacheEntry {
  pools: Pool[]
  timestamp: number
}

/**
 * Swap cache entry for a specific date range
 */
export interface SwapCacheEntry {
  swaps: FullSwapData[]
  poolId: string
  startTime: number
  endTime: number
  fetchedAt: number
}

/**
 * Activity record to be inserted into database
 */
export interface ActivityRecord {
  user_id: number
  wallet_address: string
  swap_type: 'CLASSIC' | 'LIMIT_ORDER'
  tx_hash: string
  chain_id: number
  block_number: number
  block_timestamp: Date
  token_from_address: string
  token_from_symbol: string
  token_from_amount: string
  token_to_address: string
  token_to_symbol: string
  token_to_amount: string
  usd_volume: number
  execution_price: number
  pool_id: string
  timestamp: Date
  status: string
  metadata: Record<string, any>
  order_id?: string
  filled_src_amount?: string
  filled_dst_amount?: string
  is_partial_fill: boolean
  progress?: number
}

/**
 * Mode for cron job operation
 */
export type OperationMode = 'backfill' | 'hourly' | 'catchup'

/**
 * Cron job run statistics
 */
export interface CronRunStats {
  mode: OperationMode
  startTime: Date
  endTime?: Date
  durationMs?: number
  volumeAdded: number
  swapsInserted: number
  errors: string[]
}
