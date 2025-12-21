/**
 * Order Execution Service
 * Handles executing orders on blockchain and saving to database
 */

import { ethers } from 'ethers'
import BotOrdersSimple from '../../../models/BotOrdersSimple'
import { TwapService } from '../../../services/twap'
import { ensureTokenApproval } from '../../utils/botWalletManager'
import { fromWei } from '../../utils/botHelpers'
import { getCurrentTokenPrice } from '../../gridBot/priceManager'
import { KatanaLogger } from '../../../utils/logger'
import { ConstructedOrder } from './OrderConstructionService'
import { TEST_MODE_CONFIG } from '../config'
import { DatabaseLogger } from '../../../utils/logging/DatabaseLogger'

const PREFIX = '[OrderExecution]'

export class OrderExecutionService {
  /**
   * Execute a constructed order on blockchain
   */
  static async executeOrder(
    signer: ethers.Wallet,
    order: ConstructedOrder,
    walletIndex: number
  ): Promise<void> {
    if (TEST_MODE_CONFIG.enabled) {
      await this.executeOrderTestMode(signer, order, walletIndex)
      return
    }

    await this.executeOrderProduction(signer, order, walletIndex)
  }

  /**
   * Production mode: Execute order on blockchain
   */
  private static async executeOrderProduction(
    signer: ethers.Wallet,
    order: ConstructedOrder,
    walletIndex: number
  ): Promise<void> {
    try {
      // Step 1: Approve token if needed
      if (!order.fromToken.isNative) {
        const approvalResult = await ensureTokenApproval(
          signer,
          order.fromToken.address,
          order.transaction.to,
          order.fromAmountWei,
          false
        )
      }

      // Step 2: Send transaction
      const txResponse = await signer.sendTransaction(order.transaction)

      // Step 3: Wait for confirmation
      const receipt = await txResponse.wait()

      // Step 4: Wait for indexing
      await new Promise(resolve => setTimeout(resolve, 5000))

      // Step 5: Fetch blockchain order ID (silent)
      let blockchainOrderId = await this.fetchBlockchainOrderId(
        signer.address,
        txResponse.hash,
        true // silent mode
      )

      // Step 6: Save to database
      await this.saveOrderToDatabase(
        signer.address,
        blockchainOrderId,
        order,
        null,
        true // silent mode
      )

      // Record success metric
      await DatabaseLogger.recordMetric(walletIndex, signer.address, `order_placed_${order.orderType}`)

    } catch (error: any) {
      // Log error to database
      await DatabaseLogger.logError(
        walletIndex,
        signer.address,
        'order_execution_failed',
        error.message,
        'executeOrder',
        { orderType: order.orderType }
      )
      await DatabaseLogger.recordMetric(walletIndex, signer.address, 'order_failed')

      KatanaLogger.error(PREFIX, `[Wallet ${walletIndex}] Order execution failed`, error)
      throw error
    }
  }

  /**
   * Test mode: Simulate order execution
   */
  private static async executeOrderTestMode(
    signer: ethers.Wallet,
    order: ConstructedOrder,
    walletIndex: number
  ): Promise<void> {
    const timestamp = Date.now()
    const randomPart = Math.random().toString(36).substr(2, 9)
    const simulatedOrderId = `TEST_${timestamp}_${randomPart}`

    await this.saveOrderToDatabase(
      signer.address,
      simulatedOrderId,
      order,
      null
    )

    // Record success metric
    await DatabaseLogger.recordMetric(walletIndex, signer.address, `order_placed_${order.orderType}`)
  }

  /**
   * Fetch blockchain order ID from TWAP SDK
   */
  private static async fetchBlockchainOrderId(
    walletAddress: string,
    txHash: string,
    silent: boolean = false
  ): Promise<string> {
    try {
      const orders = await TwapService.fetchLimitOrders(walletAddress, silent)
      const newOrder = orders.ALL.find((o: any) => o.txHash === txHash)
      const orderId = newOrder?.id?.toString()

      if (orderId) {
        return orderId
      } else {
        return txHash
      }
    } catch (error) {
      if (!silent) {
        KatanaLogger.error(PREFIX, 'Failed to fetch blockchain order ID', error)
      }
      return txHash
    }
  }

  /**
   * Save order to database
   */
  private static async saveOrderToDatabase(
    walletAddress: string,
    blockchainOrderId: string,
    order: ConstructedOrder,
    parentOrderId: number | null,
    silent: boolean = false
  ): Promise<void> {
    // Calculate USD value (silent mode for price fetch)
    const tokenPrice = await getCurrentTokenPrice(order.fromToken.symbol, silent)
    const usdValue = parseFloat(order.fromAmount) * tokenPrice

    // Check for duplicate blockchain_order_id only
    // Note: We don't check from_amount because multiple grid orders
    // can have the same amount but different limit prices
    const existingOrder = await BotOrdersSimple.findOne({
      where: {
        blockchain_order_id: blockchainOrderId
      }
    })

    if (existingOrder) {
      throw new Error(`Duplicate blockchain_order_id: ${blockchainOrderId}`)
    }

    // Save to database
    await BotOrdersSimple.create({
      wallet_address: walletAddress.toLowerCase(),
      blockchain_order_id: blockchainOrderId,
      order_type: order.orderType,
      parent_order_id: parentOrderId,
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
  }

  /**
   * Execute order with parent order ID (for counter-orders)
   */
  static async executeCounterOrder(
    signer: ethers.Wallet,
    order: ConstructedOrder,
    parentOrderId: number,
    walletIndex: number
  ): Promise<void> {
    if (TEST_MODE_CONFIG.enabled) {
      await this.executeCounterOrderTestMode(signer, order, parentOrderId, walletIndex)
      return
    }

    await this.executeCounterOrderProduction(signer, order, parentOrderId, walletIndex)
  }

  private static async executeCounterOrderProduction(
    signer: ethers.Wallet,
    order: ConstructedOrder,
    parentOrderId: number,
    walletIndex: number
  ): Promise<void> {
    try {
      // Approve token if needed
      if (!order.fromToken.isNative) {
        await ensureTokenApproval(
          signer,
          order.fromToken.address,
          order.transaction.to,
          order.fromAmountWei,
          false
        )
      }

      // Send transaction
      const txResponse = await signer.sendTransaction(order.transaction)

      await txResponse.wait()
      await new Promise(resolve => setTimeout(resolve, 5000))

      const blockchainOrderId = await this.fetchBlockchainOrderId(
        signer.address,
        txResponse.hash,
        true // silent mode
      )

      await this.saveOrderToDatabase(signer.address, blockchainOrderId, order, parentOrderId, true)

      // Record success metric
      await DatabaseLogger.recordMetric(walletIndex, signer.address, `order_placed_${order.orderType}`)

    } catch (error: any) {
      // Log error to database
      await DatabaseLogger.logError(
        walletIndex,
        signer.address,
        'counter_order_execution_failed',
        error.message,
        'executeCounterOrder',
        { orderType: order.orderType, parentOrderId }
      )
      await DatabaseLogger.recordMetric(walletIndex, signer.address, 'order_failed')

      KatanaLogger.error(PREFIX, `[Wallet ${walletIndex}] Counter-order execution failed`, error)
      throw error
    }
  }

  private static async executeCounterOrderTestMode(
    signer: ethers.Wallet,
    order: ConstructedOrder,
    parentOrderId: number,
    walletIndex: number
  ): Promise<void> {
    const simulatedOrderId = `TEST_COUNTER_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    await this.saveOrderToDatabase(signer.address, simulatedOrderId, order, parentOrderId)

    // Record success metric
    await DatabaseLogger.recordMetric(walletIndex, signer.address, `order_placed_${order.orderType}`)
  }
}
