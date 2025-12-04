/**
 * =============================================================================
 * CHECK COUNTER ORDERS MODULE
 * =============================================================================
 *
 * This module handles checking order status and placing counter orders:
 * 1. Fetch all active orders (pending/partial) for the wallet
 * 2. Poll blockchain via TWAP SDK to get current status
 * 3. Update order status in BotOrdersSimple table
 * 4. For completed orders:
 *    - Add entry to SushiswapActivity table (like a normal user trade)
 *    - Place counter order at ±1% from execution price
 *
 * Counter Order Logic:
 * - If parent was a BUY order → Place SELL counter order at +1%
 * - If parent was a SELL order → Place BUY counter order at -1%
 * - Size: Same as parent order (filled amount)
 *
 * =============================================================================
 */

import { ethers } from 'ethers'
import BotOrdersSimple from '../../models/BotOrdersSimple'
import SushiswapActivity from '../../models/SushiswapActivity'
import User from '../../models/User'
import { KatanaLogger } from '../../utils/logger'
import { TwapService, type TwapOrder } from '../../services/twap'
import { OrderStatus } from '@orbs-network/twap-sdk'
import { TWAP_CONTRACT_ADDRESS } from '../../config/twap'
import { getCurrentTokenPrice } from '../gridBot/priceManager'
import { getToken } from '../gridBot/tokenPairs.config'
import { toWei, fromWei, calculateOutputAmount, calculateMinAmountOut, calculateDeadline } from '../utils/botHelpers'
import { ensureTokenApproval } from '../utils/botWalletManager'
import { updateWalletBalances, TOKEN_COLUMN_MAPPING } from '../utils/botBalanceUpdater'
import { TEST_MODE_CONFIG } from './index'

const PREFIX = '[CheckCounterOrders]'

// Configuration
const COUNTER_ORDER_CONFIG = {
  PROFIT_MARGIN_PERCENT: 1, // ±1% from execution price
  MIN_ORDER_SIZE_USD: 6,     // Minimum $6 per order
  EXPIRY_HOURS: 168,         // 1 week
  CHAIN_ID: 747474           // Katana chain ID
}

/**
 * Wallet structure with ethers signer
 */
interface WalletWithSigner {
  address: string
  index: number
  signer: ethers.Wallet
  tradingPool: string
}

/**
 * Order status update from blockchain
 */
interface OrderStatusUpdate {
  dbOrder: any // BotOrdersSimple instance
  blockchainOrder: TwapOrder
  oldStatus: string
  newStatus: 'pending' | 'partial' | 'filled' | 'expired' | 'canceled'
  progress: number
}

/**
 * Map blockchain order status to database status
 */
function mapBlockchainStatus(
  blockchainStatus: string,
  progress: number
): 'pending' | 'partial' | 'filled' | 'expired' | 'canceled' {
  switch (blockchainStatus) {
    case 'Open':
      return progress > 0 && progress < 100 ? 'partial' : 'pending'
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
 * In TEST MODE: Simulates order status changes
 */
async function pollOrderStatus(
  wallet: WalletWithSigner
): Promise<OrderStatusUpdate[]> {
  const updates: OrderStatusUpdate[] = []

  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Polling order status...`)

  // Step 1: Fetch pending/partial orders from database
  const dbOrders = await BotOrdersSimple.findAll({
    where: {
      wallet_address: wallet.address.toLowerCase(),
      status: ['pending', 'partial']
    },
    order: [['placed_at', 'ASC']]
  })

  if (dbOrders.length === 0) {
    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] No pending orders in database`)
    return updates
  }

  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Found ${dbOrders.length} active orders`)

  if (TEST_MODE_CONFIG.enabled) {
    // ===================================================================
    // TEST MODE: SIMULATE ORDER STATUS UPDATES
    // ===================================================================
    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] [TEST MODE] Simulating order status updates...`)

    // Simulate some orders being filled (30% chance per order)
    for (const dbOrder of dbOrders) {
      const shouldFill = Math.random() < 0.3 // 30% chance to fill

      if (shouldFill) {
        // Get token configurations
        const fromToken = getToken(dbOrder.from_token)
        const toToken = getToken(dbOrder.to_token)

        // Create simulated filled order
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

        KatanaLogger.info(PREFIX,
          `[Wallet ${wallet.index}] [TEST MODE] Simulated fill: ${dbOrder.order_type} order ${dbOrder.id}`
        )

        updates.push({
          dbOrder,
          blockchainOrder: simulatedBlockchainOrder,
          oldStatus: dbOrder.status,
          newStatus: 'filled',
          progress: 100
        })
      }
    }

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] [TEST MODE] Simulated ${updates.length} order fills`
    )

    return updates
  }

  // ===================================================================
  // PRODUCTION MODE: REAL BLOCKCHAIN POLLING
  // ===================================================================

  // Step 2: Fetch all orders from blockchain via TWAP SDK
  let blockchainOrders: any
  try {
    blockchainOrders = await TwapService.fetchLimitOrders(wallet.address)
  } catch (error) {
    KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] Failed to fetch blockchain orders`, error)
    return updates
  }

  KatanaLogger.info(PREFIX,
    `[Wallet ${wallet.index}] Blockchain orders: ${blockchainOrders.OPEN.length} OPEN, ` +
    `${blockchainOrders.COMPLETED.length} COMPLETED, ${blockchainOrders.EXPIRED.length} EXPIRED`
  )

  // Step 3: Match and detect changes
  for (const dbOrder of dbOrders) {
    try {
      // Find blockchain order by blockchain_order_id or tx_hash
      let blockchainOrder: TwapOrder | undefined

      if (dbOrder.blockchain_order_id) {
        blockchainOrder = blockchainOrders.ALL.find(
          (o: TwapOrder) => String(o.id) === String(dbOrder.blockchain_order_id)
        )
      }

      if (!blockchainOrder) {
        KatanaLogger.warn(PREFIX,
          `[Wallet ${wallet.index}] Could not find blockchain order for DB order ${dbOrder.id}`
        )
        continue
      }

      // Step 4: Detect status changes
      const newStatus = mapBlockchainStatus(blockchainOrder.status, blockchainOrder.progress)

      if (newStatus !== dbOrder.status || blockchainOrder.progress !== parseFloat(String(dbOrder.progress))) {
        KatanaLogger.info(PREFIX,
          `[Wallet ${wallet.index}] Status change detected: ` +
          `${dbOrder.order_type} ${dbOrder.status}(${dbOrder.progress}%) -> ${newStatus}(${blockchainOrder.progress}%)`
        )

        updates.push({
          dbOrder,
          blockchainOrder,
          oldStatus: dbOrder.status,
          newStatus,
          progress: blockchainOrder.progress
        })
      }
    } catch (error) {
      KatanaLogger.error(PREFIX,
        `[Wallet ${wallet.index}] Failed to process order ${dbOrder.id}`,
        error
      )
    }
  }

  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Poll complete: ${updates.length} status changes detected`)

  return updates
}

/**
 * Update order status in database
 */
async function updateOrderStatus(update: OrderStatusUpdate): Promise<void> {
  const { dbOrder, blockchainOrder, newStatus, progress } = update

  const updateData: any = {
    status: newStatus,
    progress: progress,
    last_checked_at: new Date()
  }

  // If order is filled, set filled_at timestamp and update amounts
  if (newStatus === 'filled') {
    updateData.filled_at = new Date()
    updateData.from_amount = fromWei(blockchainOrder.filledSrcAmount, dbOrder.from_token === 'WRON' ? 18 : 6)
    updateData.to_amount = fromWei(blockchainOrder.filledDstAmount, dbOrder.to_token === 'WRON' ? 18 : 6)
  }

  await BotOrdersSimple.update(updateData, {
    where: { id: dbOrder.id }
  })

  KatanaLogger.info(PREFIX, `Updated order ${dbOrder.id} status: ${newStatus} (${progress}%)`)
}

/**
 * Add completed order to SushiswapActivity table (treat bot trade as normal user trade)
 */
async function addToSushiswapActivity(
  update: OrderStatusUpdate,
  wallet: WalletWithSigner
): Promise<void> {
  const { dbOrder, blockchainOrder } = update

  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Adding order ${dbOrder.id} to SushiswapActivity...`)

  try {
    // Step 0: Update wallet balances before recording activity
    await updateWalletBalances(wallet.signer.provider!, wallet.address, TOKEN_COLUMN_MAPPING)

    // Step 1: Get or create user
    const { user } = await User.findOrCreateUser(wallet.address.toLowerCase(), COUNTER_ORDER_CONFIG.CHAIN_ID)

    // Step 2: Get token configurations
    const fromToken = getToken(dbOrder.from_token)
    const toToken = getToken(dbOrder.to_token)

    // Step 3: Convert filled amounts to human-readable
    const fromAmountHuman = fromWei(blockchainOrder.filledSrcAmount, fromToken.decimals)
    const toAmountHuman = fromWei(blockchainOrder.filledDstAmount, toToken.decimals)

    // Step 4: Calculate USD volume and execution price
    const fromTokenPrice = await getCurrentTokenPrice(fromToken.symbol)
    const toTokenPrice = await getCurrentTokenPrice(toToken.symbol)

    const usdVolume = parseFloat(fromAmountHuman) * fromTokenPrice
    const executionPrice = (parseFloat(toAmountHuman) * toTokenPrice) / parseFloat(fromAmountHuman)

    // Step 5: Create SushiswapActivity record
    await SushiswapActivity.create({
      user_id: user.id,
      wallet_address: wallet.address.toLowerCase(),
      swap_type: 'LIMIT_ORDER',
      tx_hash: dbOrder.blockchain_order_id, // Use blockchain order ID as tx_hash
      chain_id: COUNTER_ORDER_CONFIG.CHAIN_ID,
      block_number: null,
      block_timestamp: new Date(),
      token_from_address: fromToken.address,
      token_from_symbol: fromToken.symbol,
      token_from_amount: fromAmountHuman,
      token_to_address: toToken.address,
      token_to_symbol: toToken.symbol,
      token_to_amount: toAmountHuman,
      usd_volume: usdVolume,
      execution_price: executionPrice,
      pool_id: null,
      order_id: dbOrder.blockchain_order_id,
      filled_src_amount: fromAmountHuman,
      filled_dst_amount: toAmountHuman,
      is_partial_fill: false,
      progress: 100,
      status: 'success',
      metadata: {
        bot_order_id: dbOrder.id,
        order_type: dbOrder.order_type,
        parent_order_id: dbOrder.parent_order_id
      },
      timestamp: new Date()
    })

    KatanaLogger.info(PREFIX, `✅ Added order ${dbOrder.id} to SushiswapActivity (USD: $${usdVolume.toFixed(2)})`)
  } catch (error) {
    KatanaLogger.error(PREFIX, `Failed to add order ${dbOrder.id} to SushiswapActivity`, error)
    throw error
  }
}

/**
 * Place counter order for a filled parent order
 */
async function placeCounterOrder(
  update: OrderStatusUpdate,
  wallet: WalletWithSigner
): Promise<void> {
  const { dbOrder, blockchainOrder } = update

  // Step 1: Check if counter order already exists (duplicate protection)
  const isParentBuyOrder = dbOrder.order_type.includes('buy')
  const counterOrderType = isParentBuyOrder ? 'counter_sell' : 'counter_buy'

  const existingCounterOrder = await BotOrdersSimple.findOne({
    where: {
      parent_order_id: dbOrder.id,
      order_type: counterOrderType
    }
  })

  if (existingCounterOrder) {
    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Counter order already exists for parent ${dbOrder.id}. Skipping.`
    )
    return
  }

  KatanaLogger.info(PREFIX,
    `[Wallet ${wallet.index}] Placing counter-order for filled ${dbOrder.order_type} order ${dbOrder.id}...`
  )

  try {
    // Step 2: Get token configurations
    const fromToken = getToken(dbOrder.from_token)
    const toToken = getToken(dbOrder.to_token)

    // Step 3: Get filled amounts (what was actually executed)
    const fromAmountHuman = fromWei(blockchainOrder.filledSrcAmount, fromToken.decimals)
    const toAmountHuman = fromWei(blockchainOrder.filledDstAmount, toToken.decimals)

    if (parseFloat(fromAmountHuman) === 0 || parseFloat(toAmountHuman) === 0) {
      throw new Error('Invalid filled amounts: one or both are zero')
    }

    // Step 4: Calculate execution price in USD
    const fromTokenPrice = await getCurrentTokenPrice(fromToken.symbol)
    const toTokenPrice = await getCurrentTokenPrice(toToken.symbol)

    let executionPriceUSD: number

    if (isParentBuyOrder) {
      // Buy order: spent fromToken to buy toToken
      // Execution price = how much we paid per toToken in USD
      executionPriceUSD = (parseFloat(fromAmountHuman) * fromTokenPrice) / parseFloat(toAmountHuman)
    } else {
      // Sell order: sold fromToken for toToken
      // Execution price = how much we got per fromToken in USD
      executionPriceUSD = (parseFloat(toAmountHuman) * toTokenPrice) / parseFloat(fromAmountHuman)
    }

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Execution price: $${executionPriceUSD.toFixed(6)} per ${isParentBuyOrder ? toToken.symbol : fromToken.symbol}`
    )

    // Step 5: Calculate counter-order price (±1% from execution price)
    const counterPrice = isParentBuyOrder
      ? executionPriceUSD * (1 + COUNTER_ORDER_CONFIG.PROFIT_MARGIN_PERCENT / 100) // Buy filled → Sell at +1%
      : executionPriceUSD * (1 - COUNTER_ORDER_CONFIG.PROFIT_MARGIN_PERCENT / 100) // Sell filled → Buy at -1%

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Counter-order target price: $${counterPrice.toFixed(6)} (${isParentBuyOrder ? '+' : '-'}${COUNTER_ORDER_CONFIG.PROFIT_MARGIN_PERCENT}%)`
    )

    // Step 6: Use filled amount for counter-order (what we received)
    const counterAmount = toAmountHuman
    const counterAmountFloat = parseFloat(counterAmount)

    // Step 7: Validate minimum order value
    const counterValueUSD = counterAmountFloat * toTokenPrice

    if (counterValueUSD < COUNTER_ORDER_CONFIG.MIN_ORDER_SIZE_USD) {
      KatanaLogger.warn(PREFIX,
        `[Wallet ${wallet.index}] Counter-order value $${counterValueUSD.toFixed(2)} below $${COUNTER_ORDER_CONFIG.MIN_ORDER_SIZE_USD} minimum, skipping`
      )
      return
    }

    // Step 8: Determine fromToken and toToken for counter-order (reverse of parent)
    const counterFromToken = toToken // We're selling what we received
    const counterToToken = fromToken // We're buying back what we spent

    // Step 9: Calculate limit price for counter order
    // Limit price is always expressed as "how much toToken per 1 fromToken"
    let limitPrice: number

    if (counterToToken.symbol === 'USDC') {
      // Selling for USDC: limitPrice = how much USDC per 1 token
      limitPrice = counterPrice
    } else if (counterFromToken.symbol === 'USDC') {
      // Buying with USDC: limitPrice = how much token per 1 USDC
      limitPrice = 1 / counterPrice
    } else {
      // Neither is USDC: calculate ratio between token prices
      const fromPriceAtCounter = isParentBuyOrder ? counterPrice : toTokenPrice
      const toPriceAtCounter = isParentBuyOrder ? fromTokenPrice : counterPrice
      limitPrice = toPriceAtCounter / fromPriceAtCounter
    }

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Placing ${counterOrderType}: ${counterAmount} ${counterFromToken.symbol} → ${counterToToken.symbol} @ limitPrice=${limitPrice.toFixed(8)}`
    )

    // Step 10: Calculate amounts in wei
    const fromAmountWei = toWei(counterAmount, counterFromToken.decimals)
    const toAmountWei = calculateOutputAmount(
      fromAmountWei,
      limitPrice,
      counterFromToken.decimals,
      counterToToken.decimals
    )
    const toAmountMin = calculateMinAmountOut(toAmountWei, 0.1) // 0.1% slippage
    const deadline = calculateDeadline(COUNTER_ORDER_CONFIG.EXPIRY_HOURS)

    if (TEST_MODE_CONFIG.enabled) {
      // ===================================================================
      // TEST MODE: SIMULATE COUNTER ORDER PLACEMENT
      // ===================================================================
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] [TEST MODE] Simulating counter-order placement...`)

      // Generate simulated order ID
      const simulatedOrderId = `TEST_COUNTER_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      const simulatedTxHash = `0xTEST${Math.random().toString(36).substr(2, 40)}`

      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] [TEST MODE] Simulated counter-order: ${simulatedOrderId}`)

      // Calculate USD value
      const usdValue = counterAmountFloat * toTokenPrice

      // Save to database
      await BotOrdersSimple.create({
        wallet_address: wallet.address.toLowerCase(),
        blockchain_order_id: simulatedOrderId,
        order_type: counterOrderType as any,
        parent_order_id: dbOrder.id,
        from_token: counterFromToken.symbol,
        to_token: counterToToken.symbol,
        from_amount: counterAmount,
        to_amount: fromWei(toAmountMin, counterToToken.decimals),
        status: 'pending',
        progress: 0,
        placed_at: new Date(),
        filled_at: null,
        last_checked_at: null,
        usd_value: usdValue.toFixed(2)
      })

      KatanaLogger.info(PREFIX,
        `[Wallet ${wallet.index}] [TEST MODE] ✅ Simulated counter-order saved for parent order ${dbOrder.id}`
      )

    } else {
      // ===================================================================
      // PRODUCTION MODE: REAL COUNTER ORDER PLACEMENT
      // ===================================================================

      // Step 11: Approve token if needed (ERC20 only)
      if (!counterFromToken.isNative) {
        KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Checking token approval for ${counterFromToken.symbol}...`)

        const approvalResult = await ensureTokenApproval(
          wallet.signer,
          counterFromToken.address,
          TWAP_CONTRACT_ADDRESS,
          fromAmountWei,
          false // skipIfApproved = false (always check)
        )

        if (approvalResult.needsApproval) {
          KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Token approved: ${approvalResult.txHash}`)
        } else {
          KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Token already approved`)
        }
      }

      // Step 12: Prepare and send transaction
      const transaction = TwapService.prepareLimitOrder({
        srcToken: counterFromToken.address as any,
        dstToken: counterToToken.address as any,
        srcAmount: fromAmountWei,
        dstMinAmount: toAmountMin,
        srcChunkAmount: fromAmountWei, // For limit orders, chunk = total amount
        fillDelay: { unit: 'Minutes', value: 3 },
        deadline: deadline
      })

      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Sending counter-order transaction...`)
      const txResponse = await wallet.signer.sendTransaction(transaction)
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Transaction sent: ${txResponse.hash}`)

      // Step 13: Wait for confirmation
      const receipt = await txResponse.wait()
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Transaction confirmed: block ${receipt?.blockNumber}`)

      // Step 14: Wait for blockchain indexing
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Waiting 5s for blockchain indexing...`)
      await new Promise(resolve => setTimeout(resolve, 5000))

      // Step 15: Fetch blockchain order ID
      let blockchainOrderId: string | null = null
      try {
        const orders = await TwapService.fetchLimitOrders(wallet.address)
        const newOrder = orders.ALL.find((o: any) => o.txHash === txResponse.hash)
        blockchainOrderId = newOrder?.id?.toString() || null

        if (blockchainOrderId) {
          KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Blockchain order ID fetched: ${blockchainOrderId}`)
        } else {
          KatanaLogger.warn(PREFIX, `[Wallet ${wallet.index}] Could not fetch blockchain order ID, using tx hash`)
          blockchainOrderId = txResponse.hash
        }
      } catch (fetchError) {
        KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] Failed to fetch blockchain order ID`, fetchError)
        blockchainOrderId = txResponse.hash
      }

      // Step 16: Calculate USD value
      const usdValue = counterAmountFloat * toTokenPrice

      // Step 17: Save counter order to database
      await BotOrdersSimple.create({
        wallet_address: wallet.address.toLowerCase(),
        blockchain_order_id: blockchainOrderId!,
        order_type: counterOrderType as any,
        parent_order_id: dbOrder.id, // Link to parent order
        from_token: counterFromToken.symbol,
        to_token: counterToToken.symbol,
        from_amount: counterAmount,
        to_amount: fromWei(toAmountMin, counterToToken.decimals),
        status: 'pending',
        progress: 0,
        placed_at: new Date(),
        filled_at: null,
        last_checked_at: null,
        usd_value: usdValue.toFixed(2)
      })

      KatanaLogger.info(PREFIX,
        `[Wallet ${wallet.index}] ✅ Counter-order placed successfully for parent order ${dbOrder.id}`
      )
    }

    // Update wallet balances after placing counter order
    await updateWalletBalances(wallet.signer.provider!, wallet.address, TOKEN_COLUMN_MAPPING)

  } catch (error) {
    KatanaLogger.error(PREFIX,
      `[Wallet ${wallet.index}] Counter-order placement failed for order ${dbOrder.id}`,
      error
    )
    // Don't throw - continue with other orders
  }
}

/**
 * Main function: Check orders and place counter orders for a wallet
 */
export async function checkCounterOrders(
  wallet: WalletWithSigner,
  botWalletRecord: any
): Promise<void> {
  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Checking orders for counter-order placement...`)

  try {
    // Step 1: Poll blockchain for order status updates
    const updates = await pollOrderStatus(wallet)

    if (updates.length === 0) {
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] No status changes detected`)
      return
    }

    // Step 2: Process each status update
    for (const update of updates) {
      try {
        // Step 2a: Update order status in database
        await updateOrderStatus(update)

        // Step 2b: If order is filled, process it
        if (update.newStatus === 'filled') {
          KatanaLogger.info(PREFIX,
            `[Wallet ${wallet.index}] Order ${update.dbOrder.id} is filled! Processing...`
          )

          // Step 2b-i: Add to SushiswapActivity table
          await addToSushiswapActivity(update, wallet)

          // Step 2b-ii: Place counter order
          await placeCounterOrder(update, wallet)
        }
      } catch (error) {
        KatanaLogger.error(PREFIX,
          `[Wallet ${wallet.index}] Failed to process update for order ${update.dbOrder.id}`,
          error
        )
        // Continue with next update
      }
    }

    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] ✅ Counter order check complete`)
  } catch (error) {
    KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] checkCounterOrders failed`, error)
    throw error
  }
}
