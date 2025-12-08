/**
 * Order Status Service
 * Handles polling blockchain for order status updates
 */

import BotOrdersSimple from '../../../models/BotOrdersSimple'
import { TwapService, type TwapOrder } from '../../../services/twap'
import { getToken } from '../../gridBot/tokenPairs.config'
import { toWei, fromWei } from '../../utils/botHelpers'
import { KatanaLogger } from '../../../utils/logger'
import { TEST_MODE_CONFIG } from '../config'

const PREFIX = '[OrderStatus]'

export interface OrderStatusUpdate {
  dbOrder: any
  blockchainOrder: TwapOrder
  oldStatus: string
  newStatus: 'pending' | 'partial' | 'filled' | 'expired' | 'canceled'
  progress: number
}

export class OrderStatusService {
  /**
   * Map blockchain status to database status
   */
  private static mapBlockchainStatus(
    blockchainStatus: string,
    progress: number
  ): 'pending' | 'partial' | 'filled' | 'expired' | 'canceled' {
    switch (blockchainStatus) {
      case 'Open':
        // Order is fully filled at 100% progress even if status is still "Open"
        if (progress === 100) return 'filled'
        if (progress > 0 && progress < 100) return 'partial'
        return 'pending'
      case 'Completed':
        return 'filled'
      case 'Canceled':
        return 'canceled'
      case 'Expired':
        return 'expired'
      default:
        return 'pending'
    }
  }

  /**
   * Poll blockchain for order status updates
   */
  static async pollOrderStatus(
    walletAddress: string,
    walletIndex: number
  ): Promise<OrderStatusUpdate[]> {
    KatanaLogger.info(PREFIX, `[Wallet ${walletIndex}] Polling order status...`)

    const dbOrders = await BotOrdersSimple.findAll({
      where: {
        wallet_address: walletAddress.toLowerCase(),
        status: ['pending', 'partial']
      },
      order: [['placed_at', 'ASC']]
    })

    if (dbOrders.length === 0) {
      KatanaLogger.info(PREFIX, `[Wallet ${walletIndex}] No pending orders`)
      return []
    }

    KatanaLogger.info(PREFIX, `[Wallet ${walletIndex}] Found ${dbOrders.length} active orders`)

    if (TEST_MODE_CONFIG.enabled) {
      return this.pollOrderStatusTestMode(dbOrders, walletIndex)
    }

    return this.pollOrderStatusProduction(dbOrders, walletAddress, walletIndex)
  }

  /**
   * Production: Poll real blockchain
   */
  private static async pollOrderStatusProduction(
    dbOrders: any[],
    walletAddress: string,
    walletIndex: number
  ): Promise<OrderStatusUpdate[]> {
    const updates: OrderStatusUpdate[] = []

    // Fetch blockchain orders
    let blockchainOrders: any
    try {
      blockchainOrders = await TwapService.fetchLimitOrders(walletAddress)
    } catch (error) {
      KatanaLogger.error(PREFIX, `[Wallet ${walletIndex}] Failed to fetch blockchain orders`, error)
      return updates
    }

    KatanaLogger.info(
      PREFIX,
      `[Wallet ${walletIndex}] Blockchain: ${blockchainOrders.OPEN.length} OPEN, ${blockchainOrders.COMPLETED.length} COMPLETED`
    )

    // Match and detect changes
    for (const dbOrder of dbOrders) {
      try {
        const blockchainOrder = blockchainOrders.ALL.find(
          (o: TwapOrder) => String(o.id) === String(dbOrder.blockchain_order_id)
        )

        if (!blockchainOrder) {
          KatanaLogger.warn(
            PREFIX,
            `[Wallet ${walletIndex}] Blockchain order not found for DB order ${dbOrder.id}`
          )
          continue
        }

        const newStatus = this.mapBlockchainStatus(blockchainOrder.status, blockchainOrder.progress)

        if (newStatus !== dbOrder.status || blockchainOrder.progress !== parseFloat(String(dbOrder.progress))) {
          KatanaLogger.info(
            PREFIX,
            `[Wallet ${walletIndex}] Status change: ${dbOrder.order_type} ${dbOrder.status}(${dbOrder.progress}%) -> ${newStatus}(${blockchainOrder.progress}%)`
          )

          updates.push({
            dbOrder,
            blockchainOrder,
            oldStatus: dbOrder.status,
            newStatus,
            progress: blockchainOrder.progress
          })
        }
      } catch (error) {
        KatanaLogger.error(PREFIX, `[Wallet ${walletIndex}] Failed to process order ${dbOrder.id}`, error)
      }
    }

    KatanaLogger.info(PREFIX, `[Wallet ${walletIndex}] Poll complete: ${updates.length} changes`)

    return updates
  }

  /**
   * Test mode: Simulate fills
   */
  private static pollOrderStatusTestMode(
    dbOrders: any[],
    walletIndex: number
  ): OrderStatusUpdate[] {
    KatanaLogger.info(PREFIX, `[Wallet ${walletIndex}] [TEST MODE] Simulating status updates...`)

    const updates: OrderStatusUpdate[] = []

    for (const dbOrder of dbOrders) {
      const shouldFill = Math.random() < 0.3 // 30% chance

      if (shouldFill) {
        const fromToken = getToken(dbOrder.from_token)
        const toToken = getToken(dbOrder.to_token)

        const filledSrcAmount = toWei(dbOrder.from_amount, fromToken.decimals)
        const filledDstAmount = toWei(dbOrder.to_amount, toToken.decimals)

        const simulatedBlockchainOrder: any = {
          id: dbOrder.blockchain_order_id,
          status: 'Completed',
          progress: 100,
          filledSrcAmount,
          filledDstAmount,
          srcAmount: filledSrcAmount,
          dstAmount: filledDstAmount
        }

        KatanaLogger.info(
          PREFIX,
          `[Wallet ${walletIndex}] [TEST MODE] Simulated fill: ${dbOrder.order_type} order ${dbOrder.id}`
        )

        updates.push({
          dbOrder,
          blockchainOrder: simulatedBlockchainOrder,
          oldStatus: dbOrder.status,
          newStatus: 'filled',
          progress: 100
        })
      }
    }

    KatanaLogger.info(PREFIX, `[Wallet ${walletIndex}] [TEST MODE] Simulated ${updates.length} fills`)

    return updates
  }

  /**
   * Update order status in database
   */
  static async updateOrderStatus(update: OrderStatusUpdate): Promise<void> {
    const { dbOrder, blockchainOrder, newStatus, progress } = update

    const updateData: any = {
      status: newStatus,
      progress: progress,
      last_checked_at: new Date()
    }

    if (newStatus === 'filled') {
      updateData.filled_at = new Date()

      const fromToken = getToken(dbOrder.from_token)
      const toToken = getToken(dbOrder.to_token)

      updateData.from_amount = fromWei(blockchainOrder.filledSrcAmount, fromToken.decimals)
      updateData.to_amount = fromWei(blockchainOrder.filledDstAmount, toToken.decimals)

      KatanaLogger.info(
        PREFIX,
        `Filled: ${updateData.from_amount} ${dbOrder.from_token} → ${updateData.to_amount} ${dbOrder.to_token}`
      )
    }

    await BotOrdersSimple.update(updateData, {
      where: { id: dbOrder.id }
    })

    KatanaLogger.info(PREFIX, `Updated order ${dbOrder.id}: ${newStatus} (${progress}%)`)
  }
}
