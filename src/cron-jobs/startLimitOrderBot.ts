/**
 * START LIMIT ORDER BOT
 *
 * Wallet 1: Buy ETH with USDC at 1% below market (limit order)
 * Wallet 2: Sell ETH for USDC at 1% above market (limit order)
 * Both orders: $25 USD worth
 */

import cron from 'node-cron'
import { ethers } from 'ethers'
import { loadBotWallets, ensureTokenApproval, getTokenBalance } from './utils/botWalletManager'
import {
  toWei,
  fromWei,
  calculateOutputAmount,
  calculateMinAmountOut,
  calculateChunkAmount,
  calculateDeadline,
  generateExecutionId,
  sleep,
  calculateUSDVolume,
  formatOrder
} from './utils/botHelpers'

// Import services and models directly
import { TwapService } from '../services/twap'
import BotExecution from '../models/BotExecution'
import BotWalletExecution from '../models/BotWalletExecution'
import BotLimitOrder from '../models/BotLimitOrder'
import SushiswapActivity from '../models/SushiswapActivity'
import User from '../models/User'

const RPC_URL = 'https://rpc.katana.network'
const CHAIN_ID = 747474

// Token configurations on Katana
const TOKENS = {
  ETH: {
    address: '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62', // WETH on Katana
    decimals: 18,
    symbol: 'ETH'
  },
  USDC: {
    address: '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36',
    decimals: 6,
    symbol: 'USDC'
  }
} as const

// ETH token address on Katana
const ETH_ADDRESS = '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62' // WETH on Katana

interface LimitOrderParams {
  fromToken: 'ETH' | 'USDC'
  toToken: 'ETH' | 'USDC'
  fromAmount: string
  limitPrice: number
  fillDelayMinutes: number
  expiryHours: number
  // Note: chunks is ALWAYS 1 for limit orders (hardcoded, matching frontend behavior)
}

/**
 * Get current market price for ETH/USDC using Sushi API
 */
async function getCurrentETHPrice(): Promise<number> {
  try {
    const response = await fetch(
      `https://api.sushi.com/price/v1/747474/${ETH_ADDRESS}`
    )

    if (!response.ok) {
      throw new Error(`Sushi API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    const price = parseFloat(data.price || data.usd || data)

    if (!price || price <= 0) {
      throw new Error('Invalid price received from Sushi API')
    }

    console.log(`[Price] Current ETH price: $${price.toFixed(2)} (from Sushi API)`)
    return price

  } catch (error: any) {
    console.warn(`[Price] Failed to fetch from Sushi API: ${error.message}`)
    console.warn('[Price] Falling back to mock price: $2000')
    return 2000 // Fallback price
  }
}

/**
 * Run the bot for both wallets with different orders
 */
export async function runImmediately() {
  console.log('\n')
  console.log('╔' + '═'.repeat(78) + '╗')
  console.log('║' + ' '.repeat(22) + 'LIMIT ORDER BOT STARTED' + ' '.repeat(33) + '║')
  console.log('╚' + '═'.repeat(78) + '╝')
  console.log(`\n[Time] ${new Date().toISOString()}`)

  const executionId = generateExecutionId()
  console.log(`[Execution ID] ${executionId}`)

  try {
    // Get current price
    const currentPrice = await getCurrentETHPrice()
    const buyPrice = currentPrice * 0.99 //1% below
    const sellPrice = currentPrice * 1.01 // 1% above

    const usdAmount = 25
    const ethAmount = usdAmount / currentPrice

    console.log('\n[Order Parameters]')
    console.log(`  Current Price: $${currentPrice}`)
    console.log(`  Buy Price (1% below): $${buyPrice.toFixed(2)}`)
    console.log(`  Sell Price (1% above): $${sellPrice.toFixed(2)}`)
    console.log(`  USD Amount: $${usdAmount}`)
    console.log(`  ETH Amount: ${ethAmount.toFixed(6)} ETH`)

    // Initialize provider and load wallets
    const provider = new ethers.JsonRpcProvider(RPC_URL)
    const wallets = loadBotWallets(provider)

    if (wallets.length < 2) {
      throw new Error('Need at least 2 wallets! Add WALLET_1 and WALLET_2 to .env')
    }

    // ============================================================================
    // TESTING: Fetch existing limit orders for both wallets
    // ============================================================================
    console.log('\n')
    console.log('╔' + '═'.repeat(78) + '╗')
    console.log('║' + ' '.repeat(22) + 'FETCHING EXISTING ORDERS' + ' '.repeat(31) + '║')
    console.log('╚' + '═'.repeat(78) + '╝\n')

    // Fetch orders for Wallet 1
    console.log(`\n[Wallet 1] ${wallets[0].address}`)
    try {
      const wallet1Orders = await TwapService.fetchLimitOrders(wallets[0].address)

      if (wallet1Orders.ALL.length === 0) {
        console.log('  No orders found for this wallet.')
      } else {
        console.log(`\n  📋 All Orders (${wallet1Orders.ALL.length}):`)
        wallet1Orders.ALL.forEach((order) => {
          console.log('\n' + formatOrder(order))
        })

        if (wallet1Orders.OPEN.length > 0) {
          console.log(`\n  🔓 Open Orders (${wallet1Orders.OPEN.length}):`)
          wallet1Orders.OPEN.forEach((order) => {
            console.log(`    - Order #${order.id}: ${order.progress}% complete`)
          })
        }
      }
    } catch (error: any) {
      console.error(`  ❌ Error fetching orders: ${error.message}`)
    }

    // Fetch orders for Wallet 2
    console.log(`\n\n[Wallet 2] ${wallets[1].address}`)
    try {
      const wallet2Orders = await TwapService.fetchLimitOrders(wallets[1].address)

      if (wallet2Orders.ALL.length === 0) {
        console.log('  No orders found for this wallet.')
      } else {
        console.log(`\n  📋 All Orders (${wallet2Orders.ALL.length}):`)
        wallet2Orders.ALL.forEach((order) => {
          console.log('\n' + formatOrder(order))
        })

        if (wallet2Orders.OPEN.length > 0) {
          console.log(`\n  🔓 Open Orders (${wallet2Orders.OPEN.length}):`)
          wallet2Orders.OPEN.forEach((order) => {
            console.log(`    - Order #${order.id}: ${order.progress}% complete`)
          })
        }
      }
    } catch (error: any) {
      console.error(`  ❌ Error fetching orders: ${error.message}`)
    }

    console.log('\n')
    console.log('╔' + '═'.repeat(78) + '╗')
    console.log('║' + ' '.repeat(22) + 'PLACING NEW ORDERS' + ' '.repeat(37) + '║')
    console.log('╚' + '═'.repeat(78) + '╝\n')
    // ============================================================================
    // END TESTING
    // ============================================================================

    // Create execution
    await BotExecution.create({
      execution_id: executionId,
      strategy_name: 'limit_order_bot',
      total_wallets: 2,
      completed_wallets: 0,
      failed_wallets: 0,
      total_volume_usd: 0,
      start_time: new Date(),
      end_time: null,
      status: 'running'
    })

    // Wallet 1: Buy WETH with USDC
    const wallet1 = wallets[0]
    console.log(`\n[Wallet 1] ${wallet1.address} - Buy WETH with USDC`)

    const buyOrder: LimitOrderParams = {
      fromToken: 'USDC',
      toToken: 'ETH',
      fromAmount: usdAmount.toFixed(2),
      limitPrice: 1 / buyPrice,
      fillDelayMinutes: 3,
      expiryHours: 24
    }

    await executeOrder(wallet1, buyOrder, provider, executionId, 'buy')

    await sleep(3000)

    // Wallet 2: Sell WETH for USDC
    const wallet2 = wallets[1]
    console.log(`\n[Wallet 2] ${wallet2.address} - Sell WETH for USDC`)

    const sellOrder: LimitOrderParams = {
      fromToken: 'ETH',
      toToken: 'USDC',
      fromAmount: ethAmount.toFixed(6),
      limitPrice: sellPrice,
      fillDelayMinutes: 3,
      expiryHours: 24
    }

    await executeOrder(wallet2, sellOrder, provider, executionId, 'sell')

    console.log('\n')
    console.log('╔' + '═'.repeat(78) + '╗')
    console.log('║' + ' '.repeat(22) + 'ALL ORDERS COMPLETED' + ' '.repeat(35) + '║')
    console.log('╚' + '═'.repeat(78) + '╝\n')

  } catch (error: any) {
    console.error('\n❌ ERROR:', error.message)
    throw error
  }
}

async function executeOrder(
  wallet: any,
  params: LimitOrderParams,
  provider: ethers.Provider,
  executionId: string,
  type: 'buy' | 'sell'
) {
  try {
    const fromToken = TOKENS[params.fromToken]
    const toToken = TOKENS[params.toToken]

    // Create wallet execution
    await BotWalletExecution.create({
      execution_id: executionId,
      wallet_index: wallet.index,
      wallet_address: wallet.address.toLowerCase(),
      tokens: [params.fromToken, params.toToken],
      swaps_completed: 0,
      total_volume_usd: 0,
      status: 'running',
      error_message: null,
      start_time: new Date(),
      end_time: null
    })

    // Calculate amounts
    // IMPORTANT: Chunks must ALWAYS be 1 for limit orders (matching frontend behavior)
    const chunks = 1

    const srcAmountWei = toWei(params.fromAmount, fromToken.decimals)
    const expectedOutputWei = calculateOutputAmount(
      params.fromAmount,
      params.limitPrice,
      fromToken.decimals,
      toToken.decimals
    )
    const dstMinAmountWei = calculateMinAmountOut(expectedOutputWei, 0.1)
    // For limit orders: srcChunkAmount = srcAmount (because chunks = 1)
    const srcChunkAmountWei = srcAmountWei
    const deadline = calculateDeadline(params.expiryHours)

    console.log(`  From: ${params.fromAmount} ${fromToken.symbol}`)
    console.log(`  To: ~${fromWei(expectedOutputWei, toToken.decimals)} ${toToken.symbol}`)
    console.log(`  Chunks: ${chunks} (hardcoded for limit orders), Delay: ${params.fillDelayMinutes}min`)

    // Check balance
    const balance = await getTokenBalance(provider, fromToken.address, wallet.address, false)
    if (balance < BigInt(srcAmountWei)) {
      throw new Error(`Insufficient ${fromToken.symbol} balance`)
    }

    // Prepare transaction
    const transaction = TwapService.prepareLimitOrder({
      srcToken: fromToken.address as any,
      dstToken: toToken.address as any,
      srcAmount: srcAmountWei,
      dstMinAmount: dstMinAmountWei,
      srcChunkAmount: srcChunkAmountWei,
      deadline: deadline,
      fillDelay: { unit: 'Minutes', value: params.fillDelayMinutes }
    })

    // Approve if needed
    await ensureTokenApproval(wallet.signer, fromToken.address, transaction.to, srcAmountWei, false)

    // Send transaction
    const txResponse = await wallet.signer.sendTransaction({
      to: transaction.to,
      data: transaction.data,
      value: BigInt(transaction.value || '0'),
      chainId: CHAIN_ID
    })

    console.log(`  ✓ Transaction sent: ${txResponse.hash}`)
    const receipt = await txResponse.wait()
    console.log(`  ✓ Confirmed in block ${receipt?.blockNumber}`)

    // Convert wei values to decimal-normalized values for database storage
    const srcAmountDecimal = fromWei(srcAmountWei, fromToken.decimals)
    const dstMinAmountDecimal = fromWei(dstMinAmountWei, toToken.decimals)

    // Get or create user for SushiswapActivity
    const [user] = await User.findOrCreate({
      where: { wallet_address: wallet.address.toLowerCase() },
      defaults: {
        wallet_address: wallet.address.toLowerCase(),
        chain_id: CHAIN_ID,
        is_active: true,
        token_addresses: [],
        last_balance_check: null
      }
    })

    // Calculate execution price
    const executionPrice = parseFloat(dstMinAmountDecimal) / parseFloat(srcAmountDecimal)

    // Log order to BotLimitOrder
    await BotLimitOrder.create({
      order_type: type === 'buy' ? 'counter_buy' : 'counter_sell',
      execution_id: executionId,
      wallet_index: wallet.index,
      wallet_address: wallet.address.toLowerCase(),
      order_id: txResponse.hash,
      tx_hash: txResponse.hash,
      chain_id: CHAIN_ID,
      src_token_address: fromToken.address.toLowerCase(),
      src_token_symbol: fromToken.symbol,
      src_amount: srcAmountDecimal,
      dst_token_address: toToken.address.toLowerCase(),
      dst_token_symbol: toToken.symbol,
      dst_min_amount: dstMinAmountDecimal,
      filled_src_amount: '0',
      filled_dst_amount: '0',
      progress: 0,
      usd_volume: 0,
      status: 'pending',
      placed_at: new Date(),
      filled_at: null,
      deadline: deadline,
      metadata: null
    })

    // Log order to SushiswapActivity
    await SushiswapActivity.create({
      user_id: user.id,
      wallet_address: wallet.address.toLowerCase(),
      swap_type: 'LIMIT_ORDER',
      tx_hash: txResponse.hash,
      chain_id: CHAIN_ID,
      block_number: receipt?.blockNumber || null,
      block_timestamp: null,
      token_from_address: fromToken.address.toLowerCase(),
      token_from_symbol: fromToken.symbol,
      token_from_amount: srcAmountDecimal,
      token_to_address: toToken.address.toLowerCase(),
      token_to_symbol: toToken.symbol,
      token_to_amount: dstMinAmountDecimal,
      usd_volume: 0,
      execution_price: executionPrice,
      pool_id: null,
      order_id: txResponse.hash,
      filled_src_amount: '0',
      filled_dst_amount: '0',
      is_partial_fill: false,
      progress: 0,
      status: 'pending',
      metadata: {
        deadline: deadline
      },
      timestamp: new Date()
    })

    // Complete wallet execution
    await BotWalletExecution.update(
      {
        status: 'completed',
        end_time: new Date(),
        limit_orders_placed: 1,
        limit_orders_filled: 0,
        total_volume_usd: 25
      },
      {
        where: {
          execution_id: executionId,
          wallet_index: wallet.index
        }
      }
    )

  } catch (error: any) {
    console.error(`  ❌ Error: ${error.message}`)

    await BotWalletExecution.update(
      {
        status: 'failed',
        error_message: error.message,
        end_time: new Date()
      },
      {
        where: {
          execution_id: executionId,
          wallet_index: wallet.index
        }
      }
    )

    throw error
  }
}

// Auto-run when executed directly
if (require.main === module) {
  runImmediately()
    .then(() => {
      console.log('[Success] Bot execution completed')
      process.exit(0)
    })
    .catch((error) => {
      console.error('[Error] Bot execution failed:', error)
      process.exit(1)
    })
}

export {
  getCurrentETHPrice
}