import BotLimitOrder from '../../models/BotLimitOrder'
import SushiswapActivity from '../../models/SushiswapActivity'
import BotWalletExecution from '../../models/BotWalletExecution'
import sequelize from '../../utils/db/sequelize'
import { KatanaLogger } from '../../utils/logger'
import { type TwapOrder } from '../../services/twap'
import { fromWei } from '../utils/botHelpers'

const PREFIX = '[DatabaseSync]'

/**
 * Sync order status from blockchain to database (atomic update of both tables)
 */
export async function syncOrderStatus(
  dbOrder: any, // BotLimitOrder instance
  blockchainOrder: TwapOrder,
  newStatus: 'pending' | 'partial' | 'filled' | 'canceled' | 'expired'
): Promise<void> {
  const transaction = await sequelize.transaction()

  try {
    // Calculate execution price if filled
    let executionPrice = null
    if (newStatus === 'filled' && blockchainOrder.filledDstAmount && blockchainOrder.filledSrcAmount) {
      // Get token decimals from order
      const srcDecimals = dbOrder.src_token_symbol === 'USDC' ? 6 : 18
      const dstDecimals = dbOrder.dst_token_symbol === 'USDC' ? 6 : 18

      const srcHuman = fromWei(blockchainOrder.filledSrcAmount, srcDecimals)
      const dstHuman = fromWei(blockchainOrder.filledDstAmount, dstDecimals)
      executionPrice = (parseFloat(dstHuman) / parseFloat(srcHuman)).toFixed(18)
    }

    // Convert wei to human-readable
    const srcDecimals = dbOrder.src_token_symbol === 'USDC' ? 6 : 18
    const dstDecimals = dbOrder.dst_token_symbol === 'USDC' ? 6 : 18

    const filledSrcHuman = fromWei(blockchainOrder.filledSrcAmount, srcDecimals)
    const filledDstHuman = fromWei(blockchainOrder.filledDstAmount, dstDecimals)

    // Update bot_limit_orders
    await BotLimitOrder.update(
      {
        status: newStatus,
        progress: blockchainOrder.progress,
        filled_src_amount: filledSrcHuman,
        filled_dst_amount: filledDstHuman,
        execution_price: executionPrice,
        filled_at: newStatus === 'filled' ? new Date() : null
      },
      {
        where: { id: dbOrder.id },
        transaction
      }
    )

    // Update sushiswap_activity
    await SushiswapActivity.update(
      {
        status: newStatus === 'filled' ? 'success' : newStatus,
        progress: blockchainOrder.progress,
        filled_src_amount: filledSrcHuman,
        filled_dst_amount: filledDstHuman,
        is_partial_fill: blockchainOrder.progress > 0 && blockchainOrder.progress < 100,
        execution_price: executionPrice ? parseFloat(executionPrice) : 0
      },
      {
        where: { order_id: dbOrder.order_id },
        transaction
      }
    )

    // If filled, update bot_wallet_executions counter
    if (newStatus === 'filled') {
      await BotWalletExecution.increment('limit_orders_filled', {
        where: {
          execution_id: dbOrder.execution_id,
          wallet_address: dbOrder.wallet_address
        },
        transaction
      })
    }

    await transaction.commit()

    KatanaLogger.info(
      PREFIX,
      `Synced order status: ${dbOrder.order_id} -> ${newStatus} (${blockchainOrder.progress}%)`
    )
  } catch (error) {
    await transaction.rollback()
    KatanaLogger.error(PREFIX, `Failed to sync order status for ${dbOrder.order_id}`, error)
    throw error
  }
}

/**
 * Create order in both tables atomically
 */
export async function createOrderInBothTables(
  botOrderData: any,
  sushiActivityData: any
): Promise<any> {
  const transaction = await sequelize.transaction()

  try {
    // Create in bot_limit_orders
    const botOrder = await BotLimitOrder.create(botOrderData, { transaction })

    // Create in sushiswap_activity (with bot order's order_id)
    await SushiswapActivity.create(
      {
        ...sushiActivityData,
        order_id: botOrder.order_id
      },
      { transaction }
    )

    await transaction.commit()

    KatanaLogger.info(PREFIX, `Created order in both tables: ${botOrder.order_id}`)
    return botOrder
  } catch (error) {
    await transaction.rollback()
    KatanaLogger.error(PREFIX, 'Failed to create order in both tables', error)
    throw error
  }
}

/**
 * Update order metadata (non-status changes)
 */
export async function updateOrderMetadata(
  orderId: string,
  metadata: any
): Promise<void> {
  try {
    await BotLimitOrder.update(
      {
        metadata: sequelize.fn('JSON_MERGE_PATCH', sequelize.col('metadata'), JSON.stringify(metadata))
      },
      {
        where: { order_id: orderId }
      }
    )

    KatanaLogger.info(PREFIX, `Updated metadata for order: ${orderId}`)
  } catch (error) {
    KatanaLogger.error(PREFIX, `Failed to update metadata for ${orderId}`, error)
    throw error
  }
}

/**
 * Get pending/partial orders for a wallet
 */
export async function getPendingOrders(
  walletAddress: string,
  executionId: string
): Promise<any[]> {
  try {
    const orders = await BotLimitOrder.findAll({
      where: {
        wallet_address: walletAddress,
        execution_id: executionId,
        status: ['pending', 'partial']
      },
      order: [['placed_at', 'ASC']]
    })

    return orders
  } catch (error) {
    KatanaLogger.error(PREFIX, `Failed to get pending orders for ${walletAddress}`, error)
    return []
  }
}

/**
 * Check if grid exists for wallet (checks ALL executions, not just current one)
 * This prevents placing duplicate grids when resuming after restart
 */
export async function hasExistingGrid(
  walletAddress: string,
  executionId: string // Kept for backward compatibility but not used in where clause
): Promise<boolean> {
  try {
    const count = await BotLimitOrder.count({
      where: {
        wallet_address: walletAddress,
        status: ['pending', 'partial'], // Only check active orders
        order_type: ['grid_buy', 'grid_sell']
        // NOTE: Removed execution_id filter to check ALL executions
      }
    })

    return count > 0
  } catch (error) {
    KatanaLogger.error(PREFIX, `Failed to check existing grid for ${walletAddress}`, error)
    return false
  }
}
