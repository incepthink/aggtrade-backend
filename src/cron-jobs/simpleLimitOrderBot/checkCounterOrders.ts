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
import { getGridConfigForPair } from './config'

const PREFIX = '[CheckCounterOrders]'

/**
 * Verify all filled orders have counter orders and place missing ones
 */
async function verifyAndPlaceMissingCounterOrders(
  wallet: WalletWithSigner,
  pairConfig: ReturnType<typeof getGridConfigForPair>
): Promise<void> {
  try {
    // Build query conditions
    const whereConditions: any = {
      wallet_address: wallet.address.toLowerCase(),
      status: 'filled'
    }

    // Get ALL filled orders (grid and counter orders)
    const filledOrders = await BotOrdersSimple.findAll({
      where: whereConditions,
      order: [['filled_at', 'ASC']]
    })

    if (filledOrders.length === 0) {
      return
    }

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
            wallet.index,
            {
              profitMarginPercent: pairConfig.PROFIT_MARGIN_PERCENT,
              minOrderSizeUsd: pairConfig.MIN_ORDER_SIZE_USD,
              expiryHours: pairConfig.EXPIRY_HOURS
            }
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

    if (missingCount > 0) {
      if (placedCount === missingCount) {
        KatanaLogger.info(
          PREFIX,
          `[Wallet ${wallet.index}] Placed ${placedCount} missing counter order(s)`
        )
      } else {
        KatanaLogger.error(
          PREFIX,
          `[Wallet ${wallet.index}] Only placed ${placedCount}/${missingCount} missing counter orders`
        )
      }
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
  try {
    // Get pair-specific configuration
    const pairConfig = getGridConfigForPair(wallet.tradingPool)

    // Poll blockchain for order status updates
    const updates = await OrderStatusService.pollOrderStatus(wallet.address, wallet.index)

    if (updates.length > 0) {
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Processing ${updates.length} filled order(s)`)

      // Process each status update
      for (const update of updates) {
        try {
          // Update order status in database
          await OrderStatusService.updateOrderStatus(update, wallet.index)

          // If order is filled, process it
          if (update.newStatus === 'filled') {
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
              wallet.index,
              {
                profitMarginPercent: pairConfig.PROFIT_MARGIN_PERCENT,
                minOrderSizeUsd: pairConfig.MIN_ORDER_SIZE_USD,
                expiryHours: pairConfig.EXPIRY_HOURS
              }
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
    }

    // After processing status changes, verify all filled orders have counter orders
    await verifyAndPlaceMissingCounterOrders(wallet, pairConfig)
  } catch (error) {
    KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] checkCounterOrders failed`, error)
    throw error
  }
}
