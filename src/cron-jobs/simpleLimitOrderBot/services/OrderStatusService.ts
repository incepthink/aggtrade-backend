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
import { DatabaseLogger } from '../../../utils/logging/DatabaseLogger'

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
    if (progress === 100) {
      return "filled"
    }
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
    // Build query conditions
    const whereConditions: any = {
      wallet_address: walletAddress.toLowerCase(),
      status: ['pending', 'partial']
    }

    const dbOrders = await BotOrdersSimple.findAll({
      where: whereConditions,
      order: [['placed_at', 'ASC']]
    })

    if (dbOrders.length === 0) {
      return []
    }

    if (TEST_MODE_CONFIG.enabled) {
      return this.pollOrderStatusTestMode(dbOrders, walletAddress, walletIndex)
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

    // Fetch blockchain orders (silent mode)
    let blockchainOrders: any
    try {
      blockchainOrders = await TwapService.fetchLimitOrders(walletAddress, true)
    } catch (error) {
      KatanaLogger.error(PREFIX, `[Wallet ${walletIndex}] Failed to fetch blockchain orders`, error)
      return updates
    }

    // Match and detect changes
    for (const dbOrder of dbOrders) {
      try {
        const blockchainOrder = blockchainOrders.ALL.find(
          (o: TwapOrder) => String(o.id) === String(dbOrder.blockchain_order_id)
        )

        if (!blockchainOrder) {
          continue
        }

        const newStatus = this.mapBlockchainStatus(blockchainOrder.status, blockchainOrder.progress)

        if (newStatus !== dbOrder.status || blockchainOrder.progress !== parseFloat(String(dbOrder.progress))) {
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

    return updates
  }

  /**
   * Test mode: Simulate fills
   */
  private static async pollOrderStatusTestMode(
    dbOrders: any[],
    walletAddress: string,
    walletIndex: number
  ): Promise<OrderStatusUpdate[]> {
    // Fetch blockchain orders (silent mode)
    let blockchainOrders: any
    try {
      blockchainOrders = await TwapService.fetchLimitOrders(walletAddress, true)
    } catch (error) {
      return []
    }

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

        updates.push({
          dbOrder,
          blockchainOrder: simulatedBlockchainOrder,
          oldStatus: dbOrder.status,
          newStatus: 'filled',
          progress: 100
        })
      }
    }

    if (updates.length > 0) {
      KatanaLogger.info(PREFIX, `[Wallet ${walletIndex}] [TEST MODE] Simulated ${updates.length} fills`)
    }

    return updates
  }

  /**
   * Update order status in database
   */
  static async updateOrderStatus(update: OrderStatusUpdate, walletIndex: number): Promise<void> {
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

      // Record filled order metric
      const usdValue = parseFloat(dbOrder.usd_value || '0')
      await DatabaseLogger.recordMetric(
        walletIndex,
        dbOrder.wallet_address,
        'order_filled',
        usdValue
      )
    }

    await BotOrdersSimple.update(updateData, {
      where: { id: dbOrder.id }
    })
  }
}
