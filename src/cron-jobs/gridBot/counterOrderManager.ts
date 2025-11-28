import { BotWallet, OrderStatusUpdate } from './types'
import BotLimitOrder from '../../models/BotLimitOrder'
import { placeOrder } from './orderExecutor'
import { getTokenConfigs } from './gridManager'
import { getCurrentETHPrice } from './priceManager'
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

  for (const update of filledUpdates) {
    try {
      await placeCounterOrder(update, wallet, executionId)
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
  executionId: string
): Promise<void> {
  // 1. Fetch parent order from database
  const parentOrder = await BotLimitOrder.findByPk(update.dbOrderId)

  if (!parentOrder) {
    KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] Parent order not found: ${update.dbOrderId}`)
    return
  }

  KatanaLogger.info(PREFIX, 
    `[Wallet ${wallet.index}] Placing counter-order for filled ${parentOrder.order_type}: ${parentOrder.order_id}`
  )

  try {
    // 2. Calculate execution price (CRITICAL: convert to human-readable first!)
    const srcDecimals = parentOrder.src_token_symbol === 'USDC' ? 6 : 18
    const dstDecimals = parentOrder.dst_token_symbol === 'USDC' ? 6 : 18

    const srcHuman = parseFloat(parentOrder.filled_src_amount)
    const dstHuman = parseFloat(parentOrder.filled_dst_amount)

    if (srcHuman === 0 || dstHuman === 0) {
      throw new Error('Invalid filled amounts: one or both are zero')
    }

    // For ETH/USDC: execution price = USDC / ETH (USD per ETH)
    // Need to determine which token is which
    const isParentBuyOrder = parentOrder.order_type.includes('buy')

    let executionPriceUSD: number

    if (isParentBuyOrder) {
      // Buy order: spent USDC, got ETH
      // execution price = USDC spent / ETH received
      executionPriceUSD = dstHuman / srcHuman
    } else {
      // Sell order: spent ETH, got USDC
      // execution price = USDC received / ETH spent
      executionPriceUSD = dstHuman / srcHuman
    }

    KatanaLogger.info(PREFIX, 
      `[Wallet ${wallet.index}] Execution price: $${executionPriceUSD.toFixed(2)} per ETH`
    )

    // 3. Determine counter-order direction and price
    const counterPrice = isParentBuyOrder
      ? executionPriceUSD * 1.01 // Buy filled → Sell at +1%
      : executionPriceUSD * 0.99 // Sell filled → Buy at -1%

    KatanaLogger.info(PREFIX, 
      `[Wallet ${wallet.index}] Counter-order price: $${counterPrice.toFixed(2)} (${isParentBuyOrder ? '+1%' : '-1%'})`
    )

    // 4. Use filled amount for counter-order (NOT original amount)
    const counterAmount = dstHuman // What we received from filled order
    const counterAmountStr = counterAmount.toFixed(dstDecimals)

    // 5. Validate minimum order value
    const currentETHPrice = await getCurrentETHPrice()
    const counterValueUSD = isParentBuyOrder
      ? counterAmount * currentETHPrice // ETH * price
      : counterAmount // Already USDC

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

    // 6. Get token configs
    const tokens = getTokenConfigs()
    const { ETH, USDC } = tokens

    // Determine fromToken and toToken for counter-order
    const fromToken = isParentBuyOrder ? ETH : USDC
    const toToken = isParentBuyOrder ? USDC : ETH
    const counterOrderType = isParentBuyOrder ? 'counter_sell' : 'counter_buy'

    // Calculate limit price based on order direction
    // For SELL (ETH → USDC): limitPrice = USDC per 1 ETH (use counterPrice as-is)
    // For BUY (USDC → ETH): limitPrice = ETH per 1 USDC (use 1/counterPrice)
    const limitPrice = isParentBuyOrder ? counterPrice : (1 / counterPrice)

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Placing ${counterOrderType}: ${counterAmountStr} ${fromToken.symbol} → ${toToken.symbol} @ $${counterPrice.toFixed(2)}`
    )

    // 7. Place counter-order
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
    })

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
