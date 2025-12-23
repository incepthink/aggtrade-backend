/**
 * Order Cancellation Service
 * Handles bulk cancellation of orders during midnight reset
 */

import BotOrdersSimple from '../../../models/BotOrdersSimple'
import { KatanaLogger } from '../../../utils/logger'
import { DatabaseLogger } from '../../../utils/logging/DatabaseLogger'

const PREFIX = '[OrderCancellation]'

export interface CancellationResult {
  canceledCount: number
  skippedCount: number
}

export interface BulkCancellationResult {
  totalOrders: number
  canceledCount: number
  failedCount: number
}

export class OrderCancellationService {
  /**
   * Cancel all active orders for a specific wallet (database only)
   * Marks orders as 'canceled' in the database without blockchain interaction
   *
   * @param walletAddress - Wallet address to cancel orders for
   * @param walletIndex - Wallet index for logging
   * @returns Cancellation counts
   */
  static async cancelAllOrdersForWallet(
    walletAddress: string,
    walletIndex: number
  ): Promise<CancellationResult> {
    try {
      // Find all active (pending or partial) orders for this wallet
      const activeOrders = await BotOrdersSimple.findActiveOrders(walletAddress)

      if (activeOrders.length === 0) {
        KatanaLogger.info(PREFIX, `[Wallet ${walletIndex}] No active orders to cancel`)
        return { canceledCount: 0, skippedCount: 0 }
      }

      KatanaLogger.info(PREFIX, `[Wallet ${walletIndex}] Found ${activeOrders.length} active orders to cancel`)

      // Extract blockchain order IDs for batch update
      const orderIds = activeOrders.map((order: any) => order.blockchain_order_id)

      // Batch update all orders to 'canceled' status
      const [updateCount] = await BotOrdersSimple.update(
        {
          status: 'canceled',
          last_checked_at: new Date()
        },
        {
          where: {
            blockchain_order_id: orderIds
          }
        }
      )

      // Log successful cancellation
      await DatabaseLogger.recordMetric(
        walletIndex,
        walletAddress,
        'orders_canceled_midnight_reset',
        updateCount
      )

      KatanaLogger.info(
        PREFIX,
        `[Wallet ${walletIndex}] ✅ Canceled ${updateCount} orders (${orderIds.join(', ').slice(0, 100)}...)`
      )

      return {
        canceledCount: updateCount,
        skippedCount: activeOrders.length - updateCount
      }

    } catch (error: any) {
      // Log error but don't throw - we want to continue with other wallets
      await DatabaseLogger.logError(
        walletIndex,
        walletAddress,
        'order_cancellation_failed',
        error.message,
        'cancelAllOrdersForWallet'
      )

      KatanaLogger.error(
        PREFIX,
        `[Wallet ${walletIndex}] ❌ Failed to cancel orders`,
        error
      )

      return { canceledCount: 0, skippedCount: 0 }
    }
  }

  /**
   * Cancel all active orders for all wallets (used in midnight reset)
   * Processes wallets sequentially with error isolation
   *
   * @param botWallets - Array of bot wallet records from database
   * @returns Aggregated cancellation results
   */
  static async cancelAllOrders(botWallets: any[]): Promise<BulkCancellationResult> {
    KatanaLogger.info(PREFIX, `Starting bulk cancellation for ${botWallets.length} wallets...`)

    const results: BulkCancellationResult = {
      totalOrders: 0,
      canceledCount: 0,
      failedCount: 0
    }

    for (let i = 0; i < botWallets.length; i++) {
      const wallet = botWallets[i]
      const walletNum = i + 1

      try {
        const result = await this.cancelAllOrdersForWallet(
          wallet.wallet_address,
          wallet.wallet_index
        )

        results.totalOrders += result.canceledCount + result.skippedCount
        results.canceledCount += result.canceledCount

        // Small delay between wallets to avoid overwhelming database
        if (i + 1 < botWallets.length) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }

      } catch (error: any) {
        results.failedCount++
        KatanaLogger.error(
          PREFIX,
          `[${walletNum}/${botWallets.length}] Failed to process wallet ${wallet.wallet_index}`,
          error
        )
        // Continue with next wallet
      }
    }

    KatanaLogger.info(PREFIX, 'Bulk cancellation complete')
    KatanaLogger.info(PREFIX, `  Total active orders found: ${results.totalOrders}`)
    KatanaLogger.info(PREFIX, `  ✅ Successfully canceled: ${results.canceledCount}`)
    KatanaLogger.info(PREFIX, `  ❌ Failed wallets: ${results.failedCount}`)

    return results
  }
}
