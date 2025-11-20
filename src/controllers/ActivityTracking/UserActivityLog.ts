import type { Request, Response, NextFunction } from "express"
import {
    createActivityLog,
    bulkCreateActivityLogs,
    getActivityLogs,
    getUserActivityFeed,
    getUserVolume,
    getUserVolumeByWallet,
    getReferralVolume,
    getLeaderboard,
    getPlatformStats,
    getTokenActivityStats,
    deleteActivityLogs,
    deleteActivityLogByTxHash,
    updateActivityLogStatus,
    getActivityLogByTxHash,
    CreateActivityLogParams,
    ActivityLogFilters
} from "../../services/userActivityLog"
import User from "../../models/User"

/**
 * POST /api/activity
 * Create a new activity log entry
 */
export const addActivityLog = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const {
            userAddress,
            platform,
            actionCategory,
            actionType,
            txHash,
            chainId,
            blockNumber,
            blockTimestamp,
            usdVolume,
            poolId,
            tokenAddress,
            tokenSymbol,
            status,
            metadata,
            timestamp
        } = req.body

        // Validate required fields
        if (!userAddress || !platform || !actionCategory || !actionType || !timestamp) {
            return res.status(400).json({
                error: 'Missing required fields: userAddress, platform, actionCategory, actionType, timestamp'
            })
        }

        if (usdVolume === undefined || usdVolume === null) {
            return res.status(400).json({
                error: 'usdVolume is required'
            })
        }

        // Get or create user
        const { user } = await User.findOrCreateUser(userAddress, chainId || 747474)

        const params: CreateActivityLogParams = {
            userId: user.id,
            platform,
            actionCategory,
            actionType,
            txHash,
            chainId,
            blockNumber,
            blockTimestamp: blockTimestamp ? new Date(blockTimestamp) : null,
            usdVolume: parseFloat(usdVolume),
            poolId,
            tokenAddress,
            tokenSymbol,
            status,
            metadata,
            timestamp: new Date(timestamp)
        }

        const activityLog = await createActivityLog(params)

        return res.status(201).json({
            message: 'Activity log created successfully',
            activity: activityLog
        })

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}

/**
 * POST /api/activity/bulk
 * Create multiple activity log entries
 */
export const addBulkActivityLogs = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { activities } = req.body

        if (!Array.isArray(activities) || activities.length === 0) {
            return res.status(400).json({
                error: 'activities must be a non-empty array'
            })
        }

        // Validate each activity has required fields
        for (const activity of activities) {
            if (!activity.userAddress || !activity.platform || !activity.actionCategory ||
                !activity.actionType || !activity.timestamp) {
                return res.status(400).json({
                    error: 'Each activity must have userAddress, platform, actionCategory, actionType, and timestamp'
                })
            }
        }

        // Get or create users for all unique addresses
        const userAddressMap = new Map<string, number>()
        for (const activity of activities) {
            const normalizedAddress = activity.userAddress.toLowerCase()
            if (!userAddressMap.has(normalizedAddress)) {
                const { user } = await User.findOrCreateUser(activity.userAddress, activity.chainId || 747474)
                userAddressMap.set(normalizedAddress, user.id)
            }
        }

        // Prepare activities with userId
        const preparedActivities: CreateActivityLogParams[] = activities.map(activity => ({
            userId: userAddressMap.get(activity.userAddress.toLowerCase())!,
            platform: activity.platform,
            actionCategory: activity.actionCategory,
            actionType: activity.actionType,
            txHash: activity.txHash,
            chainId: activity.chainId,
            blockNumber: activity.blockNumber,
            blockTimestamp: activity.blockTimestamp ? new Date(activity.blockTimestamp) : null,
            usdVolume: parseFloat(activity.usdVolume || 0),
            poolId: activity.poolId,
            tokenAddress: activity.tokenAddress,
            tokenSymbol: activity.tokenSymbol,
            status: activity.status,
            metadata: activity.metadata,
            timestamp: new Date(activity.timestamp)
        }))

        const activityLogs = await bulkCreateActivityLogs(preparedActivities)

        return res.status(201).json({
            message: 'Activity logs created successfully',
            count: activityLogs.length,
            activities: activityLogs
        })

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}

/**
 * GET /api/activity
 * Get activity logs with filtering
 */
export const getActivityLogsController = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const {
            userId,
            platform,
            actionCategory,
            actionType,
            status,
            chainId,
            startDate,
            endDate,
            limit,
            offset
        } = req.query

        const filters: ActivityLogFilters = {
            userId: userId ? parseInt(userId as string) : undefined,
            platform: platform as string,
            actionCategory: actionCategory as string,
            actionType: actionType as string,
            status: status as string,
            chainId: chainId ? parseInt(chainId as string) : undefined,
            startDate: startDate ? new Date(startDate as string) : undefined,
            endDate: endDate ? new Date(endDate as string) : undefined
        }

        const limitNum = limit ? parseInt(limit as string) : 50
        const offsetNum = offset ? parseInt(offset as string) : 0

        const result = await getActivityLogs(filters, limitNum, offsetNum)

        return res.status(200).json(result)

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}

/**
 * GET /api/activity/user/:userId
 * Get user activity feed
 */
export const getUserActivityController = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.params
        const { limit, offset } = req.query

        if (!userId) {
            return res.status(400).json({ error: 'userId is required' })
        }

        const limitNum = limit ? parseInt(limit as string) : 50
        const offsetNum = offset ? parseInt(offset as string) : 0

        const result = await getUserActivityFeed(parseInt(userId), limitNum, offsetNum)

        return res.status(200).json(result)

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}

/**
 * GET /api/activity/user/:userId/volume
 * Get user total volume
 */
export const getUserVolumeController = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId } = req.params
        const { startDate, endDate } = req.query

        if (!userId) {
            return res.status(400).json({ error: 'userId is required' })
        }

        const result = await getUserVolume(
            parseInt(userId),
            startDate ? new Date(startDate as string) : undefined,
            endDate ? new Date(endDate as string) : undefined
        )

        return res.status(200).json(result)

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}

/**
 * GET /api/activity/wallet/:walletAddress/volume
 * Get user volume by wallet address
 */
export const getUserVolumeByWalletController = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { walletAddress } = req.params
        const { chainId, startDate, endDate } = req.query

        if (!walletAddress) {
            return res.status(400).json({ error: 'walletAddress is required' })
        }

        const chainIdNum = chainId ? parseInt(chainId as string) : 747474

        const result = await getUserVolumeByWallet(
            walletAddress,
            chainIdNum,
            startDate ? new Date(startDate as string) : undefined,
            endDate ? new Date(endDate as string) : undefined
        )

        return res.status(200).json(result)

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}

/**
 * GET /api/activity/referral/:referrerUserId/volume
 * Get referral volume for a referrer
 */
export const getReferralVolumeController = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { referrerUserId } = req.params
        const { startDate, endDate } = req.query

        if (!referrerUserId) {
            return res.status(400).json({ error: 'referrerUserId is required' })
        }

        const result = await getReferralVolume(
            parseInt(referrerUserId),
            startDate ? new Date(startDate as string) : undefined,
            endDate ? new Date(endDate as string) : undefined
        )

        return res.status(200).json(result)

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}

/**
 * GET /api/activity/leaderboard/:actionCategory
 * Get leaderboard by action category
 */
export const getLeaderboardController = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { actionCategory } = req.params
        const { startDate, endDate, limit } = req.query

        if (!actionCategory) {
            return res.status(400).json({ error: 'actionCategory is required' })
        }

        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'startDate and endDate are required' })
        }

        const limitNum = limit ? parseInt(limit as string) : 100

        const leaderboard = await getLeaderboard(
            actionCategory,
            new Date(startDate as string),
            new Date(endDate as string),
            limitNum
        )

        return res.status(200).json({
            actionCategory,
            startDate,
            endDate,
            leaderboard
        })

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}

/**
 * GET /api/activity/platform/:platform/stats
 * Get platform statistics
 */
export const getPlatformStatsController = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { platform } = req.params
        const { startDate, endDate } = req.query

        if (!platform) {
            return res.status(400).json({ error: 'platform is required' })
        }

        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'startDate and endDate are required' })
        }

        const stats = await getPlatformStats(
            platform,
            new Date(startDate as string),
            new Date(endDate as string)
        )

        return res.status(200).json({
            platform,
            startDate,
            endDate,
            stats
        })

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}

/**
 * GET /api/activity/token/:tokenAddress/stats
 * Get token activity statistics
 */
export const getTokenStatsController = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { tokenAddress } = req.params
        const { startDate, endDate } = req.query

        if (!tokenAddress) {
            return res.status(400).json({ error: 'tokenAddress is required' })
        }

        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'startDate and endDate are required' })
        }

        const stats = await getTokenActivityStats(
            tokenAddress,
            new Date(startDate as string),
            new Date(endDate as string)
        )

        return res.status(200).json({
            tokenAddress,
            startDate,
            endDate,
            stats
        })

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}

/**
 * GET /api/activity/tx/:txHash
 * Get activity log by transaction hash
 */
export const getActivityByTxHashController = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { txHash } = req.params
        const { chainId } = req.query

        if (!txHash) {
            return res.status(400).json({ error: 'txHash is required' })
        }

        const chainIdNum = chainId ? parseInt(chainId as string) : 747474

        const activity = await getActivityLogByTxHash(txHash, chainIdNum)

        return res.status(200).json(activity)

    } catch (error) {
        if (error instanceof Error) {
            return res.status(404).json({ error: error.message })
        }
        next(error)
    }
}

/**
 * PATCH /api/activity/tx/:txHash/status
 * Update activity log status
 */
export const updateActivityStatusController = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { txHash } = req.params
        const { chainId, status } = req.body

        if (!txHash) {
            return res.status(400).json({ error: 'txHash is required' })
        }

        if (!status) {
            return res.status(400).json({ error: 'status is required' })
        }

        const chainIdNum = chainId || 747474

        const activity = await updateActivityLogStatus(txHash, chainIdNum, status)

        return res.status(200).json({
            message: 'Activity status updated successfully',
            activity
        })

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}

/**
 * DELETE /api/activity/tx/:txHash
 * Delete activity log by transaction hash
 */
export const deleteActivityByTxHashController = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { txHash } = req.params
        const { chainId } = req.query

        if (!txHash) {
            return res.status(400).json({ error: 'txHash is required' })
        }

        const chainIdNum = chainId ? parseInt(chainId as string) : 747474

        const result = await deleteActivityLogByTxHash(txHash, chainIdNum)

        return res.status(200).json({
            message: 'Activity log deleted successfully',
            result
        })

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}

/**
 * DELETE /api/activity (Admin endpoint)
 * Delete activity logs by filters
 */
export const deleteActivityLogsController = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const {
            userId,
            platform,
            actionCategory,
            actionType,
            status,
            chainId,
            startDate,
            endDate
        } = req.body

        const filters: ActivityLogFilters = {
            userId: userId ? parseInt(userId) : undefined,
            platform,
            actionCategory,
            actionType,
            status,
            chainId: chainId ? parseInt(chainId) : undefined,
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined
        }

        const result = await deleteActivityLogs(filters)

        return res.status(200).json({
            message: 'Activity logs deleted successfully',
            result
        })

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}