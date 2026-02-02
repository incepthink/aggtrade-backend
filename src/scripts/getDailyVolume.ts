/**
 * Get Daily Volume Script
 *
 * Queries the database and logs the total USD volume for each day.
 *
 * Usage:
 *   bun run src/scripts/getDailyVolume.ts [startDate] [endDate]
 *
 * Examples:
 *   bun run src/scripts/getDailyVolume.ts                     # All time
 *   bun run src/scripts/getDailyVolume.ts 2026-01-01          # From date to now
 *   bun run src/scripts/getDailyVolume.ts 2026-01-01 2026-01-31  # Date range
 */

import { Op, fn, col, literal } from 'sequelize'
import sequelize from '../utils/db/sequelize'
import SushiswapActivity from '../models/SushiswapActivity'

const CHAIN_ID = 747474 // Katana/Ronin

interface DailyVolume {
  date: string
  volume: number
  swapCount: number
}

/**
 * Parse command line arguments
 */
function parseArgs(): { startDate?: string; endDate?: string } {
  const args = process.argv.slice(2)

  let startDate: string | undefined
  let endDate: string | undefined

  if (args[0]) {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if (!dateRegex.test(args[0])) {
      console.error('Error: Start date must be in YYYY-MM-DD format')
      process.exit(1)
    }
    startDate = args[0]
  }

  if (args[1]) {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if (!dateRegex.test(args[1])) {
      console.error('Error: End date must be in YYYY-MM-DD format')
      process.exit(1)
    }
    endDate = args[1]
  }

  return { startDate, endDate }
}

/**
 * Get daily volumes from the database
 */
async function getDailyVolumes(startDate?: string, endDate?: string): Promise<DailyVolume[]> {
  const whereClause: any = {
    chain_id: CHAIN_ID,
    block_timestamp: {
      [Op.ne]: null,
    },
  }

  if (startDate || endDate) {
    if (startDate) {
      whereClause.block_timestamp[Op.gte] = new Date(`${startDate}T00:00:00.000Z`)
    }
    if (endDate) {
      whereClause.block_timestamp[Op.lte] = new Date(`${endDate}T23:59:59.999Z`)
    }
  }

  const results = await SushiswapActivity.findAll({
    attributes: [
      [fn('DATE', col('block_timestamp')), 'date'],
      [fn('SUM', col('usd_volume')), 'volume'],
      [fn('COUNT', col('id')), 'swapCount'],
    ],
    where: whereClause,
    group: [fn('DATE', col('block_timestamp'))],
    order: [[fn('DATE', col('block_timestamp')), 'ASC']],
    raw: true,
  })

  return results
    .filter((r: any) => r.date != null)
    .map((r: any) => {
      // MySQL may return date as Date object or string
      let dateStr: string
      if (r.date instanceof Date) {
        dateStr = r.date.toISOString().split('T')[0]
      } else {
        dateStr = String(r.date)
      }

      return {
        date: dateStr,
        volume: parseFloat(r.volume) || 0,
        swapCount: parseInt(r.swapCount) || 0,
      }
    })
}

/**
 * Format number as currency
 */
function formatCurrency(amount: number): string {
  return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Main function
 */
async function main() {
  console.log('\n' + '='.repeat(70))
  console.log('   DAILY VOLUME REPORT')
  console.log('='.repeat(70))

  const { startDate, endDate } = parseArgs()

  try {
    // Connect to database
    console.log('\nConnecting to database...')
    await sequelize.authenticate()
    console.log('Database connected successfully\n')

    // Get daily volumes
    const volumes = await getDailyVolumes(startDate, endDate)

    if (volumes.length === 0) {
      console.log('No volume data found for the specified period.')
      process.exit(0)
    }

    // Print header
    console.log('-'.repeat(70))
    console.log(
      'Date'.padEnd(15) +
      'Volume'.padStart(20) +
      'Swaps'.padStart(15) +
      'Avg/Swap'.padStart(20)
    )
    console.log('-'.repeat(70))

    // Print each day
    let totalVolume = 0
    let totalSwaps = 0

    for (const day of volumes) {
      const avgPerSwap = day.swapCount > 0 ? day.volume / day.swapCount : 0

      console.log(
        day.date.padEnd(15) +
        formatCurrency(day.volume).padStart(20) +
        day.swapCount.toLocaleString().padStart(15) +
        formatCurrency(avgPerSwap).padStart(20)
      )

      totalVolume += day.volume
      totalSwaps += day.swapCount
    }

    // Print totals
    console.log('-'.repeat(70))
    const avgPerSwapTotal = totalSwaps > 0 ? totalVolume / totalSwaps : 0
    console.log(
      'TOTAL'.padEnd(15) +
      formatCurrency(totalVolume).padStart(20) +
      totalSwaps.toLocaleString().padStart(15) +
      formatCurrency(avgPerSwapTotal).padStart(20)
    )
    console.log('-'.repeat(70))

    // Print summary
    console.log(`\nSummary:`)
    console.log(`  Days with data: ${volumes.length}`)
    console.log(`  Total Volume: ${formatCurrency(totalVolume)}`)
    console.log(`  Total Swaps: ${totalSwaps.toLocaleString()}`)
    console.log(`  Average Daily Volume: ${formatCurrency(totalVolume / volumes.length)}`)
    console.log(`  Average Swaps/Day: ${Math.round(totalSwaps / volumes.length).toLocaleString()}`)
    console.log()

    process.exit(0)
  } catch (error: any) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

main()
