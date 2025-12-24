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
import { TwapService } from '../../services/twap'

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

    // STEP 1: Fetch ALL orders from blockchain for this wallet
    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Step 1: Fetching all orders from blockchain...`)

    let blockchainOrders: any
    try {
      blockchainOrders = await TwapService.fetchLimitOrders(wallet.address, true)
    } catch (error) {
      KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] Failed to fetch blockchain orders`, error)
      return
    }

    const allBlockchainOrders = blockchainOrders.ALL || []
    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Found ${allBlockchainOrders.length} orders on blockchain`)

    // STEP 2: Get all orders placed today from DB
    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Step 2: Getting orders placed today from database...`)

    const ordersPlacedToday = await BotOrdersSimple.findAll({
      where: {
        wallet_address: wallet.address.toLowerCase(),
        placed_at: {
          [Op.gte]: startOfToday,
          [Op.lte]: endOfToday
        }
      },
      order: [['placed_at', 'ASC']]
    })

    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Found ${ordersPlacedToday.length} orders placed today in DB`)

    if (ordersPlacedToday.length === 0) {
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] No orders placed today, skipping`)
      return
    }

    // STEP 3: Find filled orders by comparing blockchain data with DB data
    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Step 3: Comparing blockchain data to find filled orders...`)

    const filledOrders: Array<{dbOrder: any, blockchainOrder: any}> = []

    for (const dbOrder of ordersPlacedToday) {
      const blockchainOrder = allBlockchainOrders.find(
        (bo: any) => String(bo.id) === String(dbOrder.blockchain_order_id)
      )

      if (!blockchainOrder) {
        KatanaLogger.warn(PREFIX, `[Wallet ${wallet.index}] Order ${dbOrder.id} not found on blockchain`)
        continue
      }

      // Check if order is filled on blockchain
      const isFilled = blockchainOrder.status === 'Completed' || blockchainOrder.progress === 100

      if (isFilled) {
        filledOrders.push({ dbOrder, blockchainOrder })
      }
    }

    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Found ${filledOrders.length} filled order(s) from today`)

    if (filledOrders.length === 0) {
      return
    }

    // STEP 4: Place counter orders for filled orders
    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Step 4: Placing counter orders for filled orders...`)

    let missingCount = 0
    let placedCount = 0

    // Check each filled order for counter order
    for (const { dbOrder, blockchainOrder } of filledOrders) {
      try {
        KatanaLogger.info(
          PREFIX,
          `[Wallet ${wallet.index}] Checking order ${dbOrder.id} (${dbOrder.order_type}, ${dbOrder.from_token}/${dbOrder.to_token}, blockchain status: ${blockchainOrder.status}, progress: ${blockchainOrder.progress}%)`
        )

        // Determine expected counter order type
        const isParentBuyOrder = dbOrder.order_type.includes('buy')
        const expectedCounterType = isParentBuyOrder ? 'counter_sell' : 'counter_buy'

        // Check if counter order exists
        const existingCounterOrder = await BotOrdersSimple.findOne({
          where: {
            parent_order_id: dbOrder.id,
            order_type: expectedCounterType
          }
        })

        if (existingCounterOrder) {
          KatanaLogger.info(
            PREFIX,
            `[Wallet ${wallet.index}] Order ${dbOrder.id} already has counter order ${existingCounterOrder.id} (${existingCounterOrder.status})`
          )
          continue
        }

        // No counter order exists - need to place one
        KatanaLogger.info(
          PREFIX,
          `[Wallet ${wallet.index}] Order ${dbOrder.id} missing counter order, attempting to place...`
        )

        missingCount++

        // Get token configs to convert amounts to Wei
        const fromToken = getToken(dbOrder.from_token)
        const toToken = getToken(dbOrder.to_token)

        // Use blockchain data for filled amounts
        const fromAmountWei = blockchainOrder.filledSrcAmount || blockchainOrder.srcAmount
        const toAmountWei = blockchainOrder.filledDstAmount || blockchainOrder.dstAmount

        // Create update object to pass to counter order service
        const update: any = {
          dbOrder: dbOrder,
          blockchainOrder: {
            id: blockchainOrder.id,
            status: blockchainOrder.status,
            progress: blockchainOrder.progress,
            filledSrcAmount: fromAmountWei,
            filledDstAmount: toAmountWei,
            srcAmount: blockchainOrder.srcAmount,
            dstAmount: blockchainOrder.dstAmount
          },
          oldStatus: dbOrder.status,
          newStatus: 'filled',
          progress: blockchainOrder.progress
        }

        // Place the missing counter order
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

        if (success) {
          placedCount++
          KatanaLogger.info(
            PREFIX,
            `[Wallet ${wallet.index}] ✅ Successfully placed counter order for order ${dbOrder.id}`
          )
        } else {
          KatanaLogger.warn(
            PREFIX,
            `[Wallet ${wallet.index}] ⚠️ Failed to place counter order for order ${dbOrder.id} (see CounterOrder logs for details)`
          )
        }

        // Small delay between placements to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000))
      } catch (error) {
        KatanaLogger.error(
          PREFIX,
          `[Wallet ${wallet.index}] Failed to verify/place counter order for order ${dbOrder.id}`,
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
