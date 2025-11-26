import type { Request, Response, NextFunction } from "express"
import SushiswapActivity from "../../models/SushiswapActivity"
import { Op } from "sequelize"

/**
 * GET /tracking/sushiswap/dashboard
 * Unified dashboard endpoint with filtering for all swap types
 */
export const getDashboardData = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      swap_type,
      wallet_address,
      start_date,
      end_date,
      token_address,
      status = 'success',
      sort_by = 'timestamp',
      sort_order = 'DESC',
      limit = 50,
      offset = 0
    } = req.query

    // Build where clause
    const whereClause: any = {}

    if (swap_type) {
      whereClause.swap_type = swap_type
    }

    if (wallet_address) {
      whereClause.wallet_address = (wallet_address as string).toLowerCase()
    }

    if (start_date && end_date) {
      whereClause.timestamp = {
        [Op.between]: [new Date(start_date as string), new Date(end_date as string)]
      }
    }

    if (token_address) {
      const normalizedToken = (token_address as string).toLowerCase()
      whereClause[Op.or] = [
        { token_from_address: normalizedToken },
        { token_to_address: normalizedToken }
      ]
    }

    if (status) {
      whereClause.status = status
    }

    // Get swaps with filtering and sorting
    const swaps = await SushiswapActivity.findAll({
      where: whereClause,
      order: [[sort_by as string, sort_order as string]],
      limit: Number(limit),
      offset: Number(offset)
    })

    // Get aggregated statistics
    const stats = await SushiswapActivity.findOne({
      attributes: [
        [SushiswapActivity.sequelize!.fn('COUNT', SushiswapActivity.sequelize!.col('id')), 'total_swaps'],
        [SushiswapActivity.sequelize!.fn('SUM', SushiswapActivity.sequelize!.col('usd_volume')), 'total_volume_usd'],
        [SushiswapActivity.sequelize!.fn('COUNT', SushiswapActivity.sequelize!.literal("CASE WHEN swap_type = 'CLASSIC' THEN 1 END")), 'classic_count'],
        [SushiswapActivity.sequelize!.fn('COUNT', SushiswapActivity.sequelize!.literal("CASE WHEN swap_type = 'LIMIT_ORDER' THEN 1 END")), 'limit_order_count'],
        [SushiswapActivity.sequelize!.fn('SUM', SushiswapActivity.sequelize!.literal("CASE WHEN swap_type = 'CLASSIC' THEN usd_volume ELSE 0 END")), 'classic_volume'],
        [SushiswapActivity.sequelize!.fn('SUM', SushiswapActivity.sequelize!.literal("CASE WHEN swap_type = 'LIMIT_ORDER' THEN usd_volume ELSE 0 END")), 'limit_order_volume']
      ],
      where: whereClause,
      raw: true
    })

    // Get unique wallets count
    const uniqueWallets = await SushiswapActivity.findAll({
      attributes: [[SushiswapActivity.sequelize!.fn('DISTINCT', SushiswapActivity.sequelize!.col('wallet_address')), 'wallet']],
      where: whereClause,
      raw: true
    })

    return res.status(200).json({
      swaps,
      statistics: {
        total_swaps: (stats as any)?.total_swaps || 0,
        total_volume_usd: parseFloat((stats as any)?.total_volume_usd || 0),
        classic_swaps: (stats as any)?.classic_count || 0,
        classic_volume_usd: parseFloat((stats as any)?.classic_volume || 0),
        limit_order_swaps: (stats as any)?.limit_order_count || 0,
        limit_order_volume_usd: parseFloat((stats as any)?.limit_order_volume || 0),
        unique_wallets: uniqueWallets.length
      },
      pagination: {
        limit: Number(limit),
        offset: Number(offset),
        returned: swaps.length
      }
    })

  } catch (error) {
    next(error)
  }
}

/**
 * GET /tracking/sushiswap/dashboard/volume-over-time
 * Volume aggregated by time periods
 */
export const getVolumeOverTime = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      swap_type,
      wallet_address,
      start_date,
      end_date,
      interval = 'day' // day, hour, week
    } = req.query

    // Build where clause
    const whereClause: any = {
      status: 'success'
    }

    if (swap_type) {
      whereClause.swap_type = swap_type
    }

    if (wallet_address) {
      whereClause.wallet_address = (wallet_address as string).toLowerCase()
    }

    if (start_date && end_date) {
      whereClause.timestamp = {
        [Op.between]: [new Date(start_date as string), new Date(end_date as string)]
      }
    }

    // Determine date truncation based on interval
    let dateFormat: string
    switch (interval) {
      case 'hour':
        dateFormat = '%Y-%m-%d %H:00:00'
        break
      case 'week':
        dateFormat = '%Y-%U'
        break
      case 'day':
      default:
        dateFormat = '%Y-%m-%d'
        break
    }

    const volumeData = await SushiswapActivity.findAll({
      attributes: [
        [SushiswapActivity.sequelize!.fn('DATE_FORMAT', SushiswapActivity.sequelize!.col('timestamp'), dateFormat), 'period'],
        [SushiswapActivity.sequelize!.fn('SUM', SushiswapActivity.sequelize!.col('usd_volume')), 'volume'],
        [SushiswapActivity.sequelize!.fn('COUNT', SushiswapActivity.sequelize!.col('id')), 'swap_count']
      ],
      where: whereClause,
      group: ['period'],
      order: [[SushiswapActivity.sequelize!.literal('period'), 'ASC']],
      raw: true
    })

    return res.status(200).json({
      interval,
      data: volumeData
    })

  } catch (error) {
    next(error)
  }
}

/**
 * GET /tracking/sushiswap/dashboard/top-tokens
 * Most traded tokens by volume
 */
export const getTopTokens = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      swap_type,
      start_date,
      end_date,
      limit = 10
    } = req.query

    const whereClause: any = {
      status: 'success'
    }

    if (swap_type) {
      whereClause.swap_type = swap_type
    }

    if (start_date && end_date) {
      whereClause.timestamp = {
        [Op.between]: [new Date(start_date as string), new Date(end_date as string)]
      }
    }

    // Get token_from stats
    const tokenFromStats = await SushiswapActivity.findAll({
      attributes: [
        'token_from_address',
        'token_from_symbol',
        [SushiswapActivity.sequelize!.fn('SUM', SushiswapActivity.sequelize!.col('usd_volume')), 'volume'],
        [SushiswapActivity.sequelize!.fn('COUNT', SushiswapActivity.sequelize!.col('id')), 'swap_count']
      ],
      where: whereClause,
      group: ['token_from_address', 'token_from_symbol'],
      raw: true
    })

    // Get token_to stats
    const tokenToStats = await SushiswapActivity.findAll({
      attributes: [
        'token_to_address',
        'token_to_symbol',
        [SushiswapActivity.sequelize!.fn('SUM', SushiswapActivity.sequelize!.col('usd_volume')), 'volume'],
        [SushiswapActivity.sequelize!.fn('COUNT', SushiswapActivity.sequelize!.col('id')), 'swap_count']
      ],
      where: whereClause,
      group: ['token_to_address', 'token_to_symbol'],
      raw: true
    })

    // Merge and aggregate token stats
    const tokenMap = new Map()

    tokenFromStats.forEach((row: any) => {
      const key = row.token_from_address
      if (!tokenMap.has(key)) {
        tokenMap.set(key, {
          address: row.token_from_address,
          symbol: row.token_from_symbol,
          volume: 0,
          swap_count: 0
        })
      }
      const token = tokenMap.get(key)
      token.volume += parseFloat(row.volume || 0)
      token.swap_count += parseInt(row.swap_count || 0)
    })

    tokenToStats.forEach((row: any) => {
      const key = row.token_to_address
      if (!tokenMap.has(key)) {
        tokenMap.set(key, {
          address: row.token_to_address,
          symbol: row.token_to_symbol,
          volume: 0,
          swap_count: 0
        })
      }
      const token = tokenMap.get(key)
      token.volume += parseFloat(row.volume || 0)
      token.swap_count += parseInt(row.swap_count || 0)
    })

    // Sort by volume and get top N
    const topTokens = Array.from(tokenMap.values())
      .sort((a, b) => b.volume - a.volume)
      .slice(0, Number(limit))

    return res.status(200).json({
      tokens: topTokens
    })

  } catch (error) {
    next(error)
  }
}

/**
 * GET /tracking/sushiswap/dashboard/top-wallets
 * Most active wallets by volume
 */
export const getTopWallets = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      swap_type,
      start_date,
      end_date,
      limit = 10
    } = req.query

    const whereClause: any = {
      status: 'success'
    }

    if (swap_type) {
      whereClause.swap_type = swap_type
    }

    if (start_date && end_date) {
      whereClause.timestamp = {
        [Op.between]: [new Date(start_date as string), new Date(end_date as string)]
      }
    }

    const topWallets = await SushiswapActivity.findAll({
      attributes: [
        'wallet_address',
        [SushiswapActivity.sequelize!.fn('SUM', SushiswapActivity.sequelize!.col('usd_volume')), 'total_volume'],
        [SushiswapActivity.sequelize!.fn('COUNT', SushiswapActivity.sequelize!.col('id')), 'swap_count'],
        [SushiswapActivity.sequelize!.fn('COUNT', SushiswapActivity.sequelize!.literal("CASE WHEN swap_type = 'CLASSIC' THEN 1 END")), 'classic_count'],
        [SushiswapActivity.sequelize!.fn('COUNT', SushiswapActivity.sequelize!.literal("CASE WHEN swap_type = 'LIMIT_ORDER' THEN 1 END")), 'limit_order_count']
      ],
      where: whereClause,
      group: ['wallet_address'],
      order: [[SushiswapActivity.sequelize!.literal('total_volume'), 'DESC']],
      limit: Number(limit),
      raw: true
    })

    return res.status(200).json({
      wallets: topWallets
    })

  } catch (error) {
    next(error)
  }
}
