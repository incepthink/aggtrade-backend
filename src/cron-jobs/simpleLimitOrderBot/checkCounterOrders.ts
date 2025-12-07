/**
 * Check Counter Orders Module
 * Handles checking order status and placing counter orders
 */

import { KatanaLogger } from '../../utils/logger'
import { type WalletWithSigner } from './services/WalletService'
import { OrderStatusService } from './services/OrderStatusService'
import { CounterOrderService } from './services/CounterOrderService'

const PREFIX = '[CheckCounterOrders]'

/**
 * Check orders and place counter-orders for a wallet
 */
export async function checkCounterOrders(
  wallet: WalletWithSigner,
  botWalletRecord: any
): Promise<void> {
  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Checking orders for counter-order placement...`)

  try {
    // Poll blockchain for order status updates
    const updates = await OrderStatusService.pollOrderStatus(wallet.address, wallet.index)

    if (updates.length === 0) {
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] No status changes detected`)
      return
    }

    // Process each status update
    for (const update of updates) {
      try {
        // Update order status in database
        await OrderStatusService.updateOrderStatus(update)

        // If order is filled, process it
        if (update.newStatus === 'filled') {
          KatanaLogger.info(
            PREFIX,
            `[Wallet ${wallet.index}] Order ${update.dbOrder.id} is filled! Processing...`
          )

          // Add to SushiswapActivity table
          await CounterOrderService.addToActivityLog(
            update,
            wallet.address,
            wallet.signer.provider!,
            wallet.index
          )

          // Place counter order
          await CounterOrderService.placeCounterOrder(
            update,
            wallet.signer,
            wallet.index
          )
        }
      } catch (error) {
        KatanaLogger.error(
          PREFIX,
          `[Wallet ${wallet.index}] Failed to process update for order ${update.dbOrder.id}`,
          error
        )
        // Continue with next update
      }
    }

    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Counter order check complete`)
  } catch (error) {
    KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] checkCounterOrders failed`, error)
    throw error
  }
}
