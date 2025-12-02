/**
 * CLASSIC SWAP BOT CRON JOB
 *
 * This bot balances WETH and USDC holdings for each wallet.
 * Goal: Maintain equal USD value of WETH and USDC
 *
 * Strategy:
 * - If USDC < WETH (in USD), swap WETH -> USDC
 * - If WETH < USDC (in USD), swap USDC -> WETH
 * - Swap exactly half the difference to achieve balance
 *
 * Chain: Katana (747474)
 * Supported Tokens: WETH and USDC
 */

import cron from 'node-cron'
import { ethers } from 'ethers'
import { loadBotWallets, ensureTokenApproval, getTokenBalance, type BotWallet } from './utils/botWalletManager'
import {
  toWei,
  fromWei,
  generateExecutionId,
  sleep,
  calculateUSDVolume
} from './utils/botHelpers'
import { getQuote, getSwap } from 'sushi/evm'
import { ChainId } from 'sushi'
import { Address } from 'viem'

// Import models directly
import BotExecution from '../models/BotExecution'
import BotWalletExecution from '../models/BotWalletExecution'

// ============================================================================
// CONSTANTS
// ============================================================================

const CHAIN_ID = 747474
const RPC_URL = 'https://rpc.katana.network'
const SLIPPAGE_PERCENT = 0.5 // 0.5% slippage for swaps

// Token configurations on Katana
const TOKENS = {
  WETH: {
    address: '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62',
    decimals: 18,
    symbol: 'WETH',
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

interface WalletBalances {
  wethBalance: bigint
  usdcBalance: bigint
  wethBalanceUSD: number
  usdcBalanceUSD: number
  totalUSD: number
  imbalance: number // Difference in USD (positive = more WETH, negative = more USDC)
  needsRebalance: boolean
  swapDirection: 'WETH_TO_USDC' | 'USDC_TO_WETH' | 'BALANCED'
}

interface SwapParams {
  fromToken: typeof TOKENS.WETH | typeof TOKENS.USDC
  toToken: typeof TOKENS.WETH | typeof TOKENS.USDC
  amountWei: string
  amountHuman: string
}

interface BotExecutionResult {
  success: boolean
  executionId: string
  wallet: {
    index: number
    address: string
  }
  balancesBefore?: WalletBalances
  balancesAfter?: WalletBalances
  swap?: {
    txHash: string
    blockNumber: number
    fromToken: string
    toToken: string
    fromAmount: string
    toAmount: string
  }
  error?: string
  skipped?: boolean
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get token prices (mock for now - replace with your actual price service)
 */
async function getTokenPrices(): Promise<{ wethPrice: number; usdcPrice: number }> {
  // TODO: Replace with actual price fetching from your price service
  return {
    wethPrice: 2000, // $2000 per WETH
    usdcPrice: 1     // $1 per USDC
  }
}

/**
 * Get wallet balances for WETH and USDC
 */
async function getWalletBalances(
  provider: ethers.Provider,
  walletAddress: string,
  prices: { wethPrice: number; usdcPrice: number }
): Promise<WalletBalances> {
  // Get token balances
  const wethBalance = await getTokenBalance(provider, TOKENS.WETH.address, walletAddress, false)
  const usdcBalance = await getTokenBalance(provider, TOKENS.USDC.address, walletAddress, false)

  // Convert to human-readable amounts
  const wethHuman = parseFloat(fromWei(wethBalance.toString(), TOKENS.WETH.decimals))
  const usdcHuman = parseFloat(fromWei(usdcBalance.toString(), TOKENS.USDC.decimals))

  // Calculate USD values
  const wethBalanceUSD = wethHuman * prices.wethPrice
  const usdcBalanceUSD = usdcHuman * prices.usdcPrice
  const totalUSD = wethBalanceUSD + usdcBalanceUSD

  // Calculate imbalance
  const targetBalanceUSD = totalUSD / 2
  const imbalance = wethBalanceUSD - usdcBalanceUSD

  // Determine if rebalancing is needed (threshold: $10 difference)
  const REBALANCE_THRESHOLD_USD = 10
  const needsRebalance = Math.abs(imbalance) > REBALANCE_THRESHOLD_USD

  // Determine swap direction
  let swapDirection: 'WETH_TO_USDC' | 'USDC_TO_WETH' | 'BALANCED' = 'BALANCED'
  if (imbalance > REBALANCE_THRESHOLD_USD) {
    swapDirection = 'WETH_TO_USDC'
  } else if (imbalance < -REBALANCE_THRESHOLD_USD) {
    swapDirection = 'USDC_TO_WETH'
  }

  return {
    wethBalance,
    usdcBalance,
    wethBalanceUSD,
    usdcBalanceUSD,
    totalUSD,
    imbalance,
    needsRebalance,
    swapDirection
  }
}

/**
 * Calculate swap amount to achieve balance
 */
function calculateSwapAmount(
  balances: WalletBalances,
  prices: { wethPrice: number; usdcPrice: number }
): SwapParams | null {
  if (!balances.needsRebalance) {
    return null
  }

  // Calculate how much to swap (half of the imbalance in USD)
  const swapAmountUSD = Math.abs(balances.imbalance) / 2

  if (balances.swapDirection === 'WETH_TO_USDC') {
    // Swap WETH -> USDC
    const swapAmountWETH = swapAmountUSD / prices.wethPrice
    const swapAmountWei = toWei(swapAmountWETH.toString(), TOKENS.WETH.decimals)

    // Ensure we don't swap more than available
    if (BigInt(swapAmountWei) > balances.wethBalance) {
      const maxSwapAmountWei = balances.wethBalance.toString()
      return {
        fromToken: TOKENS.WETH,
        toToken: TOKENS.USDC,
        amountWei: maxSwapAmountWei,
        amountHuman: fromWei(maxSwapAmountWei, TOKENS.WETH.decimals)
      }
    }

    return {
      fromToken: TOKENS.WETH,
      toToken: TOKENS.USDC,
      amountWei: swapAmountWei,
      amountHuman: swapAmountWETH.toString()
    }
  } else if (balances.swapDirection === 'USDC_TO_WETH') {
    // Swap USDC -> WETH
    const swapAmountUSDC = swapAmountUSD / prices.usdcPrice
    const swapAmountWei = toWei(swapAmountUSDC.toString(), TOKENS.USDC.decimals)

    // Ensure we don't swap more than available
    if (BigInt(swapAmountWei) > balances.usdcBalance) {
      const maxSwapAmountWei = balances.usdcBalance.toString()
      return {
        fromToken: TOKENS.USDC,
        toToken: TOKENS.WETH,
        amountWei: maxSwapAmountWei,
        amountHuman: fromWei(maxSwapAmountWei, TOKENS.USDC.decimals)
      }
    }

    return {
      fromToken: TOKENS.USDC,
      toToken: TOKENS.WETH,
      amountWei: swapAmountWei,
      amountHuman: swapAmountUSDC.toString()
    }
  }

  return null
}

// ============================================================================
// TRACKING FUNCTIONS
// ============================================================================

/**
 * Start bot execution tracking
 */
async function startBotExecution(executionId: string, strategyName: string, totalWallets: number) {
  const existing = await BotExecution.findOne({ where: { execution_id: executionId } })
  if (existing) {
    console.warn(`[Tracking] Execution ${executionId} already exists`)
    return existing
  }

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
 * Start wallet execution tracking
 */
async function startWalletExecution(executionId: string, walletIndex: number, walletAddress: string) {
  const execution = await BotExecution.findOne({ where: { execution_id: executionId } })
  if (!execution) {
    throw new Error(`Execution ${executionId} not found`)
  }

  const [walletExecution, created] = await BotWalletExecution.findOrCreate({
    where: {
      execution_id: executionId,
      wallet_index: walletIndex
    },
    defaults: {
      execution_id: executionId,
      wallet_index: walletIndex,
      wallet_address: walletAddress.toLowerCase(),
      tokens: ['WETH', 'USDC'],
      swaps_completed: 0,
      total_volume_usd: 0,
      status: 'running',
      error_message: null,
      start_time: new Date(),
      end_time: null
    }
  })

  if (!created) {
    await walletExecution.update({
      status: 'running',
      start_time: new Date()
    })
  }

  return walletExecution
}

/**
 * Complete wallet execution tracking
 */
async function completeWalletExecution(
  executionId: string,
  walletIndex: number,
  status: 'completed' | 'failed',
  data: {
    wallet_address: string
    swaps_completed: number
    total_volume_usd: number
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

  const updateData: any = {
    status,
    error_message: data.error_message || null,
    end_time: new Date(),
    swaps_completed: data.swaps_completed,
    total_volume_usd: data.total_volume_usd
  }

  if (data.wallet_address) {
    updateData.wallet_address = data.wallet_address.toLowerCase()
  }

  if (data.tokens && Array.isArray(data.tokens)) {
    updateData.tokens = data.tokens.map((token: string) => token.toUpperCase())
  }

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

// ============================================================================
// CORE BOT LOGIC
// ============================================================================

/**
 * Execute classic swap for a single wallet to balance WETH and USDC
 */
async function executeClassicSwapForWallet(
  wallet: BotWallet,
  provider: ethers.Provider,
  executionId: string,
  prices: { wethPrice: number; usdcPrice: number }
): Promise<BotExecutionResult> {

  console.log(`\n${'='.repeat(80)}`)
  console.log(`[Classic Swap Bot] Wallet ${wallet.index} (${wallet.address})`)
  console.log(`${'='.repeat(80)}`)

  try {
    // ========================================================================
    // STEP 1: Check wallet balances
    // ========================================================================

    console.log('\n[Balance Check] Fetching wallet balances...')
    const balancesBefore = await getWalletBalances(provider, wallet.address, prices)

    console.log(`  WETH: ${fromWei(balancesBefore.wethBalance.toString(), TOKENS.WETH.decimals)} ($${balancesBefore.wethBalanceUSD.toFixed(2)})`)
    console.log(`  USDC: ${fromWei(balancesBefore.usdcBalance.toString(), TOKENS.USDC.decimals)} ($${balancesBefore.usdcBalanceUSD.toFixed(2)})`)
    console.log(`  Total: $${balancesBefore.totalUSD.toFixed(2)}`)
    console.log(`  Imbalance: $${balancesBefore.imbalance.toFixed(2)} (${balancesBefore.swapDirection})`)

    // ========================================================================
    // STEP 2: Check if rebalancing is needed
    // ========================================================================

    if (!balancesBefore.needsRebalance) {
      console.log('\n✓ Wallet is already balanced. Skipping swap.')

      return {
        success: true,
        executionId,
        wallet: {
          index: wallet.index,
          address: wallet.address
        },
        balancesBefore,
        skipped: true
      }
    }

    // ========================================================================
    // STEP 3: Calculate swap parameters
    // ========================================================================

    console.log('\n[Rebalance] Calculating swap amount...')
    const swapParams = calculateSwapAmount(balancesBefore, prices)

    if (!swapParams) {
      console.log('\n✓ No swap needed.')
      return {
        success: true,
        executionId,
        wallet: {
          index: wallet.index,
          address: wallet.address
        },
        balancesBefore,
        skipped: true
      }
    }

    console.log(`  Swap: ${swapParams.amountHuman} ${swapParams.fromToken.symbol} → ${swapParams.toToken.symbol}`)

    // ========================================================================
    // STEP 4: Get swap quote
    // ========================================================================

    console.log('\n[Quote] Fetching swap quote...')
    const quote = await getQuote({
      chainId: ChainId.KATANA,
      tokenIn: swapParams.fromToken.address as Address,
      tokenOut: swapParams.toToken.address as Address,
      amount: BigInt(swapParams.amountWei),
      maxSlippage: SLIPPAGE_PERCENT / 100
    })

    const expectedAmountOut = quote.assumedAmountOut?.toString() || '0'
    console.log(`  Expected output: ${fromWei(expectedAmountOut, swapParams.toToken.decimals)} ${swapParams.toToken.symbol}`)

    // ========================================================================
    // STEP 5: Prepare swap transaction
    // ========================================================================

    console.log('\n[Transaction] Preparing swap transaction...')
    const swap = await getSwap({
      chainId: ChainId.KATANA,
      tokenIn: swapParams.fromToken.address as Address,
      tokenOut: swapParams.toToken.address as Address,
      amount: BigInt(swapParams.amountWei),
      maxSlippage: SLIPPAGE_PERCENT / 100,
      sender: wallet.address as Address
    })

    if (!swap || !swap.tx || !swap.tx.to || !swap.tx.data) {
      throw new Error('Failed to generate swap transaction')
    }

    const routerAddress = swap.tx.to
    console.log(`  Router: ${routerAddress}`)

    // ========================================================================
    // STEP 6: Check and approve token if needed
    // ========================================================================

    console.log(`\n[Approval] Checking ${swapParams.fromToken.symbol} approval...`)
    const approvalResult = await ensureTokenApproval(
      wallet.signer,
      swapParams.fromToken.address,
      routerAddress,
      swapParams.amountWei,
      false
    )

    if (approvalResult.needsApproval) {
      console.log(`  ✓ Approval granted: ${approvalResult.txHash}`)
    } else {
      console.log('  ✓ Sufficient allowance already exists')
    }

    // ========================================================================
    // STEP 7: Execute swap
    // ========================================================================

    console.log('\n[Swap] Executing swap...')
    const transaction = {
      to: swap.tx.to,
      data: swap.tx.data,
      value: BigInt(swap.tx.value?.toString() || '0'),
      chainId: CHAIN_ID
    }

    const txResponse = await wallet.signer.sendTransaction(transaction)
    console.log(`  ✓ Transaction sent: ${txResponse.hash}`)

    console.log('  ⏳ Waiting for confirmation...')
    const receipt = await txResponse.wait()

    console.log(`\n${'='.repeat(80)}`)
    console.log('✅ SWAP COMPLETED SUCCESSFULLY')
    console.log(`${'='.repeat(80)}`)
    console.log(`  Block: ${receipt?.blockNumber}`)
    console.log(`  Gas used: ${receipt?.gasUsed.toString()}`)
    console.log(`  Tx hash: ${receipt?.hash}`)
    console.log(`${'='.repeat(80)}\n`)

    // ========================================================================
    // STEP 8: Check balances after swap
    // ========================================================================

    console.log('\n[Balance Check] Fetching updated balances...')
    const balancesAfter = await getWalletBalances(provider, wallet.address, prices)

    console.log(`  WETH: ${fromWei(balancesAfter.wethBalance.toString(), TOKENS.WETH.decimals)} ($${balancesAfter.wethBalanceUSD.toFixed(2)})`)
    console.log(`  USDC: ${fromWei(balancesAfter.usdcBalance.toString(), TOKENS.USDC.decimals)} ($${balancesAfter.usdcBalanceUSD.toFixed(2)})`)
    console.log(`  Total: $${balancesAfter.totalUSD.toFixed(2)}`)
    console.log(`  Imbalance: $${balancesAfter.imbalance.toFixed(2)} (${balancesAfter.swapDirection})`)

    // ========================================================================
    // STEP 9: Return result
    // ========================================================================

    return {
      success: true,
      executionId,
      wallet: {
        index: wallet.index,
        address: wallet.address
      },
      balancesBefore,
      balancesAfter,
      swap: {
        txHash: txResponse.hash,
        blockNumber: receipt?.blockNumber || 0,
        fromToken: swapParams.fromToken.symbol,
        toToken: swapParams.toToken.symbol,
        fromAmount: swapParams.amountHuman,
        toAmount: fromWei(expectedAmountOut, swapParams.toToken.decimals)
      }
    }

  } catch (error: any) {
    console.error(`\n❌ Error executing swap for wallet ${wallet.index}:`, error.message)

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
 * Execute classic swap bot for all configured wallets
 */
async function executeClassicSwapBot(
  strategyName: string = 'classic_swap_balance_bot'
): Promise<void> {

  const executionId = generateExecutionId()

  console.log('\n')
  console.log('╔' + '═'.repeat(78) + '╗')
  console.log('║' + ' '.repeat(16) + 'CLASSIC SWAP BALANCE BOT EXECUTION' + ' '.repeat(28) + '║')
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

    console.log(`  Loaded ${wallets.length} wallets`)

    // ========================================================================
    // STEP 2: Get token prices
    // ========================================================================

    console.log('\n[Prices] Fetching token prices...')
    const prices = await getTokenPrices()
    console.log(`  WETH: $${prices.wethPrice}`)
    console.log(`  USDC: $${prices.usdcPrice}`)

    // ========================================================================
    // STEP 3: Start execution tracking
    // ========================================================================

    console.log(`\n[Tracking] Starting execution tracking for ${wallets.length} wallets...`)
    await startBotExecution(executionId, strategyName, wallets.length)

    // ========================================================================
    // STEP 4: Execute swaps for each wallet
    // ========================================================================

    const results: BotExecutionResult[] = []

    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i]

      // Start wallet tracking
      await startWalletExecution(executionId, wallet.index, wallet.address)

      // Execute swap
      const result = await executeClassicSwapForWallet(wallet, provider, executionId, prices)
      results.push(result)

      // Calculate USD volume (only if swap was executed)
      let usdVolume = 0
      if (result.success && result.swap && result.balancesBefore) {
        const fromToken = result.swap.fromToken === 'WETH' ? TOKENS.WETH : TOKENS.USDC
        const priceMap = {
          [TOKENS.WETH.address.toLowerCase()]: prices.wethPrice,
          [TOKENS.USDC.address.toLowerCase()]: prices.usdcPrice
        }
        usdVolume = await calculateUSDVolume(
          fromToken.address,
          toWei(result.swap.fromAmount, fromToken.decimals),
          fromToken.decimals,
          priceMap
        )
      }

      // Complete wallet tracking
      await completeWalletExecution(
        executionId,
        wallet.index,
        result.success ? 'completed' : 'failed',
        {
          wallet_address: wallet.address,
          swaps_completed: result.swap ? 1 : 0,
          total_volume_usd: usdVolume,
          tokens: ['WETH', 'USDC'],
          error_message: result.error
        }
      )

      // Small delay between wallets to avoid RPC rate limits
      if (i < wallets.length - 1) {
        await sleep(2000)
      }
    }

    // ========================================================================
    // STEP 5: Print summary
    // ========================================================================

    console.log('\n')
    console.log('╔' + '═'.repeat(78) + '╗')
    console.log('║' + ' '.repeat(28) + 'EXECUTION SUMMARY' + ' '.repeat(33) + '║')
    console.log('╚' + '═'.repeat(78) + '╝\n')

    const successCount = results.filter(r => r.success).length
    const failCount = results.filter(r => !r.success).length
    const skippedCount = results.filter(r => r.skipped).length
    const swappedCount = results.filter(r => r.success && !r.skipped).length

    console.log(`Total wallets: ${wallets.length}`)
    console.log(`Successful: ${successCount}`)
    console.log(`  - Swapped: ${swappedCount}`)
    console.log(`  - Skipped (already balanced): ${skippedCount}`)
    console.log(`Failed: ${failCount}`)
    console.log(`\nExecution ID: ${executionId}`)
    console.log(`Completed: ${new Date().toISOString()}\n`)

    if (swappedCount > 0) {
      console.log('✅ Completed swaps:')
      results.filter(r => r.success && !r.skipped).forEach(r => {
        console.log(`  • Wallet ${r.wallet.index}: ${r.swap?.fromAmount} ${r.swap?.fromToken} → ${r.swap?.toAmount} ${r.swap?.toToken}`)
        console.log(`    Tx: ${r.swap?.txHash}`)
      })
      console.log('')
    }

    if (skippedCount > 0) {
      console.log('⏭ Skipped (already balanced):')
      results.filter(r => r.skipped).forEach(r => {
        console.log(`  • Wallet ${r.wallet.index}: Already balanced`)
      })
      console.log('')
    }

    if (failCount > 0) {
      console.log('❌ Failed swaps:')
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

// ============================================================================
// CRON JOB CONFIGURATION
// ============================================================================

/**
 * Manual trigger for testing
 */
export async function triggerClassicSwapBotManually(): Promise<void> {
  console.log('[Classic Swap Bot] Manual trigger initiated')
  await executeClassicSwapBot('manual_classic_swap_balance')
}

/**
 * Start cron job - runs every 6 hours
 */
export function startClassicSwapBotCron(): void {
  // Run every 6 hours at minute 0
  const cronPattern = '0 */6 * * *'

  console.log('[Classic Swap Bot] Cron job configured: every 6 hours')

  cron.schedule(cronPattern, async () => {
    console.log('[Classic Swap Bot] Cron triggered at:', new Date().toISOString())

    try {
      await executeClassicSwapBot('scheduled_classic_swap_balance')
    } catch (error: any) {
      console.error('[Classic Swap Bot] Cron execution failed:', error.message)
    }
  })
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  executeClassicSwapBot,
  TOKENS,
  CHAIN_ID
}

export type {
  WalletBalances,
  SwapParams,
  BotExecutionResult
}
