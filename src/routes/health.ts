import express from 'express'
import CronJobRun from '../models/CronJobRun'
import FailedBalanceQueue from '../models/FailedBalanceQueue'

const router = express.Router()

// GET /health/equity-trend
router.get('/equity-trend', async (req, res) => {
  try {
    const lastRun = await CronJobRun.getLastRun('equity_trend_update')
    const queueStats = await FailedBalanceQueue.getQueueStats()

    // Calculate next scheduled run (0, 4, 8, 12, 16, 20)
    const now = new Date()
    const currentHour = now.getHours()
    const nextHour = Math.ceil(currentHour / 4) * 4
    const nextRun = new Date(now)

    if (nextHour >= 24) {
      nextRun.setDate(nextRun.getDate() + 1)
      nextRun.setHours(0, 0, 0, 0)
    } else {
      nextRun.setHours(nextHour, 0, 0, 0)
    }

    // Determine health status
    const isHealthy = lastRun &&
                     lastRun.status === 'completed' &&
                     (now.getTime() - new Date(lastRun.completed_at || lastRun.started_at).getTime()) < 5 * 60 * 60 * 1000 // Last run within 5 hours

    const response = {
      status: isHealthy ? 'healthy' : 'degraded',
      operational: isHealthy,
      lastRun: lastRun ? {
        scheduledTime: lastRun.scheduled_time,
        completedAt: lastRun.completed_at,
        status: lastRun.status,
        totalUsers: lastRun.total_users,
        successfulUsers: lastRun.successful_users,
        failedUsers: lastRun.failed_users,
        successRate: lastRun.total_users > 0
          ? `${((lastRun.successful_users / lastRun.total_users) * 100).toFixed(1)}%`
          : 'N/A'
      } : null,
      nextScheduledRun: nextRun.toISOString(),
      retryQueue: queueStats,
      timestamp: new Date().toISOString()
    }

    res.json(response)
  } catch (error: any) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch health status',
      error: error.message
    })
  }
})

export default router
