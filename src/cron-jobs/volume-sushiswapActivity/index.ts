/**
 * Volume Sushiswap Activity Cron Job
 *
 * Hourly cron job that:
 * 1. Fetches SushiSwap swap data via indexer
 * 2. Upserts into database
 * 3. Tracks daily USD volume with randomized targets ($95k-$125k)
 * 4. Distributes volume across hours with min/max caps
 *
 * On first run:
 * - Backfills from 2026-01-17 to yesterday
 * - Catches up today's missed hours
 * - Starts hourly processing
 *
 * Subsequent runs:
 * - Processes current hour only
 */

import cron from 'node-cron'
import sequelize from '../../utils/db/sequelize'
import { KatanaLogger } from '../../utils/logger'
import { SCHEDULE_CONFIG } from './config'
import {
  initialize,
  processCurrentHour,
  runBackfill,
  catchUpTodayHours,
} from './services/BackfillService'
import { getDailyVolumeState, logVolumeState } from './services/VolumeTracker'

const PREFIX = '[VolumeSushiswapActivity]'

// Track initialization state
let isInitialized = false
let isRunning = false

/**
 * Run the hourly volume processing
 */
async function runHourlyVolume(): Promise<void> {
  // Prevent concurrent runs
  if (isRunning) {
    KatanaLogger.warn(PREFIX, 'Job already running, skipping this execution')
    return
  }

  isRunning = true
  const startTime = Date.now()

  try {
    KatanaLogger.info(PREFIX, '\n' + '='.repeat(70))
    KatanaLogger.info(PREFIX, `   VOLUME SUSHISWAP ACTIVITY - ${new Date().toISOString()}`)
    KatanaLogger.info(PREFIX, '='.repeat(70))

    // Check if first run
    if (!isInitialized) {
      KatanaLogger.info(PREFIX, 'First run detected - running full initialization')
      await initialize()
      isInitialized = true
    } else {
      // Normal hourly run
      const result = await processCurrentHour()

      if (result.success) {
        KatanaLogger.info(PREFIX, `Hourly run complete: +$${Math.round(result.volumeAdded).toLocaleString()} (${result.swapsInserted} swaps)`)
      } else {
        KatanaLogger.warn(PREFIX, `Hourly run had issues: ${result.error || 'Unknown error'}`)
      }
    }

    // Log current state
    const state = await getDailyVolumeState()
    logVolumeState(state)

    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    KatanaLogger.info(PREFIX, `Job completed in ${duration}s`)

  } catch (error: any) {
    KatanaLogger.error(PREFIX, `Job failed: ${error.message}`, error)
  } finally {
    isRunning = false
  }
}

/**
 * Start the cron job
 */
export function startVolumeSushiswapActivityCron(): void {
  KatanaLogger.info(PREFIX, 'Starting Volume Sushiswap Activity Cron Job')
  KatanaLogger.info(PREFIX, `Schedule: ${SCHEDULE_CONFIG.CRON_EXPRESSION} (every hour at minute 55)`)

  // Schedule the cron job
  cron.schedule(SCHEDULE_CONFIG.CRON_EXPRESSION, async () => {
    await runHourlyVolume()
  })

  KatanaLogger.info(PREFIX, 'Cron job scheduled successfully')

  // Run immediately on startup
  KatanaLogger.info(PREFIX, 'Running initial execution...')
  runHourlyVolume().catch(err => {
    KatanaLogger.error(PREFIX, 'Initial execution failed', err)
  })
}

/**
 * Manual trigger for backfill only
 * Can be called via API or script
 */
export async function triggerBackfill(): Promise<void> {
  if (isRunning) {
    throw new Error('Job already running')
  }

  isRunning = true

  try {
    await sequelize.authenticate()
    await runBackfill()
  } finally {
    isRunning = false
  }
}

/**
 * Manual trigger for today's catchup
 */
export async function triggerCatchup(): Promise<void> {
  if (isRunning) {
    throw new Error('Job already running')
  }

  isRunning = true

  try {
    await sequelize.authenticate()
    await catchUpTodayHours()
  } finally {
    isRunning = false
  }
}

/**
 * Manual trigger for current hour
 */
export async function triggerCurrentHour(): Promise<void> {
  if (isRunning) {
    throw new Error('Job already running')
  }

  isRunning = true

  try {
    await sequelize.authenticate()
    await processCurrentHour()
  } finally {
    isRunning = false
  }
}

/**
 * Get current volume status
 */
export async function getVolumeStatus(): Promise<{
  date: string
  targetVolume: number
  currentVolume: number
  remainingVolume: number
  hoursRemaining: number
  progress: string
}> {
  await sequelize.authenticate()
  const state = await getDailyVolumeState()

  return {
    ...state,
    progress: `${((state.currentVolume / state.targetVolume) * 100).toFixed(1)}%`,
  }
}

// Export services for external use
export {
  initialize,
  processCurrentHour,
  runBackfill,
  catchUpTodayHours,
} from './services/BackfillService'

export {
  getDailyVolumeState,
  getDailyTarget,
  setDailyTarget,
  getExistingDailyVolume,
} from './services/VolumeTracker'

/**
 * Run standalone when executed directly
 * Usage: bun run src/cron-jobs/volume-sushiswapActivity/index.ts
 */
async function main() {
  console.log('\n' + '='.repeat(70))
  console.log('   VOLUME SUSHISWAP ACTIVITY - STANDALONE MODE')
  console.log('='.repeat(70))
  console.log(`Started at: ${new Date().toISOString()}`)
  console.log()

  try {
    // Connect to database
    console.log('Connecting to database...')
    await sequelize.authenticate()
    console.log('Database connected successfully\n')

    // Start the cron job
    startVolumeSushiswapActivityCron()

    // Keep process alive
    console.log('\nCron job is running. Press Ctrl+C to stop.\n')

  } catch (error: any) {
    console.error('Failed to start:', error.message)
    process.exit(1)
  }
}

// Check if running directly via process.argv
const scriptPath = process.argv[1] || ''
const isMainModule = scriptPath.includes('volume-sushiswapActivity')

if (isMainModule) {
  main()
}
