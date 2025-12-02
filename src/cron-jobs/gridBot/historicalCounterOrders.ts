import { BotWallet, OrderStatusUpdate } from './types'
import BotLimitOrder from '../../models/BotLimitOrder'
import { processFilledOrders } from './counterOrderManager'
import { TwapService, type TwapOrder } from '../../services/twap'
import { OrderStatus } from '@orbs-network/twap-sdk'
import { KatanaLogger } from '../../utils/logger'

const PREFIX = '[HistoricalCounterOrders]'

/**
 * Place counter orders for all COMPLETED orders from December 3, 2025
 * fetched from TWAP SDK that don't already have counter orders
 */
export async function placeHistoricalCounterOrders(
  wallet: BotWallet,
  executionId: string
): Promise<void> {
  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Fetching COMPLETED orders from TWAP SDK for December 3...`)

  try {
    // Define December 3, 2025 date range (UTC) - in milliseconds for comparison with createdAt
    const startDate = new Date('2025-12-03T00:00:00.000Z').getTime()
    const endDate = new Date('2025-12-03T23:59:59.999Z').getTime()

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Searching for orders between ${new Date(startDate).toISOString()} and ${new Date(endDate).toISOString()}`
    )

    // Fetch all orders from TWAP SDK
    const blockchainOrders = await TwapService.fetchLimitOrders(wallet.address)

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] TWAP SDK returned: ${blockchainOrders.COMPLETED.length} COMPLETED orders total`
    )

    // Filter COMPLETED orders from Nov 30
    const nov30CompletedOrders = blockchainOrders.COMPLETED.filter((order: TwapOrder) => {
      // order.createdAt is in milliseconds
      return order.createdAt >= startDate && order.createdAt <= endDate
    })

    if (nov30CompletedOrders.length === 0) {
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] No COMPLETED orders found from December 3 on blockchain`)
      return
    }

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Found ${nov30CompletedOrders.length} COMPLETED orders from December 3 on blockchain`
    )

    // For each blockchain order, check if it exists in our database and needs a counter order
    const ordersNeedingCounterOrders: Array<{ blockchain: TwapOrder, db: BotLimitOrder }> = []

    for (const blockchainOrder of nov30CompletedOrders) {
      // Find the order in our database by blockchain_order_id
      const dbOrder = await BotLimitOrder.findOne({
        where: {
          blockchain_order_id: blockchainOrder.id,
          wallet_address: wallet.address
        }
      })

      if (!dbOrder) {
        KatanaLogger.warn(PREFIX,
          `[Wallet ${wallet.index}] Blockchain order ID ${blockchainOrder.id} not found in database, skipping`
        )
        continue
      }

      // Check if counter order already exists
      const isParentBuyOrder = dbOrder.order_type.includes('buy')
      const counterOrderType = isParentBuyOrder ? 'counter_sell' : 'counter_buy'

      const existingCounterOrder = await BotLimitOrder.findOne({
        where: {
          parent_order_id: dbOrder.order_id,
          order_type: counterOrderType
        }
      })

      if (!existingCounterOrder) {
        ordersNeedingCounterOrders.push({ blockchain: blockchainOrder, db: dbOrder })
      } else {
        KatanaLogger.info(PREFIX,
          `[Wallet ${wallet.index}] Order ${dbOrder.order_id} already has counter order ${existingCounterOrder.order_id}, skipping`
        )
      }
    }

    if (ordersNeedingCounterOrders.length === 0) {
      KatanaLogger.info(PREFIX,
        `[Wallet ${wallet.index}] All ${nov30CompletedOrders.length} COMPLETED orders already have counter orders`
      )
      return
    }

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] 🎯 ${ordersNeedingCounterOrders.length} orders need counter orders. Placing them now...`
    )

    // Convert to OrderStatusUpdate format for processing
    const statusUpdates: OrderStatusUpdate[] = ordersNeedingCounterOrders.map(({ blockchain, db }) => ({
      dbOrderId: db.id,
      blockchainOrderId: blockchain.id,
      orderId: db.order_id,
      previousStatus: 'pending', // doesn't matter for counter order placement
      newStatus: 'filled',
      previousProgress: 0,
      newProgress: 100,
      filledSrcAmount: blockchain.filledSrcAmount,
      filledDstAmount: blockchain.filledDstAmount,
      executionPrice: null // Will be calculated by counter order manager
    }))

    // Process all filled orders and place counter orders
    await processFilledOrders(statusUpdates, wallet, executionId)

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] ✅ Finished placing counter orders for ${ordersNeedingCounterOrders.length} historical orders`
    )

    // Log summary
    const orderTypes = ordersNeedingCounterOrders.reduce((acc, { db }) => {
      acc[db.order_type] = (acc[db.order_type] || 0) + 1
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
