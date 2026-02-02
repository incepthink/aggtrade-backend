/**
 * Manual Volume Adjustment Script
 *
 * Adjusts daily volume to exactly 1% of a given amount for a specific date.
 * - If existing volume > 1% target: removes excess volume from DB
 * - If existing volume < 1% target: adds required volume to reach 1%
 *
 * Usage:
 *   bun run src/scripts/volume-sushiswapActivity/adjustVolume.ts <amount> <date>
 *
 * Amount supports shorthand notation:
 *   - k/K = thousands (e.g., 500k = 500,000)
 *   - m/M = millions (e.g., 21.76m = 21,760,000)
 *   - b/B = billions (e.g., 1.5b = 1,500,000,000)
 *
 * Examples:
 *   bun run src/scripts/volume-sushiswapActivity/adjustVolume.ts 21.76m 2026-01-22
 *   (Sets volume for 2026-01-22 to $217,600 which is 1% of $21,760,000)
 *
 *   bun run src/scripts/volume-sushiswapActivity/adjustVolume.ts 10000000 2026-01-20
 *   (Sets volume for 2026-01-20 to $100,000 which is 1% of $10,000,000)
 */

import { Op } from 'sequelize'
import sequelize from '../../utils/db/sequelize'
import SushiswapActivity from '../../models/SushiswapActivity'
import { KatanaLogger } from '../../utils/logger'
import { CHAIN_ID } from './config'
import {
  getExistingDailyVolume,
  setDailyTarget,
} from './services/VolumeTracker'
import {
  fetchPools,
  fetchSwapsForDay,
  filterNewSwaps,
  selectSwapsByVolume,
  ensureUsersExist,
  transformSwapsToActivities,
  insertActivities,
  logSwapSelection,
} from './services/SwapSelector'

const PREFIX = '[AdjustVolume]'

/**
 * Parse amount string with optional suffix (k, m, b)
 * Examples: "21.76m" -> 21760000, "500k" -> 500000, "1.5b" -> 1500000000
 */
function parseAmount(amountStr: string): number | null {
  const str = amountStr.trim().toLowerCase()

  // Check for suffix
  const suffixMatch = str.match(/^([\d.]+)([kmb])$/)

  if (suffixMatch) {
    const value = parseFloat(suffixMatch[1])
    const suffix = suffixMatch[2]

    if (isNaN(value)) return null

    const multipliers: Record<string, number> = {
      k: 1_000,
      m: 1_000_000,
      b: 1_000_000_000,
    }

    return value * multipliers[suffix]
  }

  // No suffix, parse as regular number
  const value = parseFloat(str)
  return isNaN(value) ? null : value
}

interface AdjustmentResult {
  success: boolean
  date: string
  inputAmount: number
  targetVolume: number
  existingVolume: number
  adjustment: 'add' | 'remove' | 'none'
  amountAdjusted: number
  finalVolume: number
  recordsAffected: number
  error?: string
}

/**
 * Parse and validate command line arguments
 */
function parseArgs(): { amount: number; date: string } | null {
  const args = process.argv.slice(2)

  if (args.length < 2) {
    console.log('\nUsage: bun run adjustVolume.ts <amount> <date>')
    console.log('\nArguments:')
    console.log('  amount  - Total amount (1% of this will be the target volume)')
    console.log('           Supports: k (thousands), m (millions), b (billions)')
    console.log('           Examples: 21.76m, 500k, 1.5b, 10000000')
    console.log('  date    - Date in YYYY-MM-DD format')
    console.log('\nExamples:')
    console.log('  bun run adjustVolume.ts 21.76m 2026-01-22')
    console.log('  (Sets volume for 2026-01-22 to $217,600 which is 1% of $21,760,000)')
    console.log('  bun run adjustVolume.ts 10000000 2026-01-20')
    console.log('  (Sets volume for 2026-01-20 to $100,000 which is 1% of $10,000,000)')
    return null
  }

  const amount = parseAmount(args[0])
  const date = args[1]

  // Validate amount
  if (amount === null || amount <= 0) {
    console.error('Error: Amount must be a positive number (e.g., 21.76m, 500k, 10000000)')
    return null
  }

  // Validate date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (!dateRegex.test(date)) {
    console.error('Error: Date must be in YYYY-MM-DD format')
    return null
  }

  // Validate date is valid
  const parsedDate = new Date(`${date}T00:00:00.000Z`)
  if (isNaN(parsedDate.getTime())) {
    console.error('Error: Invalid date')
    return null
  }

  return { amount, date }
}

/**
 * Remove volume from a specific date to reach target
 * Removes records starting from the largest until we reach target volume
 */
async function removeVolume(
  date: string,
  currentVolume: number,
  targetVolume: number
): Promise<{ recordsDeleted: number; volumeRemoved: number }> {
  const excessVolume = currentVolume - targetVolume

  KatanaLogger.info(PREFIX, `Need to remove $${Math.round(excessVolume).toLocaleString()} in volume`)

  const startOfDay = new Date(`${date}T00:00:00.000Z`)
  const endOfDay = new Date(`${date}T23:59:59.999Z`)

  // Get all records for this date, ordered by usd_volume descending
  // We'll remove larger transactions first to minimize record deletions
  const records = await SushiswapActivity.findAll({
    where: {
      chain_id: CHAIN_ID,
      block_timestamp: {
        [Op.gte]: startOfDay,
        [Op.lte]: endOfDay,
      },
    },
    order: [['usd_volume', 'DESC']],
    raw: true,
  })

  if (records.length === 0) {
    KatanaLogger.warn(PREFIX, 'No records found to remove')
    return { recordsDeleted: 0, volumeRemoved: 0 }
  }

  // Select records to delete until we've removed enough volume
  const recordsToDelete: number[] = []
  let volumeToRemove = excessVolume
  let volumeRemoved = 0

  for (const record of records) {
    if (volumeToRemove <= 0) break

    const recordVolume = parseFloat(String((record as any).usd_volume))

    // If this single record would remove too much, try smaller records
    if (recordVolume > volumeToRemove * 1.5 && recordsToDelete.length === 0) {
      continue
    }

    recordsToDelete.push((record as any).id)
    volumeRemoved += recordVolume
    volumeToRemove -= recordVolume
  }

  // If we couldn't find appropriate records, just delete the smallest ones
  if (recordsToDelete.length === 0 && volumeToRemove > 0) {
    const smallestRecords = [...records].sort(
      (a: any, b: any) => parseFloat(String(a.usd_volume)) - parseFloat(String(b.usd_volume))
    )

    for (const record of smallestRecords) {
      if (volumeToRemove <= 0) break

      const recordVolume = parseFloat(String((record as any).usd_volume))
      recordsToDelete.push((record as any).id)
      volumeRemoved += recordVolume
      volumeToRemove -= recordVolume
    }
  }

  if (recordsToDelete.length === 0) {
    KatanaLogger.warn(PREFIX, 'Could not find suitable records to delete')
    return { recordsDeleted: 0, volumeRemoved: 0 }
  }

  // Delete the selected records
  KatanaLogger.info(PREFIX, `Deleting ${recordsToDelete.length} records...`)

  const deleted = await SushiswapActivity.destroy({
    where: {
      id: { [Op.in]: recordsToDelete },
    },
  })

  KatanaLogger.info(
    PREFIX,
    `Deleted ${deleted} records, removed $${Math.round(volumeRemoved).toLocaleString()} in volume`
  )

  return { recordsDeleted: deleted, volumeRemoved }
}

/**
 * Add volume to a specific date to reach target
 */
async function addVolume(
  date: string,
  currentVolume: number,
  targetVolume: number
): Promise<{ recordsAdded: number; volumeAdded: number }> {
  const volumeNeeded = targetVolume - currentVolume

  KatanaLogger.info(PREFIX, `Need to add $${Math.round(volumeNeeded).toLocaleString()} in volume`)

  // Fetch pools
  await fetchPools(true)

  // Fetch swaps for the day
  KatanaLogger.info(PREFIX, `Fetching swaps for ${date}...`)
  const allSwaps = await fetchSwapsForDay(date)

  if (allSwaps.length === 0) {
    KatanaLogger.warn(PREFIX, `No swaps available for ${date}`)
    return { recordsAdded: 0, volumeAdded: 0 }
  }

  // Filter out existing swaps
  const newSwaps = await filterNewSwaps(allSwaps)
  KatanaLogger.info(PREFIX, `Available: ${allSwaps.length} swaps, New: ${newSwaps.length} swaps`)

  if (newSwaps.length === 0) {
    KatanaLogger.warn(PREFIX, `All swaps already exist for ${date}`)
    return { recordsAdded: 0, volumeAdded: 0 }
  }

  // Select swaps based on volume needed
  const selection = selectSwapsByVolume(newSwaps, volumeNeeded)
  logSwapSelection(selection, volumeNeeded)

  if (selection.totalVolume === 0) {
    KatanaLogger.warn(PREFIX, 'Could not select swaps matching volume target')
    return { recordsAdded: 0, volumeAdded: 0 }
  }

  // Ensure users exist
  const allSelectedSwaps = [...selection.classicSwaps, ...selection.limitOrderSwaps]
  const userCache = await ensureUsersExist(allSelectedSwaps)

  // Transform and insert
  const activities = await transformSwapsToActivities(selection, userCache)
  const insertedCount = await insertActivities(activities)

  KatanaLogger.info(
    PREFIX,
    `Added ${insertedCount} records, +$${Math.round(selection.totalVolume).toLocaleString()} in volume`
  )

  return { recordsAdded: insertedCount, volumeAdded: selection.totalVolume }
}

/**
 * Main adjustment function
 */
async function adjustVolume(amount: number, date: string): Promise<AdjustmentResult> {
  // Calculate 1% target
  const targetVolume = amount * 0.01

  KatanaLogger.info(PREFIX, '\n' + '='.repeat(70))
  KatanaLogger.info(PREFIX, '   MANUAL VOLUME ADJUSTMENT')
  KatanaLogger.info(PREFIX, '='.repeat(70))
  KatanaLogger.info(PREFIX, `Date: ${date}`)
  KatanaLogger.info(PREFIX, `Input Amount: $${amount.toLocaleString()}`)
  KatanaLogger.info(PREFIX, `Target Volume (1%): $${targetVolume.toLocaleString()}`)

  try {
    // Get existing volume
    const existingVolume = await getExistingDailyVolume(date)
    KatanaLogger.info(PREFIX, `Existing Volume: $${Math.round(existingVolume).toLocaleString()}`)

    // Set the daily target in cache (for consistency with other services)
    setDailyTarget(date, targetVolume)

    // Determine adjustment needed
    const difference = targetVolume - existingVolume
    const tolerancePercent = 0.02 // 2% tolerance
    const tolerance = targetVolume * tolerancePercent

    let result: AdjustmentResult = {
      success: true,
      date,
      inputAmount: amount,
      targetVolume,
      existingVolume,
      adjustment: 'none',
      amountAdjusted: 0,
      finalVolume: existingVolume,
      recordsAffected: 0,
    }

    if (Math.abs(difference) <= tolerance) {
      // Within tolerance, no adjustment needed
      KatanaLogger.info(
        PREFIX,
        `Volume is within ${tolerancePercent * 100}% tolerance, no adjustment needed`
      )
      result.adjustment = 'none'
    } else if (difference > 0) {
      // Need to add volume
      KatanaLogger.info(PREFIX, `\nAdjustment: ADDING volume`)
      const { recordsAdded, volumeAdded } = await addVolume(date, existingVolume, targetVolume)
      result.adjustment = 'add'
      result.amountAdjusted = volumeAdded
      result.recordsAffected = recordsAdded
      result.finalVolume = existingVolume + volumeAdded
    } else {
      // Need to remove volume
      KatanaLogger.info(PREFIX, `\nAdjustment: REMOVING volume`)
      const { recordsDeleted, volumeRemoved } = await removeVolume(date, existingVolume, targetVolume)
      result.adjustment = 'remove'
      result.amountAdjusted = volumeRemoved
      result.recordsAffected = recordsDeleted
      result.finalVolume = existingVolume - volumeRemoved
    }

    // Get final volume from DB
    result.finalVolume = await getExistingDailyVolume(date)

    // Log summary
    KatanaLogger.info(PREFIX, '\n' + '='.repeat(70))
    KatanaLogger.info(PREFIX, '   ADJUSTMENT COMPLETE')
    KatanaLogger.info(PREFIX, '='.repeat(70))
    KatanaLogger.info(PREFIX, `Target Volume: $${targetVolume.toLocaleString()}`)
    KatanaLogger.info(PREFIX, `Final Volume: $${Math.round(result.finalVolume).toLocaleString()}`)
    KatanaLogger.info(
      PREFIX,
      `Difference: $${Math.round(result.finalVolume - targetVolume).toLocaleString()} (${(((result.finalVolume - targetVolume) / targetVolume) * 100).toFixed(2)}%)`
    )
    KatanaLogger.info(PREFIX, `Records Affected: ${result.recordsAffected}`)

    return result
  } catch (error: any) {
    KatanaLogger.error(PREFIX, `Adjustment failed: ${error.message}`, error)
    return {
      success: false,
      date,
      inputAmount: amount,
      targetVolume,
      existingVolume: 0,
      adjustment: 'none',
      amountAdjusted: 0,
      finalVolume: 0,
      recordsAffected: 0,
      error: error.message,
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  console.log('\n' + '='.repeat(70))
  console.log('   VOLUME ADJUSTMENT SCRIPT')
  console.log('='.repeat(70))
  console.log(`Started at: ${new Date().toISOString()}`)
  console.log()

  const args = parseArgs()
  if (!args) {
    process.exit(1)
  }

  try {
    // Connect to database
    console.log('Connecting to database...')
    await sequelize.authenticate()
    console.log('Database connected successfully\n')

    // Run adjustment
    const result = await adjustVolume(args.amount, args.date)

    if (result.success) {
      console.log('\nAdjustment completed successfully!')
      console.log(JSON.stringify(result, null, 2))
      process.exit(0)
    } else {
      console.error('\nAdjustment failed:', result.error)
      process.exit(1)
    }
  } catch (error: any) {
    console.error('Fatal error:', error.message)
    process.exit(1)
  }
}

// Export for programmatic use
export { adjustVolume, AdjustmentResult }

// Run if executed directly
const scriptPath = process.argv[1] || ''
const isMainModule = scriptPath.includes('adjustVolume')

if (isMainModule) {
  main()
}
