/**
 * Rebalancing Service
 * Handles wallet rebalancing to maintain 50/50 token allocation
 */

import { ethers } from 'ethers'
import { ChainId } from 'sushi'
import { getSwap } from 'sushi/evm'
import { Address } from 'viem'
import { BalanceService } from './BalanceService'
import { getCurrentTokenPrice } from '../../gridBot/priceManager'
import { getToken } from '../../gridBot/tokenPairs.config'
import { KatanaLogger } from '../../../utils/logger'
import { DatabaseLogger } from '../../../utils/logging/DatabaseLogger'
import { TEST_MODE_CONFIG, REBALANCE_CONFIG } from '../config'
import { WalletService } from './WalletService'
import { fromWei, toWei } from '../../utils/botHelpers'
import SushiswapActivity from '../../../models/SushiswapActivity'
import User from '../../../models/User'

const PREFIX = '[RebalancingService]'
const CHAIN_ID = 747474

interface WalletWithSigner {
  address: string
  index: number
  signer: ethers.Wallet
  tradingPool: string
}

interface RebalanceResult {
  success: boolean
  swapAmount?: string
  fromToken?: string
  toToken?: string
  txHash?: string
}

interface SwapDetails {
  tokenFrom: any
  tokenTo: any
  fromAmount: bigint
  fromAmountHuman: string
  toAmountExpected: string
  swapTx: any
  priceImpact: string
}

export class RebalancingService {
  /**
   * Main rebalance function - brings wallet to 50/50 allocation
   */
  static async executeRebalance(
    wallet: WalletWithSigner,
    walletIndex: number,
    tradingPool: string
  ): Promise<RebalanceResult> {
    if (!REBALANCE_CONFIG.ENABLED) {
      KatanaLogger.info(PREFIX, 'Rebalancing disabled in config')
      return { success: true }
    }

    try {
      KatanaLogger.info(PREFIX, `Checking rebalance for wallet ${wallet.address.slice(0, 10)}... (${tradingPool})`)

      // Parse trading pair
      const [token1Symbol, token2Symbol] = tradingPool.split('/').map((s: string) => s.trim())
      if (!token1Symbol || !token2Symbol) {
        throw new Error(`Invalid trading pool format: ${tradingPool}`)
      }

      // Get token configs
      const token1 = getToken(token1Symbol)
      const token2 = getToken(token2Symbol)

      // Get balances
      const balance1 = await BalanceService.getBalance(
        wallet.signer.provider!,
        token1.address,
        wallet.address,
        token1.isNative,
        token1.decimals
      )

      const balance2 = await BalanceService.getBalance(
        wallet.signer.provider!,
        token2.address,
        wallet.address,
        token2.isNative,
        token2.decimals
      )

      // Get prices (silent mode)
      const price1 = await getCurrentTokenPrice(token1.symbol, true)
      const price2 = await getCurrentTokenPrice(token2.symbol, true)

      // Calculate USD values
      const value1 = parseFloat(balance1.balanceHuman) * price1
      const value2 = parseFloat(balance2.balanceHuman) * price2
      const totalValue = value1 + value2

      if (totalValue === 0) {
        KatanaLogger.warn(PREFIX, 'Both tokens have zero balance, skipping rebalance')
        return { success: true }
      }

      // Calculate current allocation
      const allocation1 = (value1 / totalValue) * 100
      const allocation2 = (value2 / totalValue) * 100

      KatanaLogger.info(
        PREFIX,
        `Current allocation: ${allocation1.toFixed(2)}% ${token1.symbol} ($${value1.toFixed(2)}) / ${allocation2.toFixed(2)}% ${token2.symbol} ($${value2.toFixed(2)})`
      )

      // Check if rebalance needed (within threshold)
      const imbalance1 = Math.abs(50 - allocation1)
      if (imbalance1 < REBALANCE_CONFIG.MIN_IMBALANCE_PERCENT) {
        KatanaLogger.info(PREFIX, `Wallet already balanced (within ${REBALANCE_CONFIG.MIN_IMBALANCE_PERCENT}% threshold)`)
        return { success: true }
      }

      // Calculate swap needed to reach 50/50
      const targetValue = totalValue / 2
      let swapFromToken, swapToToken, swapUsdAmount

      if (value1 > targetValue) {
        // Swap token1 → token2
        swapFromToken = token1
        swapToToken = token2
        swapUsdAmount = value1 - targetValue
      } else {
        // Swap token2 → token1
        swapFromToken = token2
        swapToToken = token1
        swapUsdAmount = value2 - targetValue
      }

      // Skip if swap too small
      if (swapUsdAmount < REBALANCE_CONFIG.MIN_SWAP_SIZE_USD) {
        KatanaLogger.warn(
          PREFIX,
          `Swap amount too small ($${swapUsdAmount.toFixed(2)} < $${REBALANCE_CONFIG.MIN_SWAP_SIZE_USD}), skipping`
        )
        return { success: true }
      }

      // Calculate token amount to swap
      const fromTokenPrice = swapFromToken.symbol === token1.symbol ? price1 : price2
      const swapTokenAmount = swapUsdAmount / fromTokenPrice
      const swapTokenAmountWei = BigInt(Math.floor(swapTokenAmount * Math.pow(10, swapFromToken.decimals)))

      KatanaLogger.info(
        PREFIX,
        `Rebalance needed: Swap $${swapUsdAmount.toFixed(2)} (${swapTokenAmount.toFixed(6)} ${swapFromToken.symbol}) → ${swapToToken.symbol}`
      )

      // Get swap transaction data
      KatanaLogger.info(PREFIX, 'Fetching swap route from Sushi SDK...')

      // For native ETH, use WETH address for routing but keep the native flag for transaction execution
      const tokenInAddress = swapFromToken.isNative && swapFromToken.symbol === 'ETH'
        ? '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62' // WETH address on Katana
        : swapFromToken.address
      const tokenOutAddress = swapToToken.isNative && swapToToken.symbol === 'ETH'
        ? '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62' // WETH address on Katana
        : swapToToken.address

      KatanaLogger.info(PREFIX, `Swap params: ${swapFromToken.symbol} (${tokenInAddress}) -> ${swapToToken.symbol} (${tokenOutAddress})`)
      KatanaLogger.info(PREFIX, `Amount: ${swapTokenAmountWei.toString()} (${swapTokenAmount.toFixed(6)} ${swapFromToken.symbol})`)
      KatanaLogger.info(PREFIX, `Slippage: ${REBALANCE_CONFIG.SLIPPAGE_PERCENT}%`)

      let swap
      try {
        swap = await getSwap({
          chainId: ChainId.KATANA,
          tokenIn: tokenInAddress as Address,
          tokenOut: tokenOutAddress as Address,
          amount: swapTokenAmountWei,
          maxSlippage: REBALANCE_CONFIG.SLIPPAGE_PERCENT / 100,
          sender: wallet.address as Address
        })
      } catch (swapError: any) {
        KatanaLogger.error(PREFIX, 'getSwap() threw error:', swapError)
        KatanaLogger.warn(PREFIX, `Skipping rebalance - no liquidity route for ${swapFromToken.symbol} -> ${swapToToken.symbol}`)
        return { success: true } // Return success to avoid triggering error logs, but skip the swap
      }

      // Enhanced validation - check for empty data
      if (!swap || !swap.tx || !swap.tx.to || !swap.tx.data || swap.tx.data === '' || swap.tx.data === '0x') {
        KatanaLogger.warn(PREFIX, 'Swap generation returned empty data - no valid route found')
        if (swap) {
          KatanaLogger.info(PREFIX, `Swap response: ${JSON.stringify({
            hasTx: !!swap.tx,
            hasTo: swap.tx?.to,
            dataLength: swap.tx?.data?.length || 0,
            priceImpact: swap.priceImpact
          }, null, 2)}`)
        }
        KatanaLogger.warn(PREFIX, `Skipping rebalance - no liquidity route for ${swapFromToken.symbol} -> ${swapToToken.symbol}`)
        return { success: true } // Return success to avoid triggering error logs, but skip the swap
      }

      KatanaLogger.info(PREFIX, `✅ Swap route found. Router: ${swap.tx.to}, Data length: ${swap.tx.data.length} bytes`)

      const swapDetails: SwapDetails = {
        tokenFrom: swapFromToken,
        tokenTo: swapToToken,
        fromAmount: swapTokenAmountWei,
        fromAmountHuman: swapTokenAmount.toFixed(swapFromToken.decimals),
        toAmountExpected: '0', // Will be calculated after swap
        swapTx: swap.tx,
        priceImpact: swap.priceImpact
      }

      // Execute swap (production or test mode)
      let txHash: string
      if (TEST_MODE_CONFIG.enabled) {
        txHash = await this.executeRebalanceTestMode(swapDetails, wallet.address, walletIndex)
      } else {
        txHash = await this.executeRebalanceProduction(wallet, swapDetails, walletIndex)
      }

      // Sync balances after swap
      await BalanceService.syncBalances(wallet.signer.provider!, wallet.address, walletIndex)

      // Log success
      KatanaLogger.info(
        PREFIX,
        `✅ Rebalance complete: ${swapDetails.fromAmountHuman} ${swapFromToken.symbol} → ${swapToToken.symbol} (TX: ${txHash.slice(0, 10)}...)`
      )

      return {
        success: true,
        swapAmount: swapDetails.fromAmountHuman,
        fromToken: swapFromToken.symbol,
        toToken: swapToToken.symbol,
        txHash
      }

    } catch (error: any) {
      await DatabaseLogger.logError(
        walletIndex,
        wallet.address,
        'rebalance_failed',
        error.message,
        'executeRebalance'
      )
      KatanaLogger.error(PREFIX, 'Rebalance failed', error)
      return { success: false }
    }
  }

  /**
   * Execute rebalance swap in production (real blockchain)
   */
  static async executeRebalanceProduction(
    wallet: WalletWithSigner,
    swapDetails: SwapDetails,
    walletIndex: number
  ): Promise<string> {
    try {
      // Check if token approval needed (for ERC20 tokens)
      if (!swapDetails.tokenFrom.isNative) {
        KatanaLogger.info(PREFIX, 'Checking token approval...')

        const tokenContract = new ethers.Contract(
          swapDetails.tokenFrom.address,
          ['function allowance(address owner, address spender) view returns (uint256)', 'function approve(address spender, uint256 amount) returns (bool)'],
          wallet.signer
        )

        const allowance = await tokenContract.allowance(wallet.address, swapDetails.swapTx.to)

        if (allowance < swapDetails.fromAmount) {
          KatanaLogger.info(PREFIX, 'Approving token spend...')

          // Fetch fresh nonce for approval transaction
          const approvalNonce = await wallet.signer.provider!.getTransactionCount(wallet.address, 'pending')
          KatanaLogger.info(PREFIX, `Using nonce ${approvalNonce} for approval`)

          const approveTx = await tokenContract.approve(
            swapDetails.swapTx.to,
            ethers.MaxUint256,
            { nonce: approvalNonce }
          )
          await approveTx.wait()
          KatanaLogger.info(PREFIX, 'Token approved')
        }
      }

      // Final safety check before sending transaction
      if (!swapDetails.swapTx.data || swapDetails.swapTx.data === '' || swapDetails.swapTx.data === '0x') {
        throw new Error('Cannot send transaction with empty data field')
      }

      // Fetch fresh nonce for swap transaction (use 'pending' to include any pending txs)
      const currentNonce = await wallet.signer.provider!.getTransactionCount(wallet.address, 'pending')
      KatanaLogger.info(PREFIX, `Fetched fresh nonce: ${currentNonce}`)

      // Send swap transaction with explicit nonce
      KatanaLogger.info(PREFIX, 'Sending swap transaction...')
      KatanaLogger.info(PREFIX, `TX params: to=${swapDetails.swapTx.to}, data length=${swapDetails.swapTx.data.length}, value=${swapDetails.swapTx.value || 0n}, nonce=${currentNonce}`)

      const tx = await wallet.signer.sendTransaction({
        to: swapDetails.swapTx.to,
        data: swapDetails.swapTx.data,
        value: swapDetails.swapTx.value || 0n,
        nonce: currentNonce
      })

      KatanaLogger.info(PREFIX, `Transaction sent: ${tx.hash}`)

      // Wait for confirmation
      const receipt = await tx.wait()
      KatanaLogger.info(PREFIX, `Transaction confirmed in block ${receipt?.blockNumber}`)

      // Log to SushiswapActivity table
      await this.logToActivityTable(
        wallet.address,
        walletIndex,
        tx.hash,
        swapDetails,
        receipt
      )

      return tx.hash

    } catch (error: any) {
      // Handle nonce errors with retry
      if (error.code === 'NONCE_EXPIRED' || error.message?.includes('nonce too low')) {
        KatanaLogger.warn(PREFIX, 'Nonce error detected, retrying with fresh nonce...')

        try {
          // Wait a bit for network to sync
          await new Promise(resolve => setTimeout(resolve, 2000))

          // Fetch the latest nonce again
          const retryNonce = await wallet.signer.provider!.getTransactionCount(wallet.address, 'pending')
          KatanaLogger.info(PREFIX, `Retry with nonce: ${retryNonce}`)

          // Retry the transaction with fresh nonce
          const tx = await wallet.signer.sendTransaction({
            to: swapDetails.swapTx.to,
            data: swapDetails.swapTx.data,
            value: swapDetails.swapTx.value || 0n,
            nonce: retryNonce
          })

          KatanaLogger.info(PREFIX, `Retry transaction sent: ${tx.hash}`)

          const receipt = await tx.wait()
          KatanaLogger.info(PREFIX, `Retry transaction confirmed in block ${receipt?.blockNumber}`)

          await this.logToActivityTable(
            wallet.address,
            walletIndex,
            tx.hash,
            swapDetails,
            receipt
          )

          return tx.hash
        } catch (retryError: any) {
          KatanaLogger.error(PREFIX, 'Retry also failed', retryError)
          await DatabaseLogger.logError(
            walletIndex,
            wallet.address,
            'rebalance_swap_retry_failed',
            retryError.message,
            'executeRebalanceProduction'
          )
          throw retryError
        }
      }

      await DatabaseLogger.logError(
        walletIndex,
        wallet.address,
        'rebalance_swap_failed',
        error.message,
        'executeRebalanceProduction'
      )
      throw error
    }
  }

  /**
   * Execute rebalance swap in test mode (simulated)
   */
  static async executeRebalanceTestMode(
    swapDetails: SwapDetails,
    walletAddress: string,
    walletIndex: number
  ): Promise<string> {
    const mockTxHash = `REBALANCE_${walletAddress.slice(2, 10)}_${Date.now()}`

    KatanaLogger.info(PREFIX, '[TEST MODE] Simulating swap transaction')
    KatanaLogger.info(PREFIX, `[TEST MODE] Would swap: ${swapDetails.fromAmountHuman} ${swapDetails.tokenFrom.symbol} → ${swapDetails.tokenTo.symbol}`)
    KatanaLogger.info(PREFIX, `[TEST MODE] Price impact: ${swapDetails.priceImpact}`)
    KatanaLogger.info(PREFIX, `[TEST MODE] Mock TX hash: ${mockTxHash}`)

    // Log to SushiswapActivity table even in test mode (no receipt in test mode)
    await this.logToActivityTable(
      walletAddress,
      walletIndex,
      mockTxHash,
      swapDetails,
      null
    )

    return mockTxHash
  }

  /**
   * Log successful swap to SushiswapActivity table
   */
  static async logToActivityTable(
    walletAddress: string,
    walletIndex: number,
    txHash: string,
    swapDetails: SwapDetails,
    receipt: any | null
  ): Promise<void> {
    try {
      // Get or create user
      const { user } = await User.findOrCreateUser(walletAddress.toLowerCase(), CHAIN_ID)

      // Check if transaction already logged (prevent duplicates)
      const existing = await SushiswapActivity.findOne({
        where: { tx_hash: txHash }
      })

      if (existing) {
        KatanaLogger.info(PREFIX, 'Transaction already logged, skipping')
        return
      }

      // Get token prices for USD calculation
      const fromTokenPrice = await getCurrentTokenPrice(swapDetails.tokenFrom.symbol, true)
      const toTokenPrice = await getCurrentTokenPrice(swapDetails.tokenTo.symbol, true)

      // Calculate USD volume
      const fromAmountNum = parseFloat(swapDetails.fromAmountHuman)
      const usdVolume = fromAmountNum * fromTokenPrice

      // Estimate toAmount (in test mode we don't have actual amount)
      const toAmountExpected = (fromAmountNum * fromTokenPrice) / toTokenPrice
      const toAmountHuman = toAmountExpected.toFixed(swapDetails.tokenTo.decimals)

      // Calculate execution price
      const executionPrice = (toAmountExpected * toTokenPrice) / fromAmountNum

      // Calculate fees in USD if receipt is available
      let feesUsd: number | null = null
      if (receipt && receipt.operatorFeeConstant) {
        try {
          // Convert fee from wei to ether
          const feeInEther = parseFloat(ethers.formatEther(receipt.operatorFeeConstant))

          // Get ETH price
          const ethPrice = await getCurrentTokenPrice('ETH', true)

          // Calculate fees in USD
          feesUsd = feeInEther * ethPrice

          KatanaLogger.info(PREFIX, `Calculated fees: ${feeInEther} ETH ($${feesUsd.toFixed(4)})`)
        } catch (feeError: any) {
          KatanaLogger.error(PREFIX, 'Failed to calculate fees_usd', feeError)
          // Continue with null fees_usd if calculation fails
        }
      }

      // Create activity record
      await SushiswapActivity.create({
        user_id: user.id,
        wallet_address: walletAddress.toLowerCase(),
        swap_type: 'CLASSIC',
        tx_hash: txHash,
        chain_id: CHAIN_ID,
        block_number: receipt?.blockNumber || null,
        block_timestamp: new Date(),
        token_from_address: swapDetails.tokenFrom.address.toLowerCase(),
        token_from_symbol: swapDetails.tokenFrom.symbol,
        token_from_amount: swapDetails.fromAmountHuman,
        token_to_address: swapDetails.tokenTo.address.toLowerCase(),
        token_to_symbol: swapDetails.tokenTo.symbol,
        token_to_amount: toAmountHuman,
        usd_volume: usdVolume,
        fees_usd: feesUsd,
        execution_price: executionPrice,
        price_impact: parseFloat(swapDetails.priceImpact),
        pool_id: null,
        order_id: null,
        filled_src_amount: null,
        filled_dst_amount: null,
        is_partial_fill: false,
        progress: null,
        status: 'success',
        metadata: {
          rebalance_type: 'midnight_reset',
          wallet_index: walletIndex,
          test_mode: TEST_MODE_CONFIG.enabled
        },
        timestamp: new Date()
      })

      KatanaLogger.info(PREFIX, 'Swap logged to SushiswapActivity table')

    } catch (error: any) {
      KatanaLogger.error(PREFIX, 'Failed to log to SushiswapActivity', error)
      // Don't throw - logging failure shouldn't fail the rebalance
    }
  }
}
