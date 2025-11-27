/**
 * CRON JOBS INDEX
 * Central place to start all cron jobs
 */

import { startProactiveCandlesCron } from './updateProactiveCandlesJob'
import { startLimitOrderBotCron, runImmediately as runLimitOrderBot } from './startLimitOrderBot'

/**
 * Initialize all cron jobs
 */
export function initializeCronJobs() {
  console.log('\n[Cron Jobs] Initializing all cron jobs...\n')

  // Start proactive candles update (every 5 minutes)
  // startProactiveCandlesCron() // Already auto-starts in its file

  // Start limit order bot (every hour)
  startLimitOrderBotCron()

  console.log('[Cron Jobs] All cron jobs initialized successfully\n')
}

/**
 * Run limit order bot immediately
 */
export async function runLimitOrderBotNow() {
  console.log('\n[Manual Trigger] Running limit order bot now...\n')
  await runLimitOrderBot()
}

// Export individual cron starters
export {
  startLimitOrderBotCron,
  runLimitOrderBot
}