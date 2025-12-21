import { Op } from 'sequelize'
import BotErrorLogs from '../models/BotErrorLogs'
import BotWalletMetrics from '../models/BotWalletMetrics'
import { KatanaLogger } from '../utils/logger'

const PREFIX = '[BotLogCleanup]'

export async function cleanupBotLogs(): Promise<void> {
  // Delete errors older than 30 days
  const errorCutoff = new Date()
  errorCutoff.setDate(errorCutoff.getDate() - 30)

  const deletedErrors = await BotErrorLogs.destroy({
    where: { created_at: { [Op.lt]: errorCutoff } }
  })

  if (deletedErrors > 0) {
    KatanaLogger.info(PREFIX, `Deleted ${deletedErrors} old error logs`)
  }

  // Delete metrics older than 365 days
  const metricsCutoff = new Date()
  metricsCutoff.setDate(metricsCutoff.getDate() - 365)

  const deletedMetrics = await BotWalletMetrics.destroy({
    where: { date: { [Op.lt]: metricsCutoff.toISOString().split('T')[0] } }
  })

  if (deletedMetrics > 0) {
    KatanaLogger.info(PREFIX, `Deleted ${deletedMetrics} old metrics`)
  }
}

export function startBotLogCleanupCron(): void {
  const runDaily = async () => {
    try {
      await cleanupBotLogs()
    } catch (error) {
      KatanaLogger.error(PREFIX, 'Cleanup failed', error)
    }

    // Run again in 24 hours
    setTimeout(runDaily, 24 * 60 * 60 * 1000)
  }

  KatanaLogger.info(PREFIX, 'Started bot log cleanup cron (daily)')
  runDaily()
}
