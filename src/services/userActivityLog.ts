// src/services/userActivityLog.ts
import UserActivityLog from "../models/UserActivityLog"
import User from "../models/User"
import { Referral } from "../models"
import { Op } from "sequelize"

export interface CreateActivityLogParams {
    userId: number
    platform: string
    actionCategory: string
    actionType: string
    txHash?: string | null
    chainId?: number
    blockNumber?: number | null
    blockTimestamp?: Date | null
    usdVolume: number
    poolId?: string | null
    tokenAddress?: string | null
    tokenSymbol?: string | null
    status?: string
    metadata?: any
    timestamp: Date
}

export interface ActivityLogFilters {
    userId?: number
    platform?: string
    actionCategory?: string
    actionType?: string
    status?: string
    chainId?: number
    startDate?: Date
    endDate?: Date
}

/**
 * Create a new activity log entry
 */
export const createActivityLog = async (params: CreateActivityLogParams) => {
    // Validate user exists
    const user = await User.findByPk(params.userId)
    if (!user) {
        throw new Error(`User with ID ${params.userId} not found`)
    }

    // Normalize token address if provided
    const normalizedTokenAddress = params.tokenAddress
        ? params.tokenAddress.toLowerCase()
        : null

    // Check for duplicate transaction
    if (params.txHash) {
        const existing = await UserActivityLog.transactionExists(
            params.txHash,
            params.chainId || 747474
        )
        if (existing) {
            throw new Error(`Transaction ${params.txHash} already logged`)
        }
    }

    // Create activity log
    const activityLog = await UserActivityLog.create({
        user_id: params.userId,
        platform: params.platform,
        action_category: params.actionCategory,
        action_type: params.actionType,
        tx_hash: params.txHash || null,
        chain_id: params.chainId || 747474,
        block_number: params.blockNumber || null,
        block_timestamp: params.blockTimestamp || null,
        usd_volume: params.usdVolume,
        pool_id: params.poolId || null,
        token_address: normalizedTokenAddress,
        token_symbol: params.tokenSymbol || null,
        status: params.status || 'success',
        metadata: params.metadata || null,
        timestamp: params.timestamp
    })

    return activityLog
}

/**
 * Bulk create activity logs (for batch processing)
 */
export const bulkCreateActivityLogs = async (activities: CreateActivityLogParams[]) => {
    // Validate all users exist
    const userIds = [...new Set(activities.map(a => a.userId))]
    const users = await User.findAll({
        where: {
            id: {
                [Op.in]: userIds
            }
        }
    })

    if (users.length !== userIds.length) {
        throw new Error('One or more user IDs are invalid')
    }

    // Normalize and prepare data
    const preparedActivities = activities.map(params => ({
        user_id: params.userId,
        platform: params.platform,
        action_category: params.actionCategory,
        action_type: params.actionType,
        tx_hash: params.txHash || null,
        chain_id: params.chainId || 747474,
        block_number: params.blockNumber || null,
        block_timestamp: params.blockTimestamp || null,
        usd_volume: params.usdVolume,
        pool_id: params.poolId || null,
        token_address: params.tokenAddress ? params.tokenAddress.toLowerCase() : null,
        token_symbol: params.tokenSymbol || null,
        status: params.status || 'success',
        metadata: params.metadata || null,
        timestamp: params.timestamp
    }))

    // Bulk insert
    const activityLogs = await UserActivityLog.bulkCreate(preparedActivities, {
        ignoreDuplicates: true // Skip duplicates based on unique tx_hash
    })

    return activityLogs
}

/**
 * Get activity logs with filtering
 */
export const getActivityLogs = async (
    filters: ActivityLogFilters,
    limit: number = 50,
    offset: number = 0
) => {
    const whereClause: any = {}

    if (filters.userId) whereClause.user_id = filters.userId
    if (filters.platform) whereClause.platform = filters.platform
    if (filters.actionCategory) whereClause.action_category = filters.actionCategory
    if (filters.actionType) whereClause.action_type = filters.actionType
    if (filters.status) whereClause.status = filters.status
    if (filters.chainId) whereClause.chain_id = filters.chainId

    if (filters.startDate && filters.endDate) {
        whereClause.timestamp = {
            [Op.between]: [filters.startDate, filters.endDate]
        }
    } else if (filters.startDate) {
        whereClause.timestamp = {
            [Op.gte]: filters.startDate
        }
    } else if (filters.endDate) {
        whereClause.timestamp = {
            [Op.lte]: filters.endDate
        }
    }

    const activities = await UserActivityLog.findAll({
        where: whereClause,
        order: [['timestamp', 'DESC']],
        limit,
        offset
    })

    const total = await UserActivityLog.count({ where: whereClause })

    return {
        activities,
        total,
        limit,
        offset
    }
}

/**
 * Get user activity feed
 */
export const getUserActivityFeed = async (
    userId: number,
    limit: number = 50,
    offset: number = 0
) => {
    const user = await User.findByPk(userId)
    if (!user) {
        throw new Error(`User with ID ${userId} not found`)
    }

    const activities = await UserActivityLog.getUserActivity(userId, limit, offset)
    const total = await UserActivityLog.count({ where: { user_id: userId } })

    return {
        activities,
        total,
        limit,
        offset
    }
}

/**
 * Get user total volume
 */
export const getUserVolume = async (
    userId: number,
    startDate?: Date,
    endDate?: Date
) => {
    const user = await User.findByPk(userId)
    if (!user) {
        throw new Error(`User with ID ${userId} not found`)
    }

    const totalVolume = await UserActivityLog.getUserTotalVolume(
        userId,
        startDate,
        endDate
    )

    return {
        userId,
        walletAddress: user.wallet_address,
        totalVolume: parseFloat(totalVolume) || 0,
        startDate: startDate || null,
        endDate: endDate || null
    }
}

/**
 * Get user volume by wallet address
 */
export const getUserVolumeByWallet = async (
    walletAddress: string,
    chainId: number = 747474,
    startDate?: Date,
    endDate?: Date
) => {
    const user = await User.findByWallet(walletAddress, chainId)
    if (!user) {
        throw new Error(`User with wallet ${walletAddress} not found`)
    }

    return getUserVolume(user.id, startDate, endDate)
}

/**
 * Get referral volume (volume generated by referred users)
 */
export const getReferralVolume = async (
    referrerUserId: number,
    startDate?: Date,
    endDate?: Date
) => {
    const user = await User.findByPk(referrerUserId)
    if (!user) {
        throw new Error(`User with ID ${referrerUserId} not found`)
    }

    // Get all users referred by this user
    const referrals = await Referral.findAll({
        where: {
            referrer_user_id: referrerUserId,
            is_active: true
        }
    })

    if (referrals.length === 0) {
        return {
            referrerUserId,
            totalReferralVolume: 0,
            referralCount: 0,
            referrals: []
        }
    }

    const referredUserIds = referrals.map(r => r.referred_user_id)

    // Get activity logs for all referred users
    const whereClause: any = {
        user_id: {
            [Op.in]: referredUserIds
        },
        status: 'success'
    }

    if (startDate && endDate) {
        whereClause.timestamp = {
            [Op.between]: [startDate, endDate]
        }
    }

    const activities = await UserActivityLog.findAll({
        attributes: [
            'user_id',
            [UserActivityLog.sequelize!.fn('SUM', UserActivityLog.sequelize!.col('usd_volume')), 'total_volume']
        ],
        where: whereClause,
        group: ['user_id'],
        raw: true
    })

    // Calculate total and per-user volumes
    let totalReferralVolume = 0
    const referralVolumes = activities.map((activity: any) => {
        const volume = parseFloat(activity.total_volume) || 0
        totalReferralVolume += volume
        return {
            userId: activity.user_id,
            volume
        }
    })

    return {
        referrerUserId,
        totalReferralVolume,
        referralCount: referrals.length,
        referrals: referralVolumes,
        startDate: startDate || null,
        endDate: endDate || null
    }
}

/**
 * Get leaderboard by action category
 */
export const getLeaderboard = async (
    actionCategory: string,
    startDate: Date,
    endDate: Date,
    limit: number = 100
) => {
    const leaderboard = await UserActivityLog.getLeaderboard(
        actionCategory,
        startDate,
        endDate,
        limit
    )

    // Enrich with user wallet addresses
    const enrichedLeaderboard = await Promise.all(
        leaderboard.map(async (entry: any) => {
            const user = await User.findByPk(entry.user_id)
            return {
                userId: entry.user_id,
                walletAddress: user?.wallet_address || 'Unknown',
                totalVolume: parseFloat(entry.total_volume) || 0
            }
        })
    )

    return enrichedLeaderboard
}

/**
 * Get platform statistics
 */
export const getPlatformStats = async (
    platform: string,
    startDate: Date,
    endDate: Date
) => {
    const stats = await UserActivityLog.getPlatformStats(platform, startDate, endDate)

    return stats.map((stat: any) => ({
        actionType: stat.action_type,
        transactionCount: parseInt(stat.tx_count) || 0,
        totalVolume: parseFloat(stat.total_volume) || 0
    }))
}

/**
 * Get token activity statistics
 */
export const getTokenActivityStats = async (
    tokenAddress: string,
    startDate: Date,
    endDate: Date
) => {
    const normalizedAddress = tokenAddress.toLowerCase()
    const stats = await UserActivityLog.getTokenActivity(
        normalizedAddress,
        startDate,
        endDate
    )

    if (!stats || stats.length === 0) {
        return {
            tokenAddress: normalizedAddress,
            swapCount: 0,
            averageVolume: 0,
            totalVolume: 0
        }
    }

    const stat = stats[0] as any
    return {
        tokenAddress: normalizedAddress,
        swapCount: parseInt(stat.swap_count) || 0,
        averageVolume: parseFloat(stat.avg_volume) || 0,
        totalVolume: parseFloat(stat.total_volume) || 0
    }
}

/**
 * Delete activity logs by filters (admin function)
 */
export const deleteActivityLogs = async (filters: ActivityLogFilters) => {
    const whereClause: any = {}

    if (filters.userId) whereClause.user_id = filters.userId
    if (filters.platform) whereClause.platform = filters.platform
    if (filters.actionCategory) whereClause.action_category = filters.actionCategory
    if (filters.actionType) whereClause.action_type = filters.actionType
    if (filters.status) whereClause.status = filters.status
    if (filters.chainId) whereClause.chain_id = filters.chainId

    if (filters.startDate && filters.endDate) {
        whereClause.timestamp = {
            [Op.between]: [filters.startDate, filters.endDate]
        }
    }

    // Safety check - prevent deleting all records
    if (Object.keys(whereClause).length === 0) {
        throw new Error('Must provide at least one filter to delete activity logs')
    }

    const count = await UserActivityLog.destroy({
        where: whereClause
    })

    return {
        deleted: count
    }
}

/**
 * Delete activity log by transaction hash
 */
export const deleteActivityLogByTxHash = async (txHash: string, chainId: number = 747474) => {
    const activity = await UserActivityLog.findOne({
        where: {
            tx_hash: txHash,
            chain_id: chainId
        }
    })

    if (!activity) {
        throw new Error(`Activity log with transaction ${txHash} not found`)
    }

    await activity.destroy()

    return {
        deleted: true,
        txHash,
        chainId
    }
}

/**
 * Update activity log status (e.g., pending -> success/failed)
 */
export const updateActivityLogStatus = async (
    txHash: string,
    chainId: number,
    newStatus: string
) => {
    const activity = await UserActivityLog.findOne({
        where: {
            tx_hash: txHash,
            chain_id: chainId
        }
    })

    if (!activity) {
        throw new Error(`Activity log with transaction ${txHash} not found`)
    }

    activity.status = newStatus
    await activity.save()

    return activity
}

/**
 * Get activity log by transaction hash
 */
export const getActivityLogByTxHash = async (txHash: string, chainId: number = 747474) => {
    const activity = await UserActivityLog.findOne({
        where: {
            tx_hash: txHash,
            chain_id: chainId
        }
    })

    if (!activity) {
        throw new Error(`Activity log with transaction ${txHash} not found`)
    }

    return activity
}