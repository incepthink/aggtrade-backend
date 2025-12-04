/**
 * =============================================================================
 * INITIAL ORDER PLACEMENT MODULE
 * =============================================================================
 *
 * This module places initial grid orders (5 buy-sell pairs).
 *
 * KEY REQUIREMENT: Atomic Pair Placement
 * - Each buy order MUST have a corresponding sell order
 * - Both orders are constructed and validated BEFORE sending to blockchain
 * - If either order fails validation, neither is placed
 * - Only after BOTH orders succeed do we increment placed_initial_orders
 *
 * Grid Strategy:
 * - 5 buy orders at: -1%, -1.5%, -2%, -2.5%, -3% below market price
 * - 5 sell orders at: +1%, +1.5%, +2%, +2.5%, +3% above market price
 *
 * Order Sizing Strategy:
 * - Each order size = (wallet token balance / 5) in USD value
 * - Minimum order size: $6 USD (enforced to meet exchange minimums)
 * - Example: $40 USDC balance → 5 buy orders of $8 USDC each
 * - Example: $25 ETH balance → 5 sell orders of $5 ETH each → adjusted to $6 minimum
 *
 * =============================================================================
 */

import { ethers } from 'ethers'
import BotWallet from '../../models/BotWallet'
import BotOrdersSimple from '../../models/BotOrdersSimple'
import { KatanaLogger } from '../../utils/logger'
import { getCurrentTokenPrice } from '../gridBot/priceManager'
import { getToken } from '../gridBot/tokenPairs.config'
import { TwapService } from '../../services/twap'
import { toWei, fromWei, calculateOutputAmount, calculateMinAmountOut, calculateDeadline } from '../utils/botHelpers'
import { getTokenBalance, ensureTokenApproval } from '../utils/botWalletManager'
import { updateWalletBalances, TOKEN_COLUMN_MAPPING } from '../utils/botBalanceUpdater'
import { TEST_MODE_CONFIG } from './index'
import sequelize from '../../utils/db/sequelize'
import { Transaction } from 'sequelize'

const PREFIX = '[PlaceInitialOrders]'

// Grid configuration
const GRID_CONFIG = {
  BUY_OFFSETS: [-1, -1.5, -2, -2.5, -3],  // % below market price
  SELL_OFFSETS: [1, 1.5, 2, 2.5, 3],       // % above market price
  MIN_ORDER_SIZE_USD: 6,                    // Minimum $6 per order
  EXPIRY_HOURS: 168                         // 1 week (168 hours)
}

/**
 * Wallet structure
 */
interface WalletWithSigner {
  address: string
  index: number
  signer: ethers.Wallet
  tradingPool: string
}

/**
 * Order construction result (not yet sent to blockchain)
 */
interface ConstructedOrder {
  orderType: 'grid_buy' | 'grid_sell'
  fromToken: any
  toToken: any
  fromAmount: string          // Human-readable
  fromAmountWei: string      // Wei
  toAmountWei: string        // Wei
  toAmountMin: string        // Wei (with slippage)
  limitPrice: number         // USD
  gridOffset: number         // Percentage
  transaction: any           // Prepared blockchain transaction
}

/**
 * Parse trading pool string to determine base and target tokens
 * Examples: "ETH/USDC" -> base: USDC, target: ETH
 */
function parseTradingPool(tradingPool: string): { baseToken: any; targetToken: any } {
  const [token1, token2] = tradingPool.split('/')

  if (!token1 || !token2) {
    throw new Error(`Invalid trading pool format: ${tradingPool}. Expected format: TOKEN1/TOKEN2`)
  }

  // For simplicity, assume second token is always the base (USDC, ETH)
  // Adjust logic if needed for your specific pairs
  const baseToken = getToken(token2.trim())
  const targetToken = getToken(token1.trim())

  return { baseToken, targetToken }
}

/**
 * Calculate order size based on wallet balance
 * Divides total balance by 5 (number of orders) but ensures minimum $6 USD
 *
 * @param tokenBalance - Available balance in human-readable format
 * @param tokenPrice - Current USD price of the token
 * @returns Order size in token amount (human-readable)
 */
function calculateOrderSize(tokenBalance: string, tokenPrice: number): { orderSize: string; orderSizeUsd: number } {
  const balance = parseFloat(tokenBalance)
  const balanceUsd = balance * tokenPrice

  // Divide by 5 to create 5 orders
  let orderSizeUsd = balanceUsd / 5

  // Ensure minimum $6 per order
  if (orderSizeUsd < GRID_CONFIG.MIN_ORDER_SIZE_USD) {
    KatanaLogger.warn(PREFIX, `Calculated order size $${orderSizeUsd.toFixed(2)} is below minimum $${GRID_CONFIG.MIN_ORDER_SIZE_USD}`)
    orderSizeUsd = GRID_CONFIG.MIN_ORDER_SIZE_USD
  }

  // Convert back to token amount
  const orderSize = (orderSizeUsd / tokenPrice).toFixed(18)

  KatanaLogger.info(PREFIX, `Order sizing: balance=$${balanceUsd.toFixed(2)}, order_size=$${orderSizeUsd.toFixed(2)} (${orderSize} tokens)`)

  return { orderSize, orderSizeUsd }
}

/**
 * Construct a buy or sell order (prepare transaction but don't send yet)
 *
 * This validates balances and prepares the blockchain transaction,
 * but does NOT send it yet. This allows us to validate both orders
 * in a pair before committing to the blockchain.
 */
async function constructOrder(
  wallet: WalletWithSigner,
  orderType: 'grid_buy' | 'grid_sell',
  fromToken: any,
  toToken: any,
  amount: string,        // Human-readable amount
  limitPrice: number,    // USD price
  gridOffset: number     // Percentage offset
): Promise<ConstructedOrder> {
  KatanaLogger.info(PREFIX, `Constructing ${orderType}: ${amount} ${fromToken.symbol} → ${toToken.symbol} @ $${limitPrice.toFixed(2)}`)

  // Step 1: Calculate amounts in wei
  const fromAmountWei = toWei(amount, fromToken.decimals)
  const toAmountWei = calculateOutputAmount(
    fromAmountWei,
    limitPrice,
    fromToken.decimals,
    toToken.decimals
  )
  const toAmountMin = calculateMinAmountOut(toAmountWei, 0.1) // 0.1% slippage
  const deadline = calculateDeadline(GRID_CONFIG.EXPIRY_HOURS)

  KatanaLogger.info(PREFIX, `Amounts: from=${fromAmountWei} wei, to_min=${toAmountMin} wei`)

  // Step 2: Check balance (VALIDATION - will throw if insufficient)
  const balance = await getTokenBalance(
    wallet.signer.provider!,
    fromToken.address,
    wallet.address,
    fromToken.isNative
  )

  const balanceHuman = fromWei(balance.toString(), fromToken.decimals)
  KatanaLogger.info(PREFIX, `Balance check: ${balanceHuman} ${fromToken.symbol} available`)

  if (balance < BigInt(fromAmountWei)) {
    throw new Error(
      `Insufficient ${fromToken.symbol} balance: have ${balanceHuman}, need ${amount}`
    )
  }

  // Step 3: Prepare transaction (but don't send yet)
  const transaction = TwapService.prepareLimitOrder({
    srcToken: fromToken.address as any,
    dstToken: toToken.address as any,
    srcAmount: fromAmountWei,
    dstMinAmount: toAmountMin,
    srcChunkAmount: fromAmountWei, // For limit orders, chunk = total amount
    fillDelay: { unit: 'Minutes', value: 3 },
    deadline: deadline
  })

  KatanaLogger.info(PREFIX, `✅ Order constructed successfully`)

  return {
    orderType,
    fromToken,
    toToken,
    fromAmount: amount,
    fromAmountWei,
    toAmountWei,
    toAmountMin,
    limitPrice,
    gridOffset,
    transaction
  }
}

/**
 * Execute a constructed order (send to blockchain and save to database)
 * In TEST MODE: Simulates order placement without blockchain interaction
 */
async function executeConstructedOrder(
  wallet: WalletWithSigner,
  order: ConstructedOrder
): Promise<void> {
  if (TEST_MODE_CONFIG.enabled) {
    // ===================================================================
    // TEST MODE: SIMULATE ORDER PLACEMENT
    // ===================================================================
    KatanaLogger.info(PREFIX, `[TEST MODE] Simulating ${order.orderType} execution...`)

    // Generate a simulated order ID with better uniqueness guarantee
    const timestamp = Date.now()
    const randomPart = Math.random().toString(36).substr(2, 9)
    const orderTypeSuffix = order.orderType === 'grid_buy' ? '_buy' : '_sell'
    const simulatedOrderId = `TEST_${timestamp}_${randomPart}${orderTypeSuffix}`
    const simulatedTxHash = `0xTEST${timestamp.toString(16)}${randomPart}`

    KatanaLogger.info(PREFIX, `[TEST MODE] Simulated transaction: ${simulatedTxHash}`)
    KatanaLogger.info(PREFIX, `[TEST MODE] Simulated order ID: ${simulatedOrderId}`)

    // Calculate USD value
    const tokenPrice = await getCurrentTokenPrice(order.fromToken.symbol)
    const usdValue = parseFloat(order.fromAmount) * tokenPrice

    // Create simulated order in memory
    const simulatedOrder = {
      id: simulatedOrderId,
      txHash: simulatedTxHash,
      wallet_address: wallet.address.toLowerCase(),
      order_type: order.orderType,
      from_token: order.fromToken.symbol,
      to_token: order.toToken.symbol,
      from_amount: order.fromAmount,
      to_amount: fromWei(order.toAmountMin, order.toToken.decimals),
      status: 'pending',
      progress: 0,
      placed_at: new Date(),
      limit_price: order.limitPrice,
      grid_offset: order.gridOffset
    }

    // Store in memory
    const walletOrders = TEST_MODE_CONFIG.simulatedOrders.get(wallet.address) || []
    walletOrders.push(simulatedOrder)
    TEST_MODE_CONFIG.simulatedOrders.set(wallet.address, walletOrders)

    // Save to database with TEST prefix
    await BotOrdersSimple.create({
      wallet_address: wallet.address.toLowerCase(),
      blockchain_order_id: simulatedOrderId,
      order_type: order.orderType,
      parent_order_id: null,
      from_token: order.fromToken.symbol,
      to_token: order.toToken.symbol,
      from_amount: order.fromAmount,
      to_amount: fromWei(order.toAmountMin, order.toToken.decimals),
      status: 'pending',
      progress: 0,
      placed_at: new Date(),
      filled_at: null,
      last_checked_at: null,
      usd_value: usdValue.toFixed(2)
    })

    KatanaLogger.info(PREFIX, `[TEST MODE] ✅ Simulated order saved to database`)
    return
  }

  // ===================================================================
  // PRODUCTION MODE: REAL BLOCKCHAIN EXECUTION
  // ===================================================================
  KatanaLogger.info(PREFIX, `Executing ${order.orderType} on blockchain...`)

  // Step 1: Approve token if needed (ERC20 only)
  if (!order.fromToken.isNative) {
    KatanaLogger.info(PREFIX, `Checking token approval for ${order.fromToken.symbol}...`)
    const approvalResult = await ensureTokenApproval(
      wallet.signer,
      order.fromToken.address,
      order.transaction.to,
      order.fromAmountWei,
      false // skipIfApproved = false (always check)
    )

    if (approvalResult.needsApproval) {
      KatanaLogger.info(PREFIX, `Token approved: ${approvalResult.txHash}`)
    } else {
      KatanaLogger.info(PREFIX, 'Token already approved')
    }
  }

  // Step 2: Send transaction to blockchain
  KatanaLogger.info(PREFIX, 'Sending transaction...')
  const txResponse = await wallet.signer.sendTransaction(order.transaction)
  KatanaLogger.info(PREFIX, `Transaction sent: ${txResponse.hash}`)

  // Step 3: Wait for confirmation
  const receipt = await txResponse.wait()
  KatanaLogger.info(PREFIX, `Transaction confirmed: block ${receipt?.blockNumber}`)

  // Step 4: Wait for blockchain indexing (important!)
  KatanaLogger.info(PREFIX, 'Waiting 5s for blockchain indexing...')
  await new Promise(resolve => setTimeout(resolve, 5000))

  // Step 5: Fetch blockchain order ID from SDK
  let blockchainOrderId: string | null = null
  try {
    const orders = await TwapService.fetchLimitOrders(wallet.address)
    const newOrder = orders.ALL.find((o: any) => o.txHash === txResponse.hash)
    blockchainOrderId = newOrder?.id?.toString() || null

    if (blockchainOrderId) {
      KatanaLogger.info(PREFIX, `Blockchain order ID fetched: ${blockchainOrderId}`)
    } else {
      KatanaLogger.warn(PREFIX, `Could not fetch blockchain order ID for tx ${txResponse.hash}`)
      // Use transaction hash as fallback
      blockchainOrderId = txResponse.hash
    }
  } catch (fetchError) {
    KatanaLogger.error(PREFIX, 'Failed to fetch blockchain order ID', fetchError)
    blockchainOrderId = txResponse.hash // Fallback to tx hash
  }

  // Step 6: Calculate USD value
  const tokenPrice = await getCurrentTokenPrice(order.fromToken.symbol)
  const usdValue = parseFloat(order.fromAmount) * tokenPrice

  // Step 7: Save to BotOrdersSimple database
  await BotOrdersSimple.create({
    wallet_address: wallet.address.toLowerCase(),
    blockchain_order_id: blockchainOrderId!,
    order_type: order.orderType,
    parent_order_id: null, // Initial orders have no parent
    from_token: order.fromToken.symbol,
    to_token: order.toToken.symbol,
    from_amount: order.fromAmount,
    to_amount: fromWei(order.toAmountMin, order.toToken.decimals), // Expected receive amount
    status: 'pending',
    progress: 0,
    placed_at: new Date(),
    filled_at: null,
    last_checked_at: null,
    usd_value: usdValue.toFixed(2)
  })

  KatanaLogger.info(PREFIX, `✅ Order saved to database`)
}

/**
 * Safely increment placed_initial_orders counter with database-level locking
 *
 * Uses SELECT FOR UPDATE to lock the row and prevent race conditions.
 * This ensures that only one process can read and update the counter at a time.
 *
 * @returns true if increment succeeded, false if pair was already placed by another process
 */
async function incrementPlacedOrdersCounter(
  walletAddress: string,
  expectedValue: number
): Promise<boolean> {
  const transaction = await sequelize.transaction({
    isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED
  })

  try {
    // Step 1: Lock the row for update (prevents other transactions from reading/writing)
    const wallet = await BotWallet.findOne({
      where: { wallet_address: walletAddress.toLowerCase() },
      lock: Transaction.LOCK.UPDATE, // SELECT FOR UPDATE
      transaction
    })

    if (!wallet) {
      await transaction.rollback()
      throw new Error(`Wallet ${walletAddress} not found in database`)
    }

    // Step 2: Check if another process already incremented the counter
    if (wallet.placed_initial_orders > expectedValue) {
      KatanaLogger.warn(PREFIX, `Counter already at ${wallet.placed_initial_orders}, expected ${expectedValue}. Another process placed this pair.`)
      await transaction.rollback()
      return false // Pair already placed by another process
    }

    // Step 3: Check if counter matches expected value (should always be true due to locking)
    if (wallet.placed_initial_orders !== expectedValue) {
      await transaction.rollback()
      throw new Error(
        `Counter mismatch: expected ${expectedValue}, got ${wallet.placed_initial_orders}. Database inconsistency detected.`
      )
    }

    // Step 4: Increment the counter
    wallet.placed_initial_orders = expectedValue + 1
    await wallet.save({ transaction })

    // Step 5: Commit transaction (releases lock)
    await transaction.commit()

    KatanaLogger.info(PREFIX, `✅ Counter incremented: ${expectedValue} → ${expectedValue + 1}`)
    return true

  } catch (error) {
    await transaction.rollback()
    KatanaLogger.error(PREFIX, 'Failed to increment counter', error)
    throw error
  }
}

/**
 * Place a single buy-sell pair atomically
 *
 * ATOMIC GUARANTEE:
 * 1. Construct both buy and sell orders
 * 2. Validate both orders (balance checks, etc.)
 * 3. If BOTH succeed validation, execute them on blockchain
 * 4. If EITHER fails validation, neither is placed
 * 5. Only after BOTH succeed do we increment placed_initial_orders
 */
async function placeOrderPair(
  wallet: WalletWithSigner,
  baseToken: any,
  targetToken: any,
  pairIndex: number,     // 0-4 (which pair this is)
  currentPrice: number,  // Current market price in USD
  baseTokenPrice: number // Base token price in USD (e.g., USDC = $1)
): Promise<boolean> {
  const buyOffset = GRID_CONFIG.BUY_OFFSETS[pairIndex]
  const sellOffset = GRID_CONFIG.SELL_OFFSETS[pairIndex]

  KatanaLogger.info(PREFIX, `\n--- Pair ${pairIndex + 1}/5: BUY at ${buyOffset}%, SELL at ${sellOffset}% ---`)

  try {
    // ===================================================================
    // PHASE 0: FETCH WALLET BALANCES
    // ===================================================================

    KatanaLogger.info(PREFIX, `\n[0/4] Fetching wallet balances...`)

    // Get base token balance (for buy orders)
    const baseTokenBalance = await getTokenBalance(
      wallet.signer.provider!,
      baseToken.address,
      wallet.address,
      baseToken.isNative
    )
    const baseTokenBalanceHuman = fromWei(baseTokenBalance.toString(), baseToken.decimals)

    // Get target token balance (for sell orders)
    const targetTokenBalance = await getTokenBalance(
      wallet.signer.provider!,
      targetToken.address,
      wallet.address,
      targetToken.isNative
    )
    const targetTokenBalanceHuman = fromWei(targetTokenBalance.toString(), targetToken.decimals)

    KatanaLogger.info(PREFIX, `Wallet balances: ${baseTokenBalanceHuman} ${baseToken.symbol}, ${targetTokenBalanceHuman} ${targetToken.symbol}`)

    // Update wallet balances in database after fetching
    await updateWalletBalances(wallet.signer.provider!, wallet.address, TOKEN_COLUMN_MAPPING)

    // ===================================================================
    // PHASE 1: CONSTRUCT BOTH ORDERS (validate but don't execute yet)
    // ===================================================================

    // Buy order: Use base token (USDC) to buy target token (ETH)
    const buyPrice = currentPrice * (1 + buyOffset / 100)
    const { orderSize: buyAmount } = calculateOrderSize(baseTokenBalanceHuman, baseTokenPrice)

    KatanaLogger.info(PREFIX, `\n[1/4] Constructing BUY order...`)
    const buyOrder = await constructOrder(
      wallet,
      'grid_buy',
      baseToken,          // from: USDC
      targetToken,        // to: ETH
      buyAmount,
      1 / buyPrice,       // limit price: how much ETH per 1 USDC
      buyOffset
    )

    // Sell order: Sell target token (ETH) for base token (USDC)
    const sellPrice = currentPrice * (1 + sellOffset / 100)
    const { orderSize: sellAmount } = calculateOrderSize(targetTokenBalanceHuman, currentPrice)

    KatanaLogger.info(PREFIX, `\n[2/4] Constructing SELL order...`)
    const sellOrder = await constructOrder(
      wallet,
      'grid_sell',
      targetToken,        // from: ETH
      baseToken,          // to: USDC
      sellAmount,
      sellPrice,          // limit price: how much USDC per 1 ETH
      sellOffset
    )

    // ===================================================================
    // PHASE 2: BOTH ORDERS VALIDATED - NOW EXECUTE ON BLOCKCHAIN
    // ===================================================================

    KatanaLogger.info(PREFIX, `\n✅ Both orders constructed successfully!`)
    KatanaLogger.info(PREFIX, `Now executing on blockchain...`)

    // Execute buy order
    KatanaLogger.info(PREFIX, `\n[3/4] Executing BUY order...`)
    let buyOrderPlaced = false
    try {
      await executeConstructedOrder(wallet, buyOrder)
      buyOrderPlaced = true
      KatanaLogger.info(PREFIX, `✅ BUY order placed successfully`)
    } catch (buyError) {
      KatanaLogger.error(PREFIX, `❌ BUY order failed`, buyError)
      throw new Error(`BUY order failed: ${buyError}`)
    }

    // Update balances after buy order
    await updateWalletBalances(wallet.signer.provider!, wallet.address, TOKEN_COLUMN_MAPPING)

    // Small delay between orders
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Execute sell order
    KatanaLogger.info(PREFIX, `\n[4/4] Executing SELL order...`)
    try {
      await executeConstructedOrder(wallet, sellOrder)
      KatanaLogger.info(PREFIX, `✅ SELL order placed successfully`)
    } catch (sellError) {
      KatanaLogger.error(PREFIX, `❌ SELL order failed after BUY succeeded`, sellError)
      KatanaLogger.error(PREFIX, `⚠️  CRITICAL: BUY order was placed but SELL failed - manual intervention needed!`)
      throw new Error(`SELL order failed after BUY succeeded: ${sellError}`)
    }

    // Update balances after sell order
    await updateWalletBalances(wallet.signer.provider!, wallet.address, TOKEN_COLUMN_MAPPING)

    KatanaLogger.info(PREFIX, `\n✅ Pair ${pairIndex + 1}/5 placed successfully!`)
    return true

  } catch (error) {
    KatanaLogger.error(PREFIX, `\n❌ Failed to place pair ${pairIndex + 1}/5`, error)
    KatanaLogger.warn(PREFIX, `Pair ${pairIndex + 1} skipped - atomic pair guarantee failed`)
    return false
  }
}

/**
 * Main function: Place initial orders for a wallet
 *
 * Places pairs sequentially until 5 pairs are complete.
 * Increments placed_initial_orders after each successful pair.
 */
export async function placeInitialOrders(
  wallet: WalletWithSigner,
  botWalletRecord: any
): Promise<void> {
  KatanaLogger.info(PREFIX, `\nStarting initial order placement for wallet ${wallet.index}`)

  try {
    // Step 1: Parse trading pool
    const { baseToken, targetToken } = parseTradingPool(botWalletRecord.trading_pool)
    KatanaLogger.info(PREFIX, `Trading pool: ${targetToken.symbol}/${baseToken.symbol}`)

    // Step 2: Get current market prices
    const currentPrice = await getCurrentTokenPrice(targetToken.symbol)
    const baseTokenPrice = await getCurrentTokenPrice(baseToken.symbol)
    KatanaLogger.info(PREFIX, `Current ${targetToken.symbol} price: $${currentPrice}`)
    KatanaLogger.info(PREFIX, `Current ${baseToken.symbol} price: $${baseTokenPrice}`)

    // Step 3: Place remaining pairs
    const startFrom = botWalletRecord.placed_initial_orders // 0-4
    const totalPairs = 5

    KatanaLogger.info(PREFIX, `Starting from pair ${startFrom + 1}/5`)

    for (let i = startFrom; i < totalPairs; i++) {
      // Re-check database to skip pairs already placed by concurrent processes
      // Note: This is an optimization to avoid unnecessary work. The real safety
      // comes from the transaction-based counter increment after successful placement.
      const currentWalletState = await BotWallet.findByAddress(wallet.address)
      if (!currentWalletState) {
        throw new Error(`Wallet ${wallet.address} not found in database!`)
      }

      if (currentWalletState.placed_initial_orders > i) {
        KatanaLogger.warn(PREFIX, `Pair ${i + 1} already placed by another process. Skipping...`)
        continue
      }

      KatanaLogger.info(PREFIX, `\n${'='.repeat(60)}`)
      KatanaLogger.info(PREFIX, `Placing pair ${i + 1}/5...`)
      KatanaLogger.info(PREFIX, `${'='.repeat(60)}`)

      const success = await placeOrderPair(wallet, baseToken, targetToken, i, currentPrice, baseTokenPrice)

      if (success) {
        // Increment placed_initial_orders using database-level locking
        // This prevents race conditions by locking the row during read-modify-write
        const incrementSuccess = await incrementPlacedOrdersCounter(wallet.address, i)

        if (!incrementSuccess) {
          // Another process already placed this pair - skip to next one
          KatanaLogger.warn(PREFIX, `Pair ${i + 1} already placed by another process. Moving to next pair...`)
          continue
        }

        KatanaLogger.info(PREFIX, `Updated placed_initial_orders: ${i + 1}/5`)
      } else {
        KatanaLogger.warn(PREFIX, `Pair ${i + 1} failed - will retry in next cycle`)
        // Don't increment counter - will retry this pair next time
        break
      }

      // Delay between pairs to avoid rate limiting
      if (i < totalPairs - 1) {
        KatanaLogger.info(PREFIX, `Waiting 3 seconds before next pair...`)
        await new Promise(resolve => setTimeout(resolve, 3000))
      }
    }

    // Step 4: Check completion
    const finalCount = await BotWallet.findByAddress(wallet.address)
    if (finalCount && finalCount.placed_initial_orders === 5) {
      KatanaLogger.info(PREFIX, `\n🎉 All 5 pairs placed successfully!`)
    }

  } catch (error) {
    KatanaLogger.error(PREFIX, `Initial order placement failed for wallet ${wallet.index}`, error)
    throw error
  }
}
