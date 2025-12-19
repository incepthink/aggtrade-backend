import { Op } from "sequelize"
import SushiswapActivity from "../../../models/SushiswapActivity"
import { TwapService } from "../../../services/twap"
import { KatanaLogger } from "../../../utils/logger"

const LOG_PREFIX = "[XP-LIMIT-ORDER-FEES]"

/**
 * Result summary from updating limit order fees
 */
export interface FeeUpdateResult {
  totalOrders: number
  walletsProcessed: number
  feesUpdated: number
  ordersNotFoundInSDK: number
  errors: string[]
}

/**
 * Update fees for limit orders by fetching data from TWAP SDK
 *
 * Process:
 * 1. Get all limit orders for the week with status = 'success'
 * 2. Extract unique wallet addresses
 * 3. For each wallet, fetch SDK orders (cached to avoid duplicates)
 * 4. Match SDK orders to DB records by order_id
 * 5. Calculate fees: filledDollarValueIn - filledDollarValueOut
 * 6. Batch update the database
 *
 * @param weekStart - Start of the week to process
 * @param weekEnd - End of the week to process
 * @returns Summary of updates performed
 */
export const updateLimitOrderFeesFromSDK = async (
  weekStart: Date,
  weekEnd: Date
): Promise<FeeUpdateResult> => {
  const result: FeeUpdateResult = {
    totalOrders: 0,
    walletsProcessed: 0,
    feesUpdated: 0,
    ordersNotFoundInSDK: 0,
    errors: []
  }

  KatanaLogger.info(LOG_PREFIX, "Starting limit order fee update", {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString()
  })

  try {
    // Step 1: Query all limit orders for the week
    const limitOrders = await SushiswapActivity.findAll({
      where: {
        swap_type: 'LIMIT_ORDER',
        status: 'success',
        timestamp: {
          [Op.gte]: weekStart,
          [Op.lt]: weekEnd
        }
      }
    })

    result.totalOrders = limitOrders.length

    if (limitOrders.length === 0) {
      KatanaLogger.info(LOG_PREFIX, "No limit orders found for the week")
      return result
    }

    KatanaLogger.info(LOG_PREFIX, `Found ${limitOrders.length} limit orders`)

    // Step 2: Extract unique wallet addresses
    const uniqueWallets = [...new Set(limitOrders.map(order => order.wallet_address))]
    KatanaLogger.info(LOG_PREFIX, `Processing ${uniqueWallets.length} unique wallets`)

    // Step 3: Cache for SDK responses to avoid duplicate fetches
    const sdkOrdersCache = new Map<string, any[]>()

    // Map to store order_id -> calculated fees for batch update
    const feeUpdates = new Map<string, { id: number, fees_usd: number }>()

    // Step 4: Process each wallet
    for (const walletAddress of uniqueWallets) {
      try {
        KatanaLogger.info(LOG_PREFIX, `Processing wallet: ${walletAddress}`)

        // Fetch SDK orders for this wallet (use cache if available)
        let sdkOrders: any[]
        if (sdkOrdersCache.has(walletAddress)) {
          sdkOrders = sdkOrdersCache.get(walletAddress)!
          KatanaLogger.info(LOG_PREFIX, `Using cached SDK orders for wallet ${walletAddress}`)
        } else {
          const groupedOrders = await TwapService.fetchLimitOrders(walletAddress)
          // Only use COMPLETED orders as they have accurate fee data
          sdkOrders = groupedOrders.COMPLETED
          sdkOrdersCache.set(walletAddress, sdkOrders)
          KatanaLogger.info(LOG_PREFIX, `Fetched ${sdkOrders.length} completed orders from SDK`)
        }

        result.walletsProcessed++

        // Step 5: Match SDK orders with DB records for this wallet
        const walletOrders = limitOrders.filter(order => order.wallet_address === walletAddress)

        for (const dbOrder of walletOrders) {
          // Skip if order_id is not set
          if (!dbOrder.order_id) {
            KatanaLogger.warn(LOG_PREFIX, `DB order ${dbOrder.id} has no order_id, skipping`)
            continue
          }

          // Find matching SDK order by order_id
          const sdkOrder = sdkOrders.find(o => String(o.id) === String(dbOrder.order_id))

          if (!sdkOrder) {
            KatanaLogger.warn(LOG_PREFIX, `Order not found in SDK`, {
              dbOrderId: dbOrder.id,
              orderId: dbOrder.order_id,
              wallet: walletAddress
            })
            result.ordersNotFoundInSDK++
            continue
          }

          // Step 6: Calculate fees from SDK order data
          const filledDollarValueIn = sdkOrder.filledDollarValueIn
            ? parseFloat(sdkOrder.filledDollarValueIn)
            : 0
          const filledDollarValueOut = sdkOrder.filledDollarValueOut
            ? parseFloat(sdkOrder.filledDollarValueOut)
            : 0

          const calculatedFees = filledDollarValueIn - filledDollarValueOut

          // Validate calculated fees
          if (isNaN(calculatedFees) || calculatedFees < 0) {
            const errorMsg = `Invalid fee calculation for order ${dbOrder.order_id}: ${calculatedFees}`
            KatanaLogger.error(LOG_PREFIX, errorMsg, {
              filledDollarValueIn,
              filledDollarValueOut,
              calculatedFees
            })
            result.errors.push(errorMsg)
            continue
          }

          KatanaLogger.info(LOG_PREFIX, `Calculated fees for order ${dbOrder.order_id}`, {
            orderId: dbOrder.order_id,
            filledDollarValueIn,
            filledDollarValueOut,
            calculatedFees: calculatedFees.toFixed(4)
          })

          // Store for batch update
          feeUpdates.set(dbOrder.order_id, {
            id: dbOrder.id,
            fees_usd: calculatedFees
          })
        }
      } catch (error) {
        const errorMsg = `Failed to process wallet ${walletAddress}: ${error instanceof Error ? error.message : String(error)}`
        KatanaLogger.error(LOG_PREFIX, errorMsg, error)
        result.errors.push(errorMsg)
        // Continue with other wallets
      }
    }

    // Step 7: Batch update database
    if (feeUpdates.size > 0) {
      KatanaLogger.info(LOG_PREFIX, `Updating ${feeUpdates.size} orders in database`)

      try {
        // Update each order individually (Sequelize doesn't support bulk update with different values easily)
        for (const [orderId, { id, fees_usd }] of feeUpdates.entries()) {
          await SushiswapActivity.update(
            { fees_usd },
            { where: { id } }
          )
        }

        result.feesUpdated = feeUpdates.size
        KatanaLogger.info(LOG_PREFIX, `Successfully updated ${result.feesUpdated} orders`)
      } catch (error) {
        const errorMsg = `Database update failed: ${error instanceof Error ? error.message : String(error)}`
        KatanaLogger.error(LOG_PREFIX, errorMsg, error)
        result.errors.push(errorMsg)
      }
    } else {
      KatanaLogger.info(LOG_PREFIX, "No fees to update")
    }

  } catch (error) {
    const errorMsg = `Fatal error in updateLimitOrderFeesFromSDK: ${error instanceof Error ? error.message : String(error)}`
    KatanaLogger.error(LOG_PREFIX, errorMsg, error)
    result.errors.push(errorMsg)
  }

  // Log final summary
  KatanaLogger.info(LOG_PREFIX, "Limit order fee update complete", {
    totalOrders: result.totalOrders,
    walletsProcessed: result.walletsProcessed,
    feesUpdated: result.feesUpdated,
    ordersNotFoundInSDK: result.ordersNotFoundInSDK,
    errorCount: result.errors.length
  })

  return result
}
