/**
 * LIMIT ORDER BOT CRON JOB
 *
 * This bot creates limit orders on Katana using the exact same flow as the frontend.
 * It uses wallet private keys from environment variables (WALLET_1, WALLET_2, etc.)
 * and integrates with the tracking API to log all activities.
 *
 * Chain: Katana (747474)
 * Supported Tokens: ETH and USDC
 */

import cron from 'node-cron'
import { ethers } from 'ethers'
import { loadBotWallets, ensureTokenApproval, getTokenBalance, type BotWallet } from './utils/botWalletManager'
import {
  toWei,
  fromWei,
  calculateOutputAmount,
  calculateMinAmountOut,
  calculateChunkAmount,
  calculateDeadline,
  generateExecutionId,
  sleep,
  isNativeToken,
  calculateUSDVolume
} from './utils/botHelpers'

// Import services and models directly
import { TwapService } from '../services/twap'
import BotExecution from '../models/BotExecution'
import BotWalletExecution from '../models/BotWalletExecution'
import BotLimitOrder from '../models/BotLimitOrder'

// ============================================================================
// CONSTANTS
// ============================================================================

const CHAIN_ID = 747474
const RPC_URL = 'https://rpc.katana.network'

// Token configurations on Katana
const TOKENS = {
  ETH: {
    address: '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62', // WETH on Katana
    decimals: 18,
    symbol: 'ETH',
    name: 'Wrapped Ether'
  },
  USDC: {
    address: '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36',
    decimals: 6,
    symbol: 'USDC',
    name: 'Vault Bridge USDC'
  }
} as const

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface LimitOrderParams {
  fromToken: 'ETH' | 'USDC'
  toToken: 'ETH' | 'USDC'
  fromAmount: string // Human-readable amount (e.g., "1.5")
  limitPrice: number // Price in toToken per fromToken
  fillDelayMinutes: number
  expiryHours: number
  // Note: chunks is ALWAYS 1 for limit orders (hardcoded, matching frontend behavior)
}

interface PrepareLimitOrderRequest {
  srcToken: string
  dstToken: string
  srcAmount: string
  dstMinAmount: string
  srcChunkAmount: string
  deadline: number
  fillDelay: {
    unit: 'Seconds' | 'Minutes' | 'Hours' | 'Days'
    value: number
  }
}

interface PrepareLimitOrderResponse {
  message: string
  data: {
    to: string // TWAP contract address
    data: string // Encoded transaction data
    value: string // Native value to send
  }
}

interface BotExecutionResult {
  success: boolean
  executionId: string
  wallet: {
    index: number
    address: string
  }
  order?: {
    txHash: string
    blockNumber: number
    orderId: string
    fromToken: string
    toToken: string
    fromAmount: string
    expectedToAmount: string
    limitPrice: number
  }
  error?: string
}

// ============================================================================
// DIRECT SERVICE & MODEL FUNCTIONS
// ============================================================================

/**
 * Prepare limit order transaction using TwapService directly
 */
async function prepareLimitOrder(request: PrepareLimitOrderRequest) {
  const transaction = TwapService.prepareLimitOrder({
    srcToken: request.srcToken as any,
    dstToken: request.dstToken as any,
    srcAmount: request.srcAmount,
    dstMinAmount: request.dstMinAmount,
    srcChunkAmount: request.srcChunkAmount,
    deadline: request.deadline,
    fillDelay: request.fillDelay
  })

  return {
    to: transaction.to,
    data: transaction.data,
    value: transaction.value
  }
}

/**
 * Start bot execution tracking using model directly
 */
async function startBotExecution(executionId: string, strategyName: string, totalWallets: number) {
  // Check if execution already exists
  const existing = await BotExecution.findOne({ where: { execution_id: executionId } })
  if (existing) {
    console.warn(`[Tracking] Execution ${executionId} already exists`)
    return existing
  }

  // Create execution
  return await BotExecution.create({
    execution_id: executionId,
    strategy_name: strategyName,
    total_wallets: totalWallets,
    completed_wallets: 0,
    failed_wallets: 0,
    total_volume_usd: 0,
    start_time: new Date(),
    end_time: null,
    status: 'running'
  })
}

/**
 * Start wallet execution tracking using model directly
 */
async function startWalletExecution(executionId: string, walletIndex: number, walletAddress: string) {
  // Check if execution exists
  const execution = await BotExecution.findOne({ where: { execution_id: executionId } })
  if (!execution) {
    throw new Error(`Execution ${executionId} not found`)
  }

  // Find or create wallet execution
  const [walletExecution, created] = await BotWalletExecution.findOrCreate({
    where: {
      execution_id: executionId,
      wallet_index: walletIndex
    },
    defaults: {
      execution_id: executionId,
      wallet_index: walletIndex,
      wallet_address: walletAddress.toLowerCase(),
      tokens: [],
      swaps_completed: 0,
      total_volume_usd: 0,
      status: 'running',
      error_message: null,
      start_time: new Date(),
      end_time: null
    }
  })

  // If already exists, just update to running
  if (!created) {
    await walletExecution.update({
      status: 'running',
      start_time: new Date()
    })
  }

  return walletExecution
}

/**
 * Complete wallet execution tracking using model directly
 */
async function completeWalletExecution(
  executionId: string,
  walletIndex: number,
  status: 'completed' | 'failed',
  data: {
    wallet_address: string
    swaps_completed: number
    total_volume_usd: number
    limit_orders_placed: number
    limit_orders_filled: number
    tokens?: string[]
    error_message?: string
  }
) {
  const walletExecution = await BotWalletExecution.findOne({
    where: {
      execution_id: executionId,
      wallet_index: walletIndex
    }
  })

  if (!walletExecution) {
    throw new Error(`Wallet execution not found: ${executionId} / ${walletIndex}`)
  }

  // Prepare update data
  const updateData: any = {
    status,
    error_message: data.error_message || null,
    end_time: new Date(),
    swaps_completed: data.swaps_completed,
    total_volume_usd: data.total_volume_usd,
    limit_orders_placed: data.limit_orders_placed || 0,
    limit_orders_filled: data.limit_orders_filled || 0
  }

  // Update wallet_address if provided
  if (data.wallet_address) {
    updateData.wallet_address = data.wallet_address.toLowerCase()
  }

  // Update tokens array if provided
  if (data.tokens && Array.isArray(data.tokens)) {
    updateData.tokens = data.tokens.map((token: string) => token.toUpperCase())
  }

  // Update wallet execution
  await walletExecution.update(updateData)

  // Update main execution counters
  const execution = await BotExecution.findOne({ where: { execution_id: executionId } })
  if (execution) {
    const updatedCounts = await BotWalletExecution.findOne({
      attributes: [
        [BotWalletExecution.sequelize!.fn('SUM', BotWalletExecution.sequelize!.literal("CASE WHEN status = 'completed' THEN 1 ELSE 0 END")), 'completed'],
        [BotWalletExecution.sequelize!.fn('SUM', BotWalletExecution.sequelize!.literal("CASE WHEN status = 'failed' THEN 1 ELSE 0 END")), 'failed'],
        [BotWalletExecution.sequelize!.fn('SUM', BotWalletExecution.sequelize!.col('total_volume_usd')), 'total_volume']
      ],
      where: { execution_id: executionId },
      raw: true
    })

    const completed = (updatedCounts as any)?.completed || 0
    const failed = (updatedCounts as any)?.failed || 0
    const total_volume_usd = (updatedCounts as any)?.total_volume || 0

    // Check if all wallets are done
    const allDone = (completed + failed) >= execution.total_wallets

    await execution.update({
      completed_wallets: completed,
      failed_wallets: failed,
      total_volume_usd,
      status: allDone ? (failed > 0 ? 'failed' : 'completed') : 'running',
      end_time: allDone ? new Date() : null
    })
  }

  return walletExecution
}

/**
 * Log limit order placement using model directly
 */
async function logLimitOrderPlacement(data: {
  execution_id: string
  wallet_index: number
  wallet_address: string
  order_id: string
  tx_hash: string
  chain_id: number
  src_token_address: string
  src_token_symbol: string
  src_amount: string
  dst_token_address: string
  dst_token_symbol: string
  dst_min_amount: string
  deadline: number
}) {
  // Verify execution exists
  const execution = await BotExecution.findOne({
    where: { execution_id: data.execution_id }
  })

  if (!execution) {
    throw new Error(`Execution not found: ${data.execution_id}`)
  }

  // Create limit order record
  const limitOrder = await BotLimitOrder.create({
    execution_id: data.execution_id,
    wallet_index: data.wallet_index,
    wallet_address: data.wallet_address.toLowerCase(),
    order_id: String(data.order_id),
    blockchain_order_id: null,
    parent_order_id: null,
    order_type: data.wallet_index === 1 ? 'counter_buy' : 'counter_sell', // Infer from wallet index
    grid_offset_percent: null,
    tx_hash: data.tx_hash,
    chain_id: data.chain_id || 747474,
    src_token_address: data.src_token_address.toLowerCase(),
    src_token_symbol: data.src_token_symbol,
    src_amount: String(data.src_amount),
    dst_token_address: data.dst_token_address.toLowerCase(),
    dst_token_symbol: data.dst_token_symbol,
    dst_min_amount: String(data.dst_min_amount),
    execution_price: null,
    filled_src_amount: '0',
    filled_dst_amount: '0',
    progress: 0,
    usd_volume: 0,
    status: 'pending',
    placed_at: new Date(),
    filled_at: null,
    deadline: data.deadline || null,
    metadata: null
  })

  return limitOrder
}

/**
 * Get token prices (mock for now - replace with your actual price service)
 */
async function getTokenPrices(): Promise<Record<string, number>> {
  // TODO: Replace with actual price fetching from your price service
  // Example: import { PriceService } from '../services/price'
  //          return await PriceService.getPrices(['ETH', 'USDC'])

  return {
    [TOKENS.ETH.address.toLowerCase()]: 2000, // $2000 per ETH
    [TOKENS.USDC.address.toLowerCase()]: 1     // $1 per USDC
  }
}

// ============================================================================
// CORE BOT LOGIC
// ============================================================================

/**
 * Create a single limit order for one wallet
 * This mimics the EXACT flow from the frontend code you provided
 */
async function createLimitOrder(
  params: LimitOrderParams,
  wallet: BotWallet,
  provider: ethers.Provider,
  executionId: string
): Promise<BotExecutionResult> {

  console.log(`\n${'='.repeat(80)}`)
  console.log(`[Limit Order Bot] Wallet ${wallet.index} (${wallet.address})`)
  console.log(`${'='.repeat(80)}`)

  try {
    // ========================================================================
    // STEP 1: Get token configurations
    // ========================================================================

    const fromToken = TOKENS[params.fromToken]
    const toToken = TOKENS[params.toToken]

    console.log(`\n[Trade] ${fromToken.symbol} → ${toToken.symbol}`)
    console.log(`[Amount] ${params.fromAmount} ${fromToken.symbol}`)
    console.log(`[Limit Price] 1 ${fromToken.symbol} = ${params.limitPrice} ${toToken.symbol}`)

    // ========================================================================
    // STEP 2: Calculate amounts (mimics derivedstate-twap-provider.tsx)
    // ========================================================================

    console.log('\n[Calculations] Computing trade amounts...')

    // IMPORTANT: Chunks must ALWAYS be 1 for limit orders (matching frontend behavior)
    // This ensures the order is a true limit order, not a DCA order
    const chunks = 1

    const srcAmountWei = toWei(params.fromAmount, fromToken.decimals)
    console.log(`  Source amount: ${srcAmountWei} wei (${params.fromAmount} ${fromToken.symbol})`)

    const expectedOutputWei = calculateOutputAmount(
      params.fromAmount,
      params.limitPrice,
      fromToken.decimals,
      toToken.decimals
    )
    console.log(`  Expected output: ${expectedOutputWei} wei (${fromWei(expectedOutputWei, toToken.decimals)} ${toToken.symbol})`)

    const dstMinAmountWei = calculateMinAmountOut(expectedOutputWei, 0.1)
    console.log(`  Min output (0.1% slippage): ${dstMinAmountWei} wei (${fromWei(dstMinAmountWei, toToken.decimals)} ${toToken.symbol})`)

    // For limit orders: srcChunkAmount = srcAmount (because chunks = 1)
    const srcChunkAmountWei = srcAmountWei
    console.log(`  Chunk amount: ${srcChunkAmountWei} wei (${fromWei(srcChunkAmountWei, fromToken.decimals)} ${fromToken.symbol})`)
    console.log(`  Total chunks: ${chunks} (hardcoded for limit orders)`)

    const deadline = calculateDeadline(params.expiryHours)
    console.log(`  Deadline: ${new Date(deadline * 1000).toISOString()} (${params.expiryHours}h from now)`)

    // ========================================================================
    // STEP 3: Check wallet balance
    // ========================================================================

    console.log('\n[Balance] Checking wallet balance...')
    // WETH is NOT native ETH - it's an ERC20 token, so never pass true for isNative
    const balance = await getTokenBalance(
      provider,
      fromToken.address,
      wallet.address,
      false // WETH is ERC20, not native
    )
    const balanceHuman = fromWei(balance.toString(), fromToken.decimals)
    console.log(`  Balance: ${balanceHuman} ${fromToken.symbol}`)

    if (balance < BigInt(srcAmountWei)) {
      throw new Error(
        `Insufficient balance! Required: ${params.fromAmount} ${fromToken.symbol}, Available: ${balanceHuman} ${fromToken.symbol}`
      )
    }

    // ========================================================================
    // STEP 4: Prepare limit order via backend API
    // ========================================================================

    console.log('\n[API] Calling backend to prepare limit order...')

    const apiRequest: PrepareLimitOrderRequest = {
      srcToken: fromToken.address,
      dstToken: toToken.address,
      srcAmount: srcAmountWei,
      dstMinAmount: dstMinAmountWei,
      srcChunkAmount: srcChunkAmountWei,
      deadline: deadline,
      fillDelay: {
        unit: 'Minutes',
        value: params.fillDelayMinutes
      }
    }

    const apiResponse = await prepareLimitOrder(apiRequest)
    const twapContractAddress = apiResponse.to

    console.log(`  TWAP Contract: ${twapContractAddress}`)
    console.log(`  Transaction data: ${apiResponse.data.length} bytes`)

    // ========================================================================
    // STEP 5: Check and approve token if needed
    // ========================================================================

    if (!isNativeToken(fromToken.address)) {
      console.log(`\n[Approval] Checking ${fromToken.symbol} approval...`)

      const approvalResult = await ensureTokenApproval(
        wallet.signer,
        fromToken.address,
        twapContractAddress,
        srcAmountWei,
        false
      )

      if (approvalResult.needsApproval) {
        console.log(`  ✓ Approval granted: ${approvalResult.txHash}`)
      } else {
        console.log('  ✓ Sufficient allowance already exists')
      }
    } else {
      console.log('\n[Approval] Native ETH - no approval needed')
    }

    // ========================================================================
    // STEP 6: Sign and send limit order transaction
    // ========================================================================

    console.log('\n[Transaction] Signing and sending limit order...')

    const transaction = {
      to: apiResponse.to,
      data: apiResponse.data,
      value: BigInt(apiResponse.value || '0'),
      chainId: CHAIN_ID
    }

    const txResponse = await wallet.signer.sendTransaction(transaction)
    console.log(`  ✓ Transaction sent: ${txResponse.hash}`)

    console.log('  ⏳ Waiting for confirmation...')
    const receipt = await txResponse.wait()

    console.log(`\n${'='.repeat(80)}`)
    console.log('✅ LIMIT ORDER CREATED SUCCESSFULLY')
    console.log(`${'='.repeat(80)}`)
    console.log(`  Block: ${receipt?.blockNumber}`)
    console.log(`  Gas used: ${receipt?.gasUsed.toString()}`)
    console.log(`  Tx hash: ${receipt?.hash}`)
    console.log(`${'='.repeat(80)}\n`)

    // ========================================================================
    // STEP 7: Log to tracking API
    // ========================================================================

    const orderId = txResponse.hash // Use tx hash as order ID for now

    // Convert wei values to decimal-normalized values for database storage
    const srcAmountDecimal = fromWei(srcAmountWei, fromToken.decimals)
    const dstMinAmountDecimal = fromWei(dstMinAmountWei, toToken.decimals)

    await logLimitOrderPlacement({
      execution_id: executionId,
      wallet_index: wallet.index,
      wallet_address: wallet.address,
      order_id: orderId,
      tx_hash: txResponse.hash,
      chain_id: CHAIN_ID,
      src_token_address: fromToken.address,
      src_token_symbol: fromToken.symbol,
      src_amount: srcAmountDecimal,
      dst_token_address: toToken.address,
      dst_token_symbol: toToken.symbol,
      dst_min_amount: dstMinAmountDecimal,
      deadline: deadline
    })

    console.log('[Tracking] Order logged to tracking API')

    // ========================================================================
    // STEP 8: Return result
    // ========================================================================

    return {
      success: true,
      executionId,
      wallet: {
        index: wallet.index,
        address: wallet.address
      },
      order: {
        txHash: txResponse.hash,
        blockNumber: receipt?.blockNumber || 0,
        orderId,
        fromToken: fromToken.symbol,
        toToken: toToken.symbol,
        fromAmount: params.fromAmount,
        expectedToAmount: fromWei(expectedOutputWei, toToken.decimals),
        limitPrice: params.limitPrice
      }
    }

  } catch (error: any) {
    console.error(`\n❌ Error creating limit order for wallet ${wallet.index}:`, error.message)

    return {
      success: false,
      executionId,
      wallet: {
        index: wallet.index,
        address: wallet.address
      },
      error: error.message
    }
  }
}

/**
 * Execute limit order bot with different params for each wallet
 */
async function executeLimitOrderBotWithWalletOrders(
  walletOrders: LimitOrderParams[],
  strategyName: string = 'limit_order_bot'
): Promise<void> {

  const executionId = generateExecutionId()

  console.log('\n')
  console.log('╔' + '═'.repeat(78) + '╗')
  console.log('║' + ' '.repeat(20) + 'LIMIT ORDER BOT EXECUTION' + ' '.repeat(33) + '║')
  console.log('╚' + '═'.repeat(78) + '╝')
  console.log(`\n[Execution ID] ${executionId}`)
  console.log(`[Strategy] ${strategyName}`)
  console.log(`[Started] ${new Date().toISOString()}\n`)

  try {
    // ========================================================================
    // STEP 1: Initialize provider and load wallets
    // ========================================================================

    console.log('[Setup] Initializing provider and wallets...')
    const provider = new ethers.JsonRpcProvider(RPC_URL)
    const wallets = loadBotWallets(provider)

    if (wallets.length === 0) {
      throw new Error('No bot wallets configured! Add WALLET_1, WALLET_2, etc. to .env')
    }

    if (walletOrders.length > wallets.length) {
      throw new Error(`Not enough wallets! Have ${wallets.length} wallets but ${walletOrders.length} orders`)
    }

    // ========================================================================
    // STEP 2: Start execution tracking
    // ========================================================================

    console.log(`\n[Tracking] Starting execution tracking for ${wallets.length} wallets...`)
    await startBotExecution(executionId, strategyName, wallets.length)

    // ========================================================================
    // STEP 3: Execute orders for each wallet with specific params
    // ========================================================================

    const results: BotExecutionResult[] = []

    for (let i = 0; i < walletOrders.length; i++) {
      const wallet = wallets[i]
      const orderParams = walletOrders[i]

      // Start wallet tracking
      await startWalletExecution(executionId, wallet.index, wallet.address)

      // Create limit order with wallet-specific params
      const result = await createLimitOrder(orderParams, wallet, provider, executionId)
      results.push(result)

      // Get prices for USD volume calculation
      const prices = await getTokenPrices()
      const fromToken = TOKENS[orderParams.fromToken]
      const usdVolume = result.success
        ? await calculateUSDVolume(
            fromToken.address,
            toWei(orderParams.fromAmount, fromToken.decimals),
            fromToken.decimals,
            prices
          )
        : 0

      // Complete wallet tracking
      await completeWalletExecution(
        executionId,
        wallet.index,
        result.success ? 'completed' : 'failed',
        {
          wallet_address: wallet.address,
          swaps_completed: 0, // Limit orders don't execute immediately
          total_volume_usd: usdVolume,
          limit_orders_placed: result.success ? 1 : 0,
          limit_orders_filled: 0, // Will be updated later when order fills
          tokens: [orderParams.fromToken, orderParams.toToken],
          error_message: result.error
        }
      )

      // Small delay between wallets to avoid RPC rate limits
      if (i < walletOrders.length - 1) {
        await sleep(2000)
      }
    }

    // ========================================================================
    // STEP 4: Print summary
    // ========================================================================

    console.log('\n')
    console.log('╔' + '═'.repeat(78) + '╗')
    console.log('║' + ' '.repeat(28) + 'EXECUTION SUMMARY' + ' '.repeat(33) + '║')
    console.log('╚' + '═'.repeat(78) + '╝\n')

    const successCount = results.filter(r => r.success).length
    const failCount = results.filter(r => !r.success).length

    console.log(`Total wallets: ${walletOrders.length}`)
    console.log(`Successful: ${successCount}`)
    console.log(`Failed: ${failCount}`)
    console.log(`\nExecution ID: ${executionId}`)
    console.log(`Completed: ${new Date().toISOString()}\n`)

    if (successCount > 0) {
      console.log('✅ Successful orders:')
      results.filter(r => r.success).forEach(r => {
        console.log(`  • Wallet ${r.wallet.index}: ${r.order?.txHash}`)
      })
      console.log('')
    }

    if (failCount > 0) {
      console.log('❌ Failed orders:')
      results.filter(r => !r.success).forEach(r => {
        console.log(`  • Wallet ${r.wallet.index}: ${r.error}`)
      })
      console.log('')
    }

  } catch (error: any) {
    console.error('\n❌ FATAL ERROR:', error.message)
    throw error
  }
}

/**
 * Execute limit order bot for all configured wallets (with same params)
 */
async function executeLimitOrderBot(
  orderParams: LimitOrderParams,
  strategyName: string = 'limit_order_bot'
): Promise<void> {
  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const wallets = loadBotWallets(provider)

  // Create same order params for all wallets
  const walletOrders = wallets.map(() => orderParams)

  await executeLimitOrderBotWithWalletOrders(walletOrders, strategyName)
}

// ============================================================================
// CRON JOB CONFIGURATION
// ============================================================================

/**
 * Manual trigger for testing
 */
export async function triggerLimitOrderBotManually(params: LimitOrderParams): Promise<void> {
  console.log('[Limit Order Bot] Manual trigger initiated')
  await executeLimitOrderBot(params, 'manual_limit_order')
}

/**
 * Start cron job (currently disabled - configure schedule as needed)
 */
export function startLimitOrderBotCron(): void {
  // Example: Run every day at 9 AM UTC
  // const cronPattern = '0 9 * * *'

  // For now, cron is disabled - use manual trigger
  console.log('[Limit Order Bot] Cron job not configured')
  console.log('[Limit Order Bot] Use triggerLimitOrderBotManually() to run manually')

  // Uncomment to enable cron:
  // cron.schedule(cronPattern, async () => {
  //   console.log('[Limit Order Bot] Cron triggered at:', new Date().toISOString())
  //
  //   const params: LimitOrderParams = {
  //     fromToken: 'ETH',
  //     toToken: 'USDC',
  //     fromAmount: '0.1',
  //     limitPrice: 2100,
  //     fillDelayMinutes: 30,
  //     expiryHours: 24
  //   }
  //
  //   await executeLimitOrderBot(params, 'scheduled_limit_order')
  // })
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  executeLimitOrderBot,
  createLimitOrder,
  TOKENS,
  CHAIN_ID
}

export type {
  LimitOrderParams,
  BotExecutionResult
}