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
import { Op } from 'sequelize'

const PREFIX = '[CheckCounterOrders]'

/**
 * Verify all filled orders have counter orders and place missing ones
 */
async function verifyAndPlaceMissingCounterOrders(
  wallet: WalletWithSigner,
  pairConfig: ReturnType<typeof getGridConfigForPair>
): Promise<void> {
  try {
    // Calculate start and end of today (UTC)
    const startOfToday = new Date()
    startOfToday.setUTCHours(0, 0, 0, 0)

    const endOfToday = new Date()
    endOfToday.setUTCHours(23, 59, 59, 999)

    // Build query conditions - only orders placed today
    const whereConditions: any = {
      wallet_address: wallet.address.toLowerCase(),
      status: 'filled',
      placed_at: {
        [Op.gte]: startOfToday,
        [Op.lte]: endOfToday
      }
    }

    // Get filled orders placed today (grid and counter orders)
    const filledOrders = await BotOrdersSimple.findAll({
      where: whereConditions,
      order: [['filled_at', 'ASC']]
    })

    if (filledOrders.length === 0) {
      KatanaLogger.info(
        PREFIX,
        `[Wallet ${wallet.index}] No filled orders placed today found`
      )
      return
    }

    KatanaLogger.info(
      PREFIX,
      `[Wallet ${wallet.index}] Found ${filledOrders.length} filled order(s) placed today, checking for missing counter orders`
    )

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
          const success = await CounterOrderService.placeCounterOrder(
            mockUpdate,
            wallet.signer,
            wallet.index,
            {
              profitMarginPercent: pairConfig.PROFIT_MARGIN_PERCENT,
              minOrderSizeUsd: pairConfig.MIN_ORDER_SIZE_USD,
              expiryHours: pairConfig.EXPIRY_HOURS
            }
          )

          if (success) {
            placedCount++
          }

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
          `[Wallet ${wallet.index}] ✅ Successfully placed ${placedCount} missing counter order(s)`
        )
      } else if (placedCount > 0) {
        KatanaLogger.warn(
          PREFIX,
          `[Wallet ${wallet.index}] ⚠️ Only placed ${placedCount}/${missingCount} missing counter orders (${missingCount - placedCount} failed or skipped)`
        )
      } else {
        KatanaLogger.error(
          PREFIX,
          `[Wallet ${wallet.index}] ❌ Failed to place any counter orders (0/${missingCount} placed)`
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

            // Place counter order (return value indicates success)
            const success = await CounterOrderService.placeCounterOrder(
              update,
              wallet.signer,
              wallet.index,
              {
                profitMarginPercent: pairConfig.PROFIT_MARGIN_PERCENT,
                minOrderSizeUsd: pairConfig.MIN_ORDER_SIZE_USD,
                expiryHours: pairConfig.EXPIRY_HOURS
              }
            )

            if (!success) {
              KatanaLogger.warn(
                PREFIX,
                `[Wallet ${wallet.index}] Failed to place counter order for filled order ${update.dbOrder.id}`
              )
            }
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
