import type { Request, Response, NextFunction } from "express"
import BotExecution from "../../models/BotExecution"
import BotWalletExecution from "../../models/BotWalletExecution"
import BotPortfolioSnapshot from "../../models/BotPortfolioSnapshot"
import SushiswapActivity from "../../models/SushiswapActivity"

/**
 * POST /bot/execution/start
 * Start a new bot execution run (no wallet records created yet)
 */
export const startExecution = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { execution_id, strategy_name, total_wallets } = req.body

    if (!execution_id || !strategy_name || !total_wallets) {
      return res.status(400).json({
        error: 'Missing required fields: execution_id, strategy_name, total_wallets'
      })
    }

    // Check if execution already exists
    const existing = await BotExecution.findOne({ where: { execution_id } })
    if (existing) {
      return res.status(409).json({ error: 'Execution ID already exists' })
    }

    // Create execution only
    const execution = await BotExecution.create({
      execution_id,
      strategy_name,
      total_wallets,
      completed_wallets: 0,
      failed_wallets: 0,
      total_volume_usd: 0,
      start_time: new Date(),
      end_time: null,
      status: 'running'
    })

    return res.status(201).json({
      message: 'Execution started successfully',
      execution
    })

  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /bot/execution/:id/wallet/:wallet_index/start
 * Create wallet execution record and mark as started
 */
export const startWalletExecution = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, wallet_index } = req.params
    const { wallet_address } = req.body

    if (!wallet_address ) {
      return res.status(400).json({
        error: 'Missing required fields: wallet_address'
      })
    }

    // Check if execution exists
    const execution = await BotExecution.findOne({ where: { execution_id: id } })
    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' })
    }

    // Find or create wallet execution
    const [walletExecution, created] = await BotWalletExecution.findOrCreate({
      where: {
        execution_id: id,
        wallet_index: Number(wallet_index)
      },
      defaults: {
        execution_id: id,
        wallet_index: Number(wallet_index),
        wallet_address: wallet_address.toLowerCase(),
        tokens: [],
        swaps_completed: 0,
        total_volume_usd: 0,
        status: 'running',
        error_message: null,
        start_time: new Date(),
        end_time: null
      }
    })

    // If already exists, just update to running
    if (!created) {
      await walletExecution.update({
        status: 'running',
        start_time: new Date()
      })
    }

    return res.status(200).json({
      message: created ? 'Wallet execution created and started' : 'Wallet execution started',
      walletExecution
    })

  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /bot/execution/:id/wallet/:wallet_index/complete
 * Mark wallet execution as completed or failed
 */
export const completeWalletExecution = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, wallet_index } = req.params
    const { status, error_message, swaps_completed, total_volume_usd, wallet_address, tokens } = req.body

    if (!status || !['completed', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be "completed" or "failed"' })
    }

    if (swaps_completed === undefined || total_volume_usd === undefined) {
      return res.status(400).json({ error: 'Missing required fields: swaps_completed, total_volume_usd' })
    }

    const walletExecution = await BotWalletExecution.findOne({
      where: {
        execution_id: id,
        wallet_index: Number(wallet_index)
      }
    })

    if (!walletExecution) {
      return res.status(404).json({ error: 'Wallet execution not found' })
    }

    // Prepare update data
    const updateData: any = {
      status,
      error_message: error_message || null,
      end_time: new Date(),
      swaps_completed: Number(swaps_completed),
      total_volume_usd: Number(total_volume_usd)
    }

    // Update wallet_address if provided
    if (wallet_address) {
      updateData.wallet_address = wallet_address.toLowerCase()
    }

    // Update tokens array if provided
    if (tokens && Array.isArray(tokens)) {
      updateData.tokens = tokens.map((token: string) => token.toUpperCase())
    }

    // Update wallet execution
    await walletExecution.update(updateData)

    // Update main execution counters
    const execution = await BotExecution.findOne({ where: { execution_id: id } })
    if (execution) {
      const updatedCounts = await BotWalletExecution.findOne({
        attributes: [
          [BotWalletExecution.sequelize!.fn('SUM', BotWalletExecution.sequelize!.literal("CASE WHEN status = 'completed' THEN 1 ELSE 0 END")), 'completed'],
          [BotWalletExecution.sequelize!.fn('SUM', BotWalletExecution.sequelize!.literal("CASE WHEN status = 'failed' THEN 1 ELSE 0 END")), 'failed'],
          [BotWalletExecution.sequelize!.fn('SUM', BotWalletExecution.sequelize!.col('total_volume_usd')), 'total_volume']
        ],
        where: { execution_id: id },
        raw: true
      })

      const completed = (updatedCounts as any)?.completed || 0
      const failed = (updatedCounts as any)?.failed || 0
      const total_volume_usd = (updatedCounts as any)?.total_volume || 0

      // Check if all wallets are done
      const allDone = (completed + failed) >= execution.total_wallets

      await execution.update({
        completed_wallets: completed,
        failed_wallets: failed,
        total_volume_usd,
        status: allDone ? (failed > 0 ? 'failed' : 'completed') : 'running',
        end_time: allDone ? new Date() : null
      })
    }

    return res.status(200).json({
      message: 'Wallet execution completed',
      walletExecution
    })

  } catch (error) {
    next(error)
  }
}

/**
 * POST /bot/portfolio/snapshot
 * Create a portfolio snapshot after a swap
 */
export const createPortfolioSnapshot = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      execution_id,
      wallet_address,
      total_capital_usd,
      eth_balance,
      usdc_balance,
      wbtc_balance,
      lbtc_balance,
      timestamp
    } = req.body

    if (!execution_id || !wallet_address || total_capital_usd === undefined) {
      return res.status(400).json({
        error: 'Missing required fields: execution_id, wallet_address, total_capital_usd'
      })
    }

    const snapshot = await BotPortfolioSnapshot.create({
      execution_id,
      wallet_address: wallet_address.toLowerCase(),
      total_capital_usd,
      eth_balance: eth_balance || '0',
      usdc_balance: usdc_balance || '0',
      wbtc_balance: wbtc_balance || '0',
      lbtc_balance: lbtc_balance || '0',
      timestamp: timestamp ? new Date(timestamp) : new Date()
    })

    return res.status(201).json({
      message: 'Portfolio snapshot created',
      snapshot
    })

  } catch (error) {
    next(error)
  }
}

/**
 * GET /bot/execution/:id
 * Get current execution details
 */
export const getExecutionDetails = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params

    const execution = await BotExecution.findOne({
      where: { execution_id: id }
    })

    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' })
    }

    const wallets = await BotWalletExecution.findAll({
      where: { execution_id: id },
      order: [['wallet_index', 'ASC']]
    })

    return res.status(200).json({
      execution,
      wallets
    })

  } catch (error) {
    next(error)
  }
}

/**
 * GET /bot/executions
 * Get historical executions list
 */
export const getExecutionsList = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { limit = 50, offset = 0 } = req.query

    const executions = await BotExecution.findAll({
      order: [['start_time', 'DESC']],
      limit: Number(limit),
      offset: Number(offset)
    })

    return res.status(200).json({ executions })

  } catch (error) {
    next(error)
  }
}

/**
 * GET /bot/portfolio/:execution_id/:wallet_address
 * Get portfolio snapshots for line graph
 */
export const getPortfolioHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { execution_id, wallet_address } = req.params

    const snapshots = await BotPortfolioSnapshot.findAll({
      where: {
        execution_id,
        wallet_address: wallet_address.toLowerCase()
      },
      order: [['timestamp', 'ASC']]
    })

    return res.status(200).json({ snapshots })

  } catch (error) {
    next(error)
  }
}
