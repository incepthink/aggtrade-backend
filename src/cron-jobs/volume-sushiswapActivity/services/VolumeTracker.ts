/**
 * Volume Tracker Service
 *
 * Manages daily volume targets and hourly budget distribution.
 * Tracks progress throughout the day to ensure targets are met without overshoot.
 */

import { Op } from 'sequelize'
import SushiswapActivity from '../../../models/SushiswapActivity'
import { CHAIN_ID, VOLUME_CONFIG, BACKFILL_CONFIG } from '../config'
import type { DailyVolumeState, HourlyBudget } from '../types'
import { KatanaLogger } from '../../../utils/logger'

const PREFIX = '[VolumeTracker]'

// In-memory cache for daily targets (reset on restart, recalculated from DB)
const dailyTargetCache: Map<string, number> = new Map()

/**
 * Generate a random daily target between min and max
 */
export function generateDailyTarget(
  min: number = VOLUME_CONFIG.DAILY_TARGET_MIN,
  max: number = VOLUME_CONFIG.DAILY_TARGET_MAX
): number {
  return Math.round(min + Math.random() * (max - min))
}

/**
 * Get or create daily target for a specific date
 * Uses cached value if available, otherwise generates new target
 */
export function getDailyTarget(date: string): number {
  // Check cache first
  if (dailyTargetCache.has(date)) {
    return dailyTargetCache.get(date)!
  }

  // Generate new target
  const target = generateDailyTarget()
  dailyTargetCache.set(date, target)

  KatanaLogger.info(PREFIX, `Generated daily target for ${date}: $${target.toLocaleString()}`)

  return target
}

/**
 * Set daily target explicitly (used for backfill to set predetermined targets)
 */
export function setDailyTarget(date: string, target: number): void {
  dailyTargetCache.set(date, target)
}

/**
 * Get today's date in YYYY-MM-DD format (UTC)
 */
export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0]
}

/**
 * Get current hour (0-23) in UTC
 */
export function getCurrentHour(): number {
  return new Date().getUTCHours()
}

/**
 * Get hours remaining in the day (including current hour)
 */
export function getHoursRemaining(): number {
  const currentHour = getCurrentHour()
  return 24 - currentHour
}

/**
 * Get existing volume for a specific date from the database
 */
export async function getExistingDailyVolume(date: string | Date): Promise<number> {
  const dateObj = typeof date === 'string' ? new Date(date) : date
  const dateStr = dateObj.toISOString().split('T')[0]

  const startOfDay = new Date(`${dateStr}T00:00:00.000Z`)
  const endOfDay = new Date(`${dateStr}T23:59:59.999Z`)

  const result = await SushiswapActivity.sum('usd_volume', {
    where: {
      chain_id: CHAIN_ID,
      block_timestamp: {
        [Op.gte]: startOfDay,
        [Op.lte]: endOfDay,
      },
    },
  })

  return result || 0
}

/**
 * Get existing volume for a specific hour of a date
 */
export async function getExistingHourlyVolume(date: string, hour: number): Promise<number> {
  const startOfHour = new Date(`${date}T${hour.toString().padStart(2, '0')}:00:00.000Z`)
  const endOfHour = new Date(`${date}T${hour.toString().padStart(2, '0')}:59:59.999Z`)

  const result = await SushiswapActivity.sum('usd_volume', {
    where: {
      chain_id: CHAIN_ID,
      block_timestamp: {
        [Op.gte]: startOfHour,
        [Op.lte]: endOfHour,
      },
    },
  })

  return result || 0
}

/**
 * Get current daily volume state
 */
export async function getDailyVolumeState(date?: string): Promise<DailyVolumeState> {
  const targetDate = date || getTodayDate()
  const targetVolume = getDailyTarget(targetDate)
  const currentVolume = await getExistingDailyVolume(targetDate)
  const remainingVolume = Math.max(0, targetVolume - currentVolume)
  const hoursRemaining = targetDate === getTodayDate() ? getHoursRemaining() : 0

  return {
    date: targetDate,
    targetVolume,
    currentVolume,
    remainingVolume,
    hoursRemaining,
    lastHourlyRun: -1, // Will be determined from DB if needed
  }
}

/**
 * Calculate hourly budget based on remaining volume and hours
 * Uses randomization to avoid fixed patterns
 */
export function calculateHourlyBudget(
  remainingVolume: number,
  hoursRemaining: number
): HourlyBudget {
  // Edge cases
  if (hoursRemaining <= 0 || remainingVolume <= 0) {
    return {
      baseAmount: 0,
      adjustedAmount: 0,
      minCap: 0,
      maxCap: 0,
      finalAmount: 0,
    }
  }

  // Calculate base amount (even distribution)
  const baseAmount = remainingVolume / hoursRemaining

  // Apply random variance (-30% to +30%)
  const variance = (Math.random() - 0.5) * 2 * VOLUME_CONFIG.HOURLY_VARIANCE
  const adjustedAmount = baseAmount * (1 + variance)

  // Apply min/max caps
  const minCap = VOLUME_CONFIG.HOURLY_MIN
  const maxCap = Math.min(VOLUME_CONFIG.HOURLY_MAX, remainingVolume)

  // Calculate final amount with caps
  let finalAmount = Math.max(minCap, Math.min(maxCap, adjustedAmount))

  // On last hour, use remaining volume (allow overshoot buffer)
  if (hoursRemaining === 1) {
    const maxAllowed = remainingVolume * (1 + VOLUME_CONFIG.OVERSHOOT_BUFFER)
    finalAmount = Math.min(maxAllowed, remainingVolume)
  }

  // Ensure we don't exceed remaining volume (with small buffer)
  const absoluteMax = remainingVolume * (1 + VOLUME_CONFIG.OVERSHOOT_BUFFER)
  finalAmount = Math.min(finalAmount, absoluteMax)

  return {
    baseAmount: Math.round(baseAmount),
    adjustedAmount: Math.round(adjustedAmount),
    minCap,
    maxCap,
    finalAmount: Math.round(finalAmount),
  }
}

/**
 * Get all dates between start and end (inclusive)
 */
export function getDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  const current = new Date(`${startDate}T00:00:00.000Z`)
  const end = new Date(`${endDate}T00:00:00.000Z`)

  while (current <= end) {
    dates.push(current.toISOString().split('T')[0])
    current.setDate(current.getDate() + 1)
  }

  return dates
}

/**
 * Get dates that need backfilling (from BACKFILL_CONFIG.START_DATE to yesterday)
 */
export function getBackfillDates(): string[] {
  const today = getTodayDate()
  const startDate = BACKFILL_CONFIG.START_DATE

  // Get all dates from start to yesterday
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const endDate = yesterday.toISOString().split('T')[0]

  // Only include dates before today
  if (endDate < startDate) {
    return [] // No backfill needed
  }

  return getDateRange(startDate, endDate)
}

/**
 * Get hours that need processing for today
 * Returns hours from 0 to current hour (inclusive)
 */
export function getHoursToProcess(date: string): number[] {
  const today = getTodayDate()

  if (date !== today) {
    // For past dates, all 24 hours
    return Array.from({ length: 24 }, (_, i) => i)
  }

  // For today, hours from 0 to current hour
  const currentHour = getCurrentHour()
  return Array.from({ length: currentHour + 1 }, (_, i) => i)
}

/**
 * Check if we should skip a date (already has sufficient volume)
 */
export async function shouldSkipDate(date: string): Promise<{ skip: boolean; reason?: string }> {
  const targetVolume = getDailyTarget(date)
  const existingVolume = await getExistingDailyVolume(date)

  // Skip if existing volume is >= 95% of target
  const threshold = targetVolume * 0.95

  if (existingVolume >= threshold) {
    return {
      skip: true,
      reason: `Existing volume $${Math.round(existingVolume).toLocaleString()} >= 95% of target $${targetVolume.toLocaleString()}`,
    }
  }

  return { skip: false }
}

/**
 * Log volume state summary
 */
export function logVolumeState(state: DailyVolumeState): void {
  const progressPct = state.targetVolume > 0
    ? ((state.currentVolume / state.targetVolume) * 100).toFixed(1)
    : '0.0'

  KatanaLogger.info(PREFIX, `Daily Volume State for ${state.date}:`)
  KatanaLogger.info(PREFIX, `  Target: $${state.targetVolume.toLocaleString()}`)
  KatanaLogger.info(PREFIX, `  Current: $${Math.round(state.currentVolume).toLocaleString()} (${progressPct}%)`)
  KatanaLogger.info(PREFIX, `  Remaining: $${Math.round(state.remainingVolume).toLocaleString()}`)
  KatanaLogger.info(PREFIX, `  Hours left: ${state.hoursRemaining}`)
}

/**
 * Log hourly budget calculation
 */
export function logHourlyBudget(budget: HourlyBudget, hour: number): void {
  KatanaLogger.info(PREFIX, `Hourly Budget for hour ${hour}:`)
  KatanaLogger.info(PREFIX, `  Base: $${budget.baseAmount.toLocaleString()}`)
  KatanaLogger.info(PREFIX, `  Adjusted: $${budget.adjustedAmount.toLocaleString()}`)
  KatanaLogger.info(PREFIX, `  Caps: [$${budget.minCap.toLocaleString()} - $${budget.maxCap.toLocaleString()}]`)
  KatanaLogger.info(PREFIX, `  Final: $${budget.finalAmount.toLocaleString()}`)
}
