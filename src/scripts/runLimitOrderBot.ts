/**
 * CLI Script to run Limit Order Bot
 *
 * Usage:
 *   bun run src/scripts/runLimitOrderBot.ts
 *   or
 *   npm run bot:limit-order
 */

import 'dotenv/config'
import { runImmediately } from '../cron-jobs/startLimitOrderBot'
import sequelize from '../utils/db/sequelize'

async function main() {
  console.log('\n╔' + '═'.repeat(78) + '╗')
  console.log('║' + ' '.repeat(25) + 'LIMIT ORDER BOT CLI' + ' '.repeat(34) + '║')
  console.log('╚' + '═'.repeat(78) + '╝\n')

  try {
    // Connect to database
    console.log('[Database] Connecting to MySQL...')
    await sequelize.authenticate()
    console.log('[Database] ✓ Connected successfully\n')

    // Run the bot
    await runImmediately()

    console.log('\n[Success] ✓ All operations completed successfully')
    process.exit(0)

  } catch (error: any) {
    console.error('\n[Error] ✗ Bot failed:', error.message)
    console.error(error)
    process.exit(1)
  }
}

main()