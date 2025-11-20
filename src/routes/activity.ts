import { Router } from "express"
import {
    addActivityLog,
    addBulkActivityLogs,
    getActivityLogsController,
    getUserActivityController,
    getUserVolumeController,
    getUserVolumeByWalletController,
    getReferralVolumeController,
    getLeaderboardController,
    getPlatformStatsController,
    getTokenStatsController,
    getActivityByTxHashController,
    updateActivityStatusController,
    deleteActivityByTxHashController,
    deleteActivityLogsController
} from "../controllers/ActivityTracking/UserActivityLog"

const router = Router()

// Create operations
router.post("/", addActivityLog)
router.post("/bulk", addBulkActivityLogs)

// Read operations - General
router.get("/", getActivityLogsController)
router.get("/tx/:txHash", getActivityByTxHashController)

// Read operations - User specific
router.get("/user/:userId", getUserActivityController)
router.get("/user/:userId/volume", getUserVolumeController)
router.get("/wallet/:walletAddress/volume", getUserVolumeByWalletController)

// Read operations - Referral analytics
router.get("/referral/:referrerUserId/volume", getReferralVolumeController)

// Read operations - Leaderboards and stats
router.get("/leaderboard/:actionCategory", getLeaderboardController)
router.get("/platform/:platform/stats", getPlatformStatsController)
router.get("/token/:tokenAddress/stats", getTokenStatsController)

// Update operations
router.patch("/tx/:txHash/status", updateActivityStatusController)

// Delete operations
router.delete("/tx/:txHash", deleteActivityByTxHashController)
router.delete("/", deleteActivityLogsController) // Admin endpoint

export default router