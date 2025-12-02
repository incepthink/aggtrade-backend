import { BotWallet, OrderStatusUpdate } from './types'
import BotLimitOrder from '../../models/BotLimitOrder'
import { processFilledOrders } from './counterOrderManager'
import { KatanaLogger } from '../../utils/logger'
import { Op } from 'sequelize'

const PREFIX = '[HistoricalCounterOrders]'

/**
 * Place counter orders for all filled orders from Nov 30, 2025
 * that don't already have counter orders
 */
export async function placeHistoricalCounterOrders(
  wallet: BotWallet,
  executionId: string
): Promise<void> {
  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Checking for filled orders from Nov 30 without counter orders...`)

  try {
    // Define Nov 30, 2025 date range (UTC)
    const startDate = new Date('2025-11-30T00:00:00.000Z')
    const endDate = new Date('2025-11-30T23:59:59.999Z')

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Searching for orders between ${startDate.toISOString()} and ${endDate.toISOString()}`
    )

    // Find all filled orders from Nov 30 for this wallet
    const filledOrders = await BotLimitOrder.findAll({
      where: {
        wallet_address: wallet.address,
        status: 'filled',
        filled_at: {
          [Op.between]: [startDate, endDate]
        }
      },
      order: [['filled_at', 'ASC']]
    })

    if (filledOrders.length === 0) {
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] No filled orders found from Nov 30`)
      return
    }

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Found ${filledOrders.length} filled orders from Nov 30`
    )

    // Filter out orders that already have counter orders
    const ordersNeedingCounterOrders: BotLimitOrder[] = []

    for (const order of filledOrders) {
      const isParentBuyOrder = order.order_type.includes('buy')
      const counterOrderType = isParentBuyOrder ? 'counter_sell' : 'counter_buy'

      const existingCounterOrder = await BotLimitOrder.findOne({
        where: {
          parent_order_id: order.order_id,
          order_type: counterOrderType
        }
      })

      if (!existingCounterOrder) {
        ordersNeedingCounterOrders.push(order)
      } else {
        KatanaLogger.info(PREFIX,
          `[Wallet ${wallet.index}] Order ${order.order_id} already has counter order ${existingCounterOrder.order_id}, skipping`
        )
      }
    }

    if (ordersNeedingCounterOrders.length === 0) {
      KatanaLogger.info(PREFIX,
        `[Wallet ${wallet.index}] All ${filledOrders.length} filled orders already have counter orders`
      )
      return
    }

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] 🎯 ${ordersNeedingCounterOrders.length} orders need counter orders. Placing them now...`
    )

    // Convert to OrderStatusUpdate format for processing
    const statusUpdates: OrderStatusUpdate[] = ordersNeedingCounterOrders.map(order => ({
      dbOrderId: order.id,
      blockchainOrderId: order.blockchain_order_id!,
      orderId: order.order_id,
      previousStatus: 'pending', // doesn't matter for counter order placement
      newStatus: 'filled',
      previousProgress: 0,
      newProgress: 100,
      filledSrcAmount: order.filled_src_amount,
      filledDstAmount: order.filled_dst_amount,
      executionPrice: order.execution_price
    }))

    // Process all filled orders and place counter orders
    await processFilledOrders(statusUpdates, wallet, executionId)

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] ✅ Finished placing counter orders for ${ordersNeedingCounterOrders.length} historical orders`
    )

    // Log summary
    const orderTypes = ordersNeedingCounterOrders.reduce((acc, order) => {
      acc[order.order_type] = (acc[order.order_type] || 0) + 1
      return acc
    }, {} as Record<string, number>)

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Summary: ${JSON.stringify(orderTypes)}`
    )
  } catch (error) {
    KatanaLogger.error(PREFIX,
      `[Wallet ${wallet.index}] Failed to place historical counter orders`,
      error
    )
    // Don't throw - this is a supplementary operation
  }
}
