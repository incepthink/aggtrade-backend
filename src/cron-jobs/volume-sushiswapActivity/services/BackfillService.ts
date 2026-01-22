/**
 * Backfill Service
 *
 * Handles backfilling historical data and catching up missed hours.
 * For past dates: adds volume without hourly distribution
 * For today: processes hour by hour with budget distribution
 */

import {
  getBackfillDates,
  getDailyTarget,
  setDailyTarget,
  getExistingDailyVolume,
  shouldSkipDate,
  getTodayDate,
  getHoursRemaining,
  getCurrentHour,
  getDailyVolumeState,
  calculateHourlyBudget,
  logVolumeState,
  logHourlyBudget,
  getExistingHourlyVolume,
} from './VolumeTracker'
import {
  fetchPools,
  fetchSwapsForDay,
  fetchSwapsForHour,
  filterNewSwaps,
  selectSwapsByVolume,
  ensureUsersExist,
  transformSwapsToActivities,
  insertActivities,
  logSwapSelection,
} from './SwapSelector'
import { BACKFILL_CONFIG, VOLUME_CONFIG } from '../config'
import type { BackfillResult, BackfillDayResult, HourlyProcessingResult } from '../types'
import { KatanaLogger } from '../../../utils/logger'

const PREFIX = '[BackfillService]'

/**
 * Process a single day for backfill (no hourly distribution)
 */
async function processBackfillDay(date: string): Promise<BackfillDayResult> {
  KatanaLogger.info(PREFIX, `\n${'='.repeat(60)}`)
  KatanaLogger.info(PREFIX, `Processing backfill for: ${date}`)
  KatanaLogger.info(PREFIX, `${'='.repeat(60)}`)

  try {
    // Check if we should skip
    const skipCheck = await shouldSkipDate(date)
    if (skipCheck.skip) {
      KatanaLogger.info(PREFIX, `Skipping ${date}: ${skipCheck.reason}`)
      return {
        date,
        success: true,
        targetVolume: getDailyTarget(date),
        actualVolume: await getExistingDailyVolume(date),
        swapsInserted: 0,
        classicCount: 0,
        limitCount: 0,
        skipped: true,
        skipReason: skipCheck.reason,
      }
    }

    // Generate target for this day
    const targetVolume = getDailyTarget(date)
    const existingVolume = await getExistingDailyVolume(date)
    const volumeNeeded = Math.max(0, targetVolume - existingVolume)

    KatanaLogger.info(PREFIX, `Target: $${targetVolume.toLocaleString()}`)
    KatanaLogger.info(PREFIX, `Existing: $${Math.round(existingVolume).toLocaleString()}`)
    KatanaLogger.info(PREFIX, `Needed: $${Math.round(volumeNeeded).toLocaleString()}`)

    if (volumeNeeded <= 0) {
      return {
        date,
        success: true,
        targetVolume,
        actualVolume: existingVolume,
        swapsInserted: 0,
        classicCount: 0,
        limitCount: 0,
        skipped: true,
        skipReason: 'Volume target already met',
      }
    }

    // Fetch swaps for the day
    KatanaLogger.info(PREFIX, `Fetching swaps for ${date}...`)
    const allSwaps = await fetchSwapsForDay(date)

    if (allSwaps.length === 0) {
      KatanaLogger.warn(PREFIX, `No swaps available for ${date}`)
      return {
        date,
        success: false,
        targetVolume,
        actualVolume: existingVolume,
        swapsInserted: 0,
        classicCount: 0,
        limitCount: 0,
        skipped: false,
        error: 'No swaps available from indexer',
      }
    }

    // Filter out existing swaps
    const newSwaps = await filterNewSwaps(allSwaps)
    KatanaLogger.info(PREFIX, `Available: ${allSwaps.length} swaps, New: ${newSwaps.length} swaps`)

    if (newSwaps.length === 0) {
      KatanaLogger.warn(PREFIX, `All swaps already exist for ${date}`)
      return {
        date,
        success: true,
        targetVolume,
        actualVolume: existingVolume,
        swapsInserted: 0,
        classicCount: 0,
        limitCount: 0,
        skipped: true,
        skipReason: 'All available swaps already inserted',
      }
    }

    // Select swaps based on volume
    const selection = selectSwapsByVolume(newSwaps, volumeNeeded)
    logSwapSelection(selection, volumeNeeded)

    if (selection.totalVolume === 0) {
      return {
        date,
        success: false,
        targetVolume,
        actualVolume: existingVolume,
        swapsInserted: 0,
        classicCount: 0,
        limitCount: 0,
        skipped: false,
        error: 'Could not select swaps matching volume target',
      }
    }

    // Ensure users exist
    const allSelectedSwaps = [...selection.classicSwaps, ...selection.limitOrderSwaps]
    const userCache = await ensureUsersExist(allSelectedSwaps)

    // Transform and insert
    const activities = await transformSwapsToActivities(selection, userCache)
    const insertedCount = await insertActivities(activities)

    const finalVolume = await getExistingDailyVolume(date)

    KatanaLogger.info(PREFIX, `Completed ${date}: +$${Math.round(selection.totalVolume).toLocaleString()} (${insertedCount} swaps)`)
    KatanaLogger.info(PREFIX, `Final volume: $${Math.round(finalVolume).toLocaleString()}`)

    return {
      date,
      success: true,
      targetVolume,
      actualVolume: finalVolume,
      swapsInserted: insertedCount,
      classicCount: selection.classicCount,
      limitCount: selection.limitCount,
      skipped: false,
    }

  } catch (error: any) {
    KatanaLogger.error(PREFIX, `Failed to process ${date}: ${error.message}`)
    return {
      date,
      success: false,
      targetVolume: getDailyTarget(date),
      actualVolume: 0,
      swapsInserted: 0,
      classicCount: 0,
      limitCount: 0,
      skipped: false,
      error: error.message,
    }
  }
}

/**
 * Run backfill for all dates from START_DATE to yesterday
 */
export async function runBackfill(): Promise<BackfillResult> {
  KatanaLogger.info(PREFIX, '\n' + '='.repeat(70))
  KatanaLogger.info(PREFIX, '   BACKFILL MODE - Processing Historical Dates')
  KatanaLogger.info(PREFIX, '='.repeat(70))

  const dates = getBackfillDates()

  if (dates.length === 0) {
    KatanaLogger.info(PREFIX, 'No dates to backfill')
    return {
      success: true,
      daysProcessed: 0,
      daysSkipped: 0,
      daysFailed: 0,
      totalVolumeAdded: 0,
      totalSwapsInserted: 0,
      dayResults: [],
      errors: [],
    }
  }

  KatanaLogger.info(PREFIX, `Backfilling ${dates.length} days: ${dates[0]} to ${dates[dates.length - 1]}`)

  // Pre-fetch pools
  await fetchPools(true)

  const results: BackfillDayResult[] = []
  let totalVolumeAdded = 0
  let totalSwapsInserted = 0

  for (const date of dates) {
    const result = await processBackfillDay(date)
    results.push(result)

    if (result.success && !result.skipped) {
      totalVolumeAdded += result.actualVolume - (await getExistingDailyVolume(date) - result.actualVolume)
      totalSwapsInserted += result.swapsInserted
    }
  }

  const processed = results.filter(r => r.success && !r.skipped).length
  const skipped = results.filter(r => r.skipped).length
  const failed = results.filter(r => !r.success).length
  const errors = results.filter(r => r.error).map(r => `${r.date}: ${r.error}`)

  KatanaLogger.info(PREFIX, '\n' + '='.repeat(70))
  KatanaLogger.info(PREFIX, '   BACKFILL COMPLETE')
  KatanaLogger.info(PREFIX, '='.repeat(70))
  KatanaLogger.info(PREFIX, `Days processed: ${processed}`)
  KatanaLogger.info(PREFIX, `Days skipped: ${skipped}`)
  KatanaLogger.info(PREFIX, `Days failed: ${failed}`)
  KatanaLogger.info(PREFIX, `Total swaps inserted: ${totalSwapsInserted}`)

  return {
    success: failed === 0,
    daysProcessed: processed,
    daysSkipped: skipped,
    daysFailed: failed,
    totalVolumeAdded,
    totalSwapsInserted,
    dayResults: results,
    errors,
  }
}

/**
 * Process a single hour for today
 */
export async function processHour(date: string, hour: number): Promise<HourlyProcessingResult> {
  KatanaLogger.info(PREFIX, `\n${'─'.repeat(50)}`)
  KatanaLogger.info(PREFIX, `Processing hour ${hour} for ${date}`)
  KatanaLogger.info(PREFIX, `${'─'.repeat(50)}`)

  try {
    // Get current volume state
    const state = await getDailyVolumeState(date)
    logVolumeState(state)

    // Check if we have remaining volume to add
    if (state.remainingVolume <= 0) {
      KatanaLogger.info(PREFIX, `Daily target already met, skipping hour ${hour}`)
      return {
        success: true,
        date,
        hour,
        budget: 0,
        volumeAdded: 0,
        swapsInserted: 0,
        classicCount: 0,
        limitCount: 0,
      }
    }

    // Calculate hourly budget
    const hoursRemaining = 24 - hour
    const budget = calculateHourlyBudget(state.remainingVolume, hoursRemaining)
    logHourlyBudget(budget, hour)

    if (budget.finalAmount <= 0) {
      KatanaLogger.info(PREFIX, `No budget for hour ${hour}`)
      return {
        success: true,
        date,
        hour,
        budget: 0,
        volumeAdded: 0,
        swapsInserted: 0,
        classicCount: 0,
        limitCount: 0,
      }
    }

    // Check existing volume for this hour
    const existingHourlyVolume = await getExistingHourlyVolume(date, hour)
    if (existingHourlyVolume >= budget.finalAmount * 0.8) {
      KatanaLogger.info(PREFIX, `Hour ${hour} already has sufficient volume: $${Math.round(existingHourlyVolume).toLocaleString()}`)
      return {
        success: true,
        date,
        hour,
        budget: budget.finalAmount,
        volumeAdded: 0,
        swapsInserted: 0,
        classicCount: 0,
        limitCount: 0,
      }
    }

    const volumeNeeded = budget.finalAmount - existingHourlyVolume

    // Fetch swaps for this hour
    KatanaLogger.info(PREFIX, `Fetching swaps for hour ${hour}...`)
    const hourSwaps = await fetchSwapsForHour(date, hour)

    if (hourSwaps.length === 0) {
      KatanaLogger.warn(PREFIX, `No swaps available for hour ${hour}`)
      return {
        success: false,
        date,
        hour,
        budget: budget.finalAmount,
        volumeAdded: 0,
        swapsInserted: 0,
        classicCount: 0,
        limitCount: 0,
        error: 'No swaps available from indexer',
      }
    }

    // Filter out existing swaps
    const newSwaps = await filterNewSwaps(hourSwaps)
    KatanaLogger.info(PREFIX, `Available: ${hourSwaps.length} swaps, New: ${newSwaps.length} swaps`)

    if (newSwaps.length === 0) {
      KatanaLogger.info(PREFIX, `No new swaps for hour ${hour}`)
      return {
        success: true,
        date,
        hour,
        budget: budget.finalAmount,
        volumeAdded: 0,
        swapsInserted: 0,
        classicCount: 0,
        limitCount: 0,
      }
    }

    // Select swaps based on volume
    const selection = selectSwapsByVolume(newSwaps, volumeNeeded)
    logSwapSelection(selection, volumeNeeded)

    if (selection.totalVolume === 0) {
      return {
        success: false,
        date,
        hour,
        budget: budget.finalAmount,
        volumeAdded: 0,
        swapsInserted: 0,
        classicCount: 0,
        limitCount: 0,
        error: 'Could not select swaps',
      }
    }

    // Ensure users exist
    const allSelectedSwaps = [...selection.classicSwaps, ...selection.limitOrderSwaps]
    const userCache = await ensureUsersExist(allSelectedSwaps)

    // Transform and insert
    const activities = await transformSwapsToActivities(selection, userCache)
    const insertedCount = await insertActivities(activities)

    KatanaLogger.info(PREFIX, `Hour ${hour} complete: +$${Math.round(selection.totalVolume).toLocaleString()} (${insertedCount} swaps)`)

    return {
      success: true,
      date,
      hour,
      budget: budget.finalAmount,
      volumeAdded: selection.totalVolume,
      swapsInserted: insertedCount,
      classicCount: selection.classicCount,
      limitCount: selection.limitCount,
    }

  } catch (error: any) {
    KatanaLogger.error(PREFIX, `Failed to process hour ${hour}: ${error.message}`)
    return {
      success: false,
      date,
      hour,
      budget: 0,
      volumeAdded: 0,
      swapsInserted: 0,
      classicCount: 0,
      limitCount: 0,
      error: error.message,
    }
  }
}

/**
 * Catch up all missed hours for today up to (but not including) current hour
 */
export async function catchUpTodayHours(): Promise<HourlyProcessingResult[]> {
  const today = getTodayDate()
  const currentHour = getCurrentHour()

  KatanaLogger.info(PREFIX, '\n' + '='.repeat(70))
  KatanaLogger.info(PREFIX, `   CATCHUP MODE - Processing Today's Missed Hours (0 to ${currentHour - 1})`)
  KatanaLogger.info(PREFIX, '='.repeat(70))

  // Process hours 0 to (current - 1)
  const hoursToProcess = Array.from({ length: currentHour }, (_, i) => i)

  if (hoursToProcess.length === 0) {
    KatanaLogger.info(PREFIX, 'No hours to catch up (current hour is 0)')
    return []
  }

  // Pre-fetch pools
  await fetchPools(true)

  const results: HourlyProcessingResult[] = []

  for (const hour of hoursToProcess) {
    const result = await processHour(today, hour)
    results.push(result)
  }

  const successCount = results.filter(r => r.success).length
  const totalVolume = results.reduce((sum, r) => sum + r.volumeAdded, 0)
  const totalSwaps = results.reduce((sum, r) => sum + r.swapsInserted, 0)

  KatanaLogger.info(PREFIX, '\n' + '='.repeat(70))
  KatanaLogger.info(PREFIX, '   CATCHUP COMPLETE')
  KatanaLogger.info(PREFIX, '='.repeat(70))
  KatanaLogger.info(PREFIX, `Hours processed: ${successCount}/${hoursToProcess.length}`)
  KatanaLogger.info(PREFIX, `Total volume added: $${Math.round(totalVolume).toLocaleString()}`)
  KatanaLogger.info(PREFIX, `Total swaps inserted: ${totalSwaps}`)

  return results
}

/**
 * Process the current hour (called by cron every hour)
 */
export async function processCurrentHour(): Promise<HourlyProcessingResult> {
  const today = getTodayDate()
  const currentHour = getCurrentHour()

  KatanaLogger.info(PREFIX, '\n' + '='.repeat(70))
  KatanaLogger.info(PREFIX, `   HOURLY MODE - Processing Current Hour (${currentHour})`)
  KatanaLogger.info(PREFIX, '='.repeat(70))

  // Ensure pools are cached
  await fetchPools()

  return processHour(today, currentHour)
}

/**
 * Full initialization: backfill + catchup + start hourly
 * Called on first run
 */
export async function initialize(): Promise<void> {
  KatanaLogger.info(PREFIX, '\n' + '='.repeat(70))
  KatanaLogger.info(PREFIX, '   INITIALIZATION - Full Setup')
  KatanaLogger.info(PREFIX, '='.repeat(70))

  // Step 1: Backfill historical dates
  KatanaLogger.info(PREFIX, '\nStep 1: Backfilling historical dates...')
  await runBackfill()

  // Step 2: Catch up today's missed hours
  KatanaLogger.info(PREFIX, '\nStep 2: Catching up today\'s hours...')
  await catchUpTodayHours()

  // Step 3: Process current hour
  KatanaLogger.info(PREFIX, '\nStep 3: Processing current hour...')
  await processCurrentHour()

  KatanaLogger.info(PREFIX, '\n' + '='.repeat(70))
  KatanaLogger.info(PREFIX, '   INITIALIZATION COMPLETE - Hourly cron now active')
  KatanaLogger.info(PREFIX, '='.repeat(70))
}
