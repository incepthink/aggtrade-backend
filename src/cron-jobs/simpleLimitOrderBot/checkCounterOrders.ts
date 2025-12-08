/**
 * Check Counter Orders Module
 * Handles checking order status and placing counter orders
 */

import { KatanaLogger } from '../../utils/logger'
import { type WalletWithSigner } from './services/WalletService'
import { OrderStatusService } from './services/OrderStatusService'
import { CounterOrderService } from './services/CounterOrderService'
import BotOrdersSimple from '../../models/BotOrdersSimple'
import { getToken } from '../gridBot/tokenPairs.config'
import { toWei } from '../utils/botHelpers'

const PREFIX = '[CheckCounterOrders]'

/**
 * Verify all filled orders have counter orders and place missing ones
 */
async function verifyAndPlaceMissingCounterOrders(
  wallet: WalletWithSigner
): Promise<void> {
  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Verifying all filled orders have counter orders...`)

  try {
    // Get ALL filled orders (grid and counter orders)
    const filledOrders = await BotOrdersSimple.findAll({
      where: {
        wallet_address: wallet.address.toLowerCase(),
        status: 'filled'
      },
      order: [['filled_at', 'ASC']]
    })

    if (filledOrders.length === 0) {
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] No filled orders found`)
      return
    }

    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Found ${filledOrders.length} filled orders`)

    let missingCount = 0
    let placedCount = 0

    // Check each filled order for counter order
    for (const filledOrder of filledOrders) {
      try {
        // Determine expected counter order type
        const isParentBuyOrder = filledOrder.order_type.includes('buy')
        const expectedCounterType = isParentBuyOrder ? 'counter_sell' : 'counter_buy'

        // Check if counter order exists
        const existingCounterOrder = await BotOrdersSimple.findOne({
          where: {
            parent_order_id: filledOrder.id,
            order_type: expectedCounterType
          }
        })

        if (!existingCounterOrder) {
          missingCount++

          KatanaLogger.info(
            PREFIX,
            `[Wallet ${wallet.index}] Missing counter order for ${filledOrder.order_type} order ${filledOrder.id}`
          )
          KatanaLogger.info(
            PREFIX,
            `[Wallet ${wallet.index}] Filled: ${filledOrder.from_amount} ${filledOrder.from_token} → ${filledOrder.to_amount} ${filledOrder.to_token}`
          )

          // Get token configs to convert amounts to Wei
          const fromToken = getToken(filledOrder.from_token)
          const toToken = getToken(filledOrder.to_token)

          // Convert human-readable amounts to Wei format
          const fromAmountWei = toWei(filledOrder.from_amount, fromToken.decimals)
          const toAmountWei = toWei(filledOrder.to_amount, toToken.decimals)

          // Create mock update object to reuse existing counter order logic
          // We cast to 'any' since we only need the fields used by placeCounterOrder
          const mockUpdate: any = {
            dbOrder: filledOrder,
            blockchainOrder: {
              id: filledOrder.blockchain_order_id,
              status: 'Completed',
              progress: 100,
              filledSrcAmount: fromAmountWei,
              filledDstAmount: toAmountWei,
              srcAmount: fromAmountWei,
              dstAmount: toAmountWei
            },
            oldStatus: filledOrder.status,
            newStatus: 'filled',
            progress: 100
          }

          // Place the missing counter order
          await CounterOrderService.placeCounterOrder(
            mockUpdate,
            wallet.signer,
            wallet.index
          )

          placedCount++

          // Small delay between placements to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      } catch (error) {
        KatanaLogger.error(
          PREFIX,
          `[Wallet ${wallet.index}] Failed to verify/place counter order for order ${filledOrder.id}`,
          error
        )
        // Continue with next order
      }
    }

    if (missingCount === 0) {
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] ✅ All filled orders have counter orders`)
    } else {
      KatanaLogger.info(
        PREFIX,
        `[Wallet ${wallet.index}] 📝 Placed ${placedCount}/${missingCount} missing counter orders`
      )
    }
  } catch (error) {
    KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] Failed to verify counter orders`, error)
    throw error
  }
}

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
    } else {
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

      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Status updates processed`)
    }

    // After processing status changes, verify all filled orders have counter orders
    await verifyAndPlaceMissingCounterOrders(wallet)

    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Counter order check complete`)
  } catch (error) {
    KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] checkCounterOrders failed`, error)
    throw error
  }
}
