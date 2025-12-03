import { BotWallet, OrderStatusUpdate } from './types'
import BotLimitOrder from '../../models/BotLimitOrder'
import { placeOrder } from './orderExecutor'
import { getGridConfig } from './gridManager'
import { getToken } from './tokenPairs.config'
import { getCurrentTokenPrice } from './priceManager'
import { updateOrderMetadata } from './databaseSync'
import { KatanaLogger } from '../../utils/logger'

const PREFIX = '[CounterOrderManager]'

const MIN_ORDER_VALUE_USD = 6 // $6 minimum

/**
 * Process filled orders and place counter-orders
 */
export async function processFilledOrders(
  filledUpdates: OrderStatusUpdate[],
  wallet: BotWallet,
  executionId: string
): Promise<void> {
  if (filledUpdates.length === 0) {
    return
  }

  KatanaLogger.info(PREFIX,
    `[Wallet ${wallet.index}] Processing ${filledUpdates.length} filled orders for counter-order placement`
  )

  const gridConfig = getGridConfig()

  for (const update of filledUpdates) {
    try {
      await placeCounterOrder(update, wallet, executionId, gridConfig.TESTING_MODE)
    } catch (error) {
      KatanaLogger.error(PREFIX,
        `[Wallet ${wallet.index}] Failed to place counter-order for order ${update.dbOrderId}`,
        error
      )
    }
  }
}

/**
 * Place a counter-order for a filled parent order
 */
async function placeCounterOrder(
  update: OrderStatusUpdate,
  wallet: BotWallet,
  executionId: string,
  testingMode: boolean = false
): Promise<void> {
  // 1. Fetch parent order from database
  const parentOrder = await BotLimitOrder.findByPk(update.dbOrderId)

  if (!parentOrder) {
    KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] Parent order not found: ${update.dbOrderId}`)
    return
  }

  // 1.5. Check if counter order already exists (duplicate protection)
  const isParentBuyOrder = parentOrder.order_type.includes('buy')
  const counterOrderType = isParentBuyOrder ? 'counter_sell' : 'counter_buy'

  const existingCounterOrder = await BotLimitOrder.findOne({
    where: {
      parent_order_id: parentOrder.order_id,
      order_type: counterOrderType
    }
  })

  if (existingCounterOrder) {
    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Counter order already exists for parent ${parentOrder.order_id} ` +
      `(counter order ID: ${existingCounterOrder.order_id}). Skipping.`
    )
    return
  }

  KatanaLogger.info(PREFIX, 
    `[Wallet ${wallet.index}] Placing counter-order for filled ${parentOrder.order_type}: ${parentOrder.order_id}`
  )

  try {
    // 2. Get token configurations from parent order
    const srcToken = getToken(parentOrder.src_token_symbol)
    const dstToken = getToken(parentOrder.dst_token_symbol)

    const srcHuman = parseFloat(parentOrder.filled_src_amount)
    const dstHuman = parseFloat(parentOrder.filled_dst_amount)

    if (srcHuman === 0 || dstHuman === 0) {
      throw new Error('Invalid filled amounts: one or both are zero')
    }

    // 3. Calculate execution price in USD
    // We need to determine the USD value of the trade to set counter order price
    const srcPrice = await getCurrentTokenPrice(srcToken.symbol)
    const dstPrice = await getCurrentTokenPrice(dstToken.symbol)

    // Execution price = price of destination token at the time of fill
    // This represents the effective price we paid/received
    let executionPriceUSD: number

    if (isParentBuyOrder) {
      // Buy order: spent src to buy dst
      // Execution price = how much we paid per dst token in USD
      executionPriceUSD = (srcHuman * srcPrice) / dstHuman
    } else {
      // Sell order: sold src for dst
      // Execution price = how much we got per src token in USD
      executionPriceUSD = (dstHuman * dstPrice) / srcHuman
    }

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Execution price calculation: ` +
      `${srcToken.symbol}→${dstToken.symbol}, ` +
      `srcHuman=${srcHuman.toFixed(6)}, dstHuman=${dstHuman.toFixed(6)}, ` +
      `executionPrice=$${executionPriceUSD.toFixed(2)} per ${isParentBuyOrder ? dstToken.symbol : srcToken.symbol}`
    )

    // 4. Determine counter-order direction and price
    // For buy orders: sell at +1% to take profit
    // For sell orders: buy back at -1% to take profit
    const counterPrice = isParentBuyOrder
      ? executionPriceUSD * 1.01 // Buy filled → Sell at +1%
      : executionPriceUSD * 0.99 // Sell filled → Buy at -1%

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Counter-order target price: $${counterPrice.toFixed(2)} (${isParentBuyOrder ? '+1%' : '-1%'})`
    )

    // 5. Use filled amount for counter-order (NOT original amount)
    const counterAmount = dstHuman // What we received from filled order
    const counterAmountStr = counterAmount.toFixed(dstToken.decimals)

    // 6. Validate minimum order value
    const counterValueUSD = counterAmount * dstPrice

    if (counterValueUSD < MIN_ORDER_VALUE_USD) {
      KatanaLogger.warn(PREFIX,
        `[Wallet ${wallet.index}] Counter-order value $${counterValueUSD.toFixed(2)} below $${MIN_ORDER_VALUE_USD} minimum, skipping`
      )

      // Update parent order metadata to indicate counter-order was skipped
      await updateOrderMetadata(parentOrder.order_id, {
        counter_order_skipped: true,
        reason: 'below_minimum',
        value_usd: counterValueUSD
      })

      return
    }

    // 7. Determine fromToken and toToken for counter-order (reverse of parent)
    const fromToken = dstToken // We're selling what we received
    const toToken = srcToken // We're buying back what we spent
    const counterOrderType = isParentBuyOrder ? 'counter_sell' : 'counter_buy'

    // 8. Calculate limit price for counter order
    // Limit price is always expressed as "how much toToken per 1 fromToken"
    // For counter sell (dst → src): we want to get back more src than we spent
    // For counter buy (dst → src): we want to spend less dst than we received
    let limitPrice: number

    if (toToken.symbol === 'USDC') {
      // Selling for USDC: limitPrice = how much USDC per 1 token
      limitPrice = counterPrice
    } else if (fromToken.symbol === 'USDC') {
      // Buying with USDC: limitPrice = how much token per 1 USDC
      limitPrice = 1 / counterPrice
    } else {
      // Neither is USDC: calculate ratio between token prices
      const fromPriceAtCounter = isParentBuyOrder ? counterPrice : dstPrice
      const toPriceAtCounter = isParentBuyOrder ? srcPrice : counterPrice
      limitPrice = toPriceAtCounter / fromPriceAtCounter
    }

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Placing ${counterOrderType}: ${counterAmountStr} ${fromToken.symbol} → ${toToken.symbol} @ limitPrice=${limitPrice.toFixed(8)}`
    )

    // 9. Place counter-order
    await placeOrder({
      wallet,
      executionId,
      fromToken,
      toToken,
      amount: counterAmountStr,
      limitPrice,
      orderType: counterOrderType as any,
      parentOrderId: parentOrder.order_id,
      gridOffset: null // Counter-orders don't have grid offset
    }, testingMode)

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] ✅ Counter-order placed successfully for ${parentOrder.order_id}`
    )
  } catch (error) {
    KatanaLogger.error(PREFIX, 
      `[Wallet ${wallet.index}] Counter-order placement failed for ${parentOrder.order_id}`,
      error
    )

    // Log error to parent order metadata for manual retry
    try {
      await updateOrderMetadata(parentOrder.order_id, {
        counter_order_error: error instanceof Error ? error.message : 'Unknown error',
        counter_order_failed_at: new Date().toISOString()
      })
    } catch (metaError) {
      KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] Failed to update error metadata`, metaError)
    }

    // Don't throw - continue with other orders
  }
}
