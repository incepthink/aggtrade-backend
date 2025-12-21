/**
 * CRON JOBS INDEX
 * Central place to start all cron jobs
 */

import { startProactiveCandlesCron } from './updateProactiveCandlesJob'
// import { startLimitOrderBotCron, runImmediately as runLimitOrderBot } from './startLimitOrderBot'
import { startGridBotOrchestrator } from './gridBot/gridBotOrchestrator'
import { startClassicSwapBotCron, triggerClassicSwapBotManually } from './classicSwapBot'
import { startBotLogCleanupCron } from './cleanupBotLogs'

/**
 * Initialize all cron jobs
 */
export function initializeCronJobs() {
  console.log('\n[Cron Jobs] Initializing all cron jobs...\n')

  // Start proactive candles update (every 5 minutes)
  // startProactiveCandlesCron() // Already auto-starts in its file

  // Start limit order bot (every hour) - OLD, replaced by grid bot
  // startLimitOrderBotCron()

  // Start grid bot orchestrator (continuous monitoring)
  startGridBotOrchestrator()
    .then(() => {
      console.log('[Grid Bot] Orchestrator initialized successfully')
    })
    .catch((error) => {
      console.error('[Grid Bot] Failed to initialize orchestrator:', error)
    })

  // Start classic swap balance bot (every 6 hours)
  // startClassicSwapBotCron()

  // Start bot log cleanup (daily)
  startBotLogCleanupCron()

  console.log('[Cron Jobs] All cron jobs initialized successfully\n')
}

initializeCronJobs()

// Export individual cron starters
export {
  startGridBotOrchestrator,
  startClassicSwapBotCron,
  triggerClassicSwapBotManually
}