import CronJobRun from '../models/CronJobRun'
import { KatanaLogger } from '../utils/logger'

export async function performStartupGapDetection() {
  const prefix = "[StartupGapDetection]"

  KatanaLogger.info(prefix, "Running gap detection on startup")

  try {
    // Check for missed runs in last 24 hours
    const missedRuns = await CronJobRun.detectMissedRuns('equity_trend_update', 24)

    if (missedRuns.length === 0) {
      KatanaLogger.info(prefix, "No gaps detected")
      return
    }

    KatanaLogger.warn(prefix, `Detected ${missedRuns.length} missed cron run(s)`, {
      missedTimes: missedRuns.map(d => d.toISOString())
    })

    // Auto-backfill only the most recent missed run (within last 8 hours)
    const now = new Date()
    const recentMissed = missedRuns.filter(
      missed => (now.getTime() - missed.getTime()) < 8 * 60 * 60 * 1000
    )

    if (recentMissed.length === 0) {
      KatanaLogger.info(prefix, "Missed runs are too old for auto-backfill (>8h), skipping")
      return
    }

    const mostRecent = recentMissed[recentMissed.length - 1]

    KatanaLogger.info(prefix, "Auto-triggering backfill for most recent missed run", {
      scheduledTime: mostRecent.toISOString()
    })

    // Trigger backfill by calling the cron function directly
    // We import this from equityTrend.ts
    const { runEquityTrendUpdate } = await import('../cron-jobs/equityTrend')
    await runEquityTrendUpdate()

    KatanaLogger.info(prefix, "Backfill completed successfully")

  } catch (error: any) {
    KatanaLogger.error(prefix, "Gap detection failed", error)
  }
}
