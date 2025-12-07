/**
 * Counter Order Service
 * Handles counter-order placement and activity tracking
 */

import { ethers } from 'ethers'
import BotOrdersSimple from '../../../models/BotOrdersSimple'
import SushiswapActivity from '../../../models/SushiswapActivity'
import User from '../../../models/User'
import { getToken } from '../../gridBot/tokenPairs.config'
import { getCurrentTokenPrice } from '../../gridBot/priceManager'
import { fromWei } from '../../utils/botHelpers'
import { KatanaLogger } from '../../../utils/logger'
import { OrderStatusUpdate } from './OrderStatusService'
import { OrderConstructionService } from './OrderConstructionService'
import { OrderExecutionService } from './OrderExecutionService'
import { BalanceService } from './BalanceService'

const PREFIX = '[CounterOrder]'

interface CounterOrderConfig {
  profitMarginPercent: number
  minOrderSizeUsd: number
  expiryHours: number
  chainId: number
}

export class CounterOrderService {
  private static config: CounterOrderConfig = {
    profitMarginPercent: 1,
    minOrderSizeUsd: 6,
    expiryHours: 168,
    chainId: 747474
  }

  /**
   * Retry helper for database operations
   */
  private static async retryOperation<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number = 3
  ): Promise<T> {
    let lastError: any = null

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation()
      } catch (error: any) {
        lastError = error

        // Check if it's a retryable database error
        const isRetryable =
          error.name === 'SequelizeDatabaseError' &&
          (error.parent?.code === 'ER_LOCK_WAIT_TIMEOUT' ||
           error.parent?.code === 'ER_DUP_ENTRY' ||
           error.parent?.code === 'ECONNRESET')

        if (isRetryable && attempt < maxRetries) {
          const waitTime = Math.min(200 * Math.pow(2, attempt - 1), 2000)
          KatanaLogger.warn(
            PREFIX,
            `${operationName} failed (attempt ${attempt}/${maxRetries}). Retrying in ${waitTime}ms...`
          )
          await new Promise(resolve => setTimeout(resolve, waitTime))
          continue
        }

        // Non-retryable error or max retries reached
        throw error
      }
    }

    throw lastError
  }

  /**
   * Add filled order to SushiswapActivity table
   */
  static async addToActivityLog(
    update: OrderStatusUpdate,
    walletAddress: string,
    provider: ethers.Provider,
    walletIndex: number
  ): Promise<void> {
    const { dbOrder, blockchainOrder } = update

    KatanaLogger.info(PREFIX, `[Wallet ${walletIndex}] Adding to activity log...`)

    try {
      // Sync balances with retry
      await this.retryOperation(
        () => BalanceService.syncBalances(provider, walletAddress),
        'Balance sync'
      )

      // Get or create user with retry (now has built-in retry in the model)
      const { user } = await User.findOrCreateUser(walletAddress.toLowerCase(), this.config.chainId)

      // Get tokens
      const fromToken = getToken(dbOrder.from_token)
      const toToken = getToken(dbOrder.to_token)

      // Convert amounts
      const fromAmountHuman = fromWei(blockchainOrder.filledSrcAmount, fromToken.decimals)
      const toAmountHuman = fromWei(blockchainOrder.filledDstAmount, toToken.decimals)

      // Calculate USD volume
      const fromTokenPrice = await getCurrentTokenPrice(fromToken.symbol)
      const toTokenPrice = await getCurrentTokenPrice(toToken.symbol)

      const usdVolume = parseFloat(fromAmountHuman) * fromTokenPrice
      const executionPrice = (parseFloat(toAmountHuman) * toTokenPrice) / parseFloat(fromAmountHuman)

      // Check if activity already exists for this order
      const existingActivity = await SushiswapActivity.findOne({
        where: {
          order_id: dbOrder.blockchain_order_id
        }
      })

      if (existingActivity) {
        KatanaLogger.warn(
          PREFIX,
          `[Wallet ${walletIndex}] Activity already exists for order ${dbOrder.blockchain_order_id}, skipping`
        )
        return
      }

      // Generate unique tx_hash using order ID and timestamp
      // Format: LIMIT_{orderId}_{timestamp}
      const uniqueTxHash = `LIMIT_${dbOrder.blockchain_order_id}_${Date.now()}`

      // Create activity record with retry logic
      await this.retryOperation(
        async () => {
          return await SushiswapActivity.create({
            user_id: user.id,
            wallet_address: walletAddress.toLowerCase(),
            swap_type: 'LIMIT_ORDER',
            tx_hash: uniqueTxHash,
            chain_id: this.config.chainId,
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
        },
        'Activity log creation'
      )

      KatanaLogger.info(PREFIX, `Added to activity log (USD: $${usdVolume.toFixed(2)})`,)
    } catch (error: any) {
      // Log detailed error information
      KatanaLogger.error(PREFIX, `Failed to add to activity log`, error)

      // Check if it's a Sequelize unique constraint error
      if (error.name === 'SequelizeUniqueConstraintError') {
        KatanaLogger.warn(PREFIX, `Duplicate tx_hash detected: ${dbOrder.blockchain_order_id}`)
      }

      // Log full error details for debugging
      console.error('[CounterOrder] FULL ERROR DETAILS:', {
        errorName: error.name,
        errorMessage: error.message,
        errorCode: error.code,
        errorSql: error.sql,
        errorParent: error.parent,
        fields: error.fields,
        orderData: {
          blockchain_order_id: dbOrder.blockchain_order_id,
          wallet: walletAddress,
          fromToken: dbOrder.from_token,
          toToken: dbOrder.to_token
        }
      })

      throw error
    }
  }

  /**
   * Place counter-order for filled parent order
   */
  static async placeCounterOrder(
    update: OrderStatusUpdate,
    signer: ethers.Wallet,
    walletIndex: number
  ): Promise<void> {
    const { dbOrder, blockchainOrder } = update

    // Check if counter-order already exists
    const isParentBuyOrder = dbOrder.order_type.includes('buy')
    const counterOrderType = isParentBuyOrder ? 'counter_sell' : 'counter_buy'

    const existingCounterOrder = await BotOrdersSimple.findOne({
      where: {
        parent_order_id: dbOrder.id,
        order_type: counterOrderType
      }
    })

    if (existingCounterOrder) {
      KatanaLogger.info(PREFIX, `[Wallet ${walletIndex}] Counter-order already exists, skipping`)
      return
    }

    KatanaLogger.info(PREFIX, `[Wallet ${walletIndex}] Placing counter-order for ${dbOrder.order_type}...`)

    try {
      // Get tokens
      const fromToken = getToken(dbOrder.from_token)
      const toToken = getToken(dbOrder.to_token)

      // Get filled amounts
      const fromAmountHuman = fromWei(blockchainOrder.filledSrcAmount, fromToken.decimals)
      const toAmountHuman = fromWei(blockchainOrder.filledDstAmount, toToken.decimals)

      if (parseFloat(fromAmountHuman) === 0 || parseFloat(toAmountHuman) === 0) {
        throw new Error('Invalid filled amounts: one or both are zero')
      }

      // Calculate execution price
      const fromTokenPrice = await getCurrentTokenPrice(fromToken.symbol)
      const toTokenPrice = await getCurrentTokenPrice(toToken.symbol)

      let executionPriceUSD: number

      if (isParentBuyOrder) {
        // Parent BUY: bought toToken with fromToken
        executionPriceUSD = (parseFloat(fromAmountHuman) * fromTokenPrice) / parseFloat(toAmountHuman)
        KatanaLogger.info(
          PREFIX,
          `[Wallet ${walletIndex}] Parent BUY: ${fromAmountHuman} ${fromToken.symbol} → ${toAmountHuman} ${toToken.symbol}`
        )
      } else {
        // Parent SELL: sold fromToken for toToken
        executionPriceUSD = (parseFloat(toAmountHuman) * toTokenPrice) / parseFloat(fromAmountHuman)
        KatanaLogger.info(
          PREFIX,
          `[Wallet ${walletIndex}] Parent SELL: ${fromAmountHuman} ${fromToken.symbol} → ${toAmountHuman} ${toToken.symbol}`
        )
      }

      KatanaLogger.info(PREFIX, `Execution price: $${executionPriceUSD.toFixed(2)}`)

      // Calculate counter-order price
      const counterPrice = isParentBuyOrder
        ? executionPriceUSD * (1 + this.config.profitMarginPercent / 100)
        : executionPriceUSD * (1 - this.config.profitMarginPercent / 100)

      KatanaLogger.info(
        PREFIX,
        `Counter price: $${counterPrice.toFixed(6)} (${isParentBuyOrder ? '+' : '-'}${this.config.profitMarginPercent}%)`
      )

      // Validate minimum order value
      const counterAmount = toAmountHuman
      const counterValueUSD = parseFloat(counterAmount) * executionPriceUSD

      if (counterValueUSD < this.config.minOrderSizeUsd) {
        KatanaLogger.warn(
          PREFIX,
          `[Wallet ${walletIndex}] Counter value $${counterValueUSD.toFixed(2)} below minimum, skipping`
        )
        return
      }

      // Determine counter-order tokens (reverse of parent)
      const counterFromToken = toToken
      const counterToToken = fromToken

      // Calculate limit price
      let limitPrice: number

      if (counterToToken.symbol === 'USDC') {
        limitPrice = counterPrice
      } else if (counterFromToken.symbol === 'USDC') {
        limitPrice = 1 / counterPrice
      } else {
        const fromPriceAtCounter = isParentBuyOrder ? counterPrice : toTokenPrice
        const toPriceAtCounter = isParentBuyOrder ? fromTokenPrice : counterPrice
        limitPrice = toPriceAtCounter / fromPriceAtCounter
      }

      KatanaLogger.info(
        PREFIX,
        `Counter: ${counterAmount} ${counterFromToken.symbol} → ${counterToToken.symbol} @ ${limitPrice.toFixed(8)}`
      )

      // Construct counter-order
      const counterOrder = await OrderConstructionService.constructOrder(
        signer.provider!,
        signer.address,
        counterOrderType as any,
        counterFromToken,
        counterToToken,
        counterAmount,
        limitPrice,
        this.config.expiryHours
      )

      // Execute counter-order
      await OrderExecutionService.executeCounterOrder(
        signer,
        counterOrder,
        dbOrder.id,
        walletIndex
      )

      // Sync balances after placement
      await BalanceService.syncBalances(signer.provider!, signer.address)

      KatanaLogger.info(PREFIX, `[Wallet ${walletIndex}] Counter-order placed successfully`)

    } catch (error) {
      KatanaLogger.error(PREFIX, `[Wallet ${walletIndex}] Counter-order failed`, error)
      // Don't throw - continue with other orders
    }
  }
}
