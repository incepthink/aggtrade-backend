import type { Request, Response, NextFunction } from "express"
import BotLimitOrder from "../../models/BotLimitOrder"
import BotExecution from "../../models/BotExecution"

interface PlaceLimitOrderRequest {
  execution_id: string
  wallet_index: number
  wallet_address: string
  order_id: string
  tx_hash: string
  chain_id?: number
  src_token_address: string
  src_token_symbol: string
  src_amount: string
  dst_token_address: string
  dst_token_symbol: string
  dst_min_amount: string
  deadline?: number
  placed_at?: string
  order_type?: 'grid_buy' | 'grid_sell' | 'counter_buy' | 'counter_sell'
}

interface UpdateFilledRequest {
  filled_src_amount: string
  filled_dst_amount: string
  progress: number
  usd_volume: number
  status: 'partial' | 'filled' | 'canceled' | 'expired'
  filled_at?: string
}

/**
 * POST /tracking/bot/limit-order/placed
 * Record when bot places a limit order
 */
export const placeLimitOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data: PlaceLimitOrderRequest = req.body

    // Validate required fields
    if (!data.execution_id || !data.wallet_address || !data.order_id || !data.tx_hash ||
        !data.src_token_address || !data.dst_token_address) {
      return res.status(400).json({
        error: 'Missing required fields'
      })
    }

    // Verify execution exists
    const execution = await BotExecution.findOne({
      where: { execution_id: data.execution_id }
    })

    if (!execution) {
      return res.status(404).json({
        error: 'Execution not found'
      })
    }

    // Create limit order record
    const limitOrder = await BotLimitOrder.create({
      execution_id: data.execution_id,
      wallet_index: data.wallet_index,
      wallet_address: data.wallet_address.toLowerCase(),
      order_id: String(data.order_id),
      blockchain_order_id: null,
      parent_order_id: null,
      order_type: data.order_type || (data.wallet_index === 1 ? 'counter_buy' : 'counter_sell'),
      grid_offset_percent: null,
      tx_hash: data.tx_hash,
      chain_id: data.chain_id || 747474,
      src_token_address: data.src_token_address.toLowerCase(),
      src_token_symbol: data.src_token_symbol,
      src_amount: String(data.src_amount),
      dst_token_address: data.dst_token_address.toLowerCase(),
      dst_token_symbol: data.dst_token_symbol,
      dst_min_amount: String(data.dst_min_amount),
      execution_price: null,
      filled_src_amount: '0',
      filled_dst_amount: '0',
      progress: 0,
      usd_volume: 0,
      status: 'pending',
      placed_at: data.placed_at ? new Date(data.placed_at) : new Date(),
      filled_at: null,
      deadline: data.deadline || null,
      metadata: null
    })

    return res.status(201).json({
      success: true,
      limit_order_id: limitOrder.id
    })

  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /tracking/bot/limit-order/:order_id/filled
 * Update limit order when dashboard detects it was filled
 */
export const updateLimitOrderFilled = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { order_id } = req.params
    const data: UpdateFilledRequest = req.body

    // Validate required fields
    if (!data.status || data.progress === undefined) {
      return res.status(400).json({
        error: 'Missing required fields: status, progress'
      })
    }

    // Find the limit order
    const limitOrder = await BotLimitOrder.findOne({
      where: { order_id: String(order_id) }
    })

    if (!limitOrder) {
      return res.status(404).json({
        error: 'Limit order not found'
      })
    }

    // Update limit order
    await limitOrder.update({
      filled_src_amount: data.filled_src_amount ? String(data.filled_src_amount) : limitOrder.filled_src_amount,
      filled_dst_amount: data.filled_dst_amount ? String(data.filled_dst_amount) : limitOrder.filled_dst_amount,
      progress: data.progress,
      usd_volume: data.usd_volume || limitOrder.usd_volume,
      status: data.status,
      filled_at: data.filled_at ? new Date(data.filled_at) : (data.status === 'filled' ? new Date() : limitOrder.filled_at)
    })

    return res.status(200).json({
      success: true,
      limit_order: limitOrder
    })

  } catch (error) {
    next(error)
  }
}

/**
 * GET /tracking/bot/limit-orders/:execution_id
 * Get all limit orders for an execution
 */
export const getLimitOrdersByExecution = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { execution_id } = req.params
    const { wallet_address, status } = req.query

    // Build where clause
    const whereClause: any = {
      execution_id: parseInt(execution_id)
    }

    if (wallet_address) {
      whereClause.wallet_address = (wallet_address as string).toLowerCase()
    }

    if (status) {
      whereClause.status = status
    }

    // Get orders
    const orders = await BotLimitOrder.findAll({
      where: whereClause,
      order: [['placed_at', 'DESC']]
    })

    // Calculate summary stats
    const summary = {
      total: orders.length,
      pending: orders.filter(o => o.status === 'pending').length,
      partial: orders.filter(o => o.status === 'partial').length,
      filled: orders.filter(o => o.status === 'filled').length,
      canceled: orders.filter(o => o.status === 'canceled').length,
      expired: orders.filter(o => o.status === 'expired').length,
      total_volume_usd: orders.reduce((sum, o) => sum + parseFloat(o.usd_volume.toString()), 0)
    }

    return res.status(200).json({
      execution_id: parseInt(execution_id),
      orders,
      summary
    })

  } catch (error) {
    next(error)
  }
}
