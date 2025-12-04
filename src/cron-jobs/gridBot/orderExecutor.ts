import { ethers } from 'ethers'
import { OrderParams } from './types'
import {TwapService} from '../../services/twap'
import User from '../../models/User'
import { KatanaLogger } from '../../utils/logger'
import {
  toWei,
  fromWei,
  calculateOutputAmount,
  calculateMinAmountOut,
  calculateDeadline,
  sleep
} from '../utils/botHelpers'
import { getTokenBalance, ensureTokenApproval } from '../utils/botWalletManager'
import { createOrderInBothTables } from './databaseSync'

const PREFIX = '[OrderExecutor]'

// Use ethers.getAddress() to ensure proper checksum formatting for ethers v6
// const TWAP_CONTRACT_ADDRESS = ethers.getAddress('0x64D3bb94Ac60Cb2d1f2C5A48FAB5E725A50EEC25') // Katana TWAP contract
const CHAIN_ID = 747474

/**
 * Place a limit order and log to both database tables
 */
export async function placeOrder(params: OrderParams, testingMode: boolean = false): Promise<any> {
  const {
    wallet,
    executionId,
    fromToken,
    toToken,
    amount,
    limitPrice,
    orderType,
    parentOrderId = null,
    gridOffset = null
  } = params

  const modePrefix = testingMode ? '[TEST MODE]' : ''
  KatanaLogger.info(
    PREFIX,
    `${modePrefix} Placing ${orderType} order: ${amount} ${fromToken.symbol} → ${toToken.symbol} @ $${limitPrice}`
  )

  try {
    // 1. Calculate amounts in wei
    const srcAmountWei = toWei(amount, fromToken.decimals)
    const expectedOutputWei = calculateOutputAmount(
      srcAmountWei,
      limitPrice,
      fromToken.decimals,
      toToken.decimals
    )
    const dstMinAmountWei = calculateMinAmountOut(expectedOutputWei, 0.1) // 0.1% slippage
    const deadline = calculateDeadline(168) // 1 week (168 hours) expiry

    KatanaLogger.info(
      PREFIX,
      `Amounts: src=${srcAmountWei.toString()} wei, dst_min=${dstMinAmountWei.toString()} wei`
    )

    // 2. Check balance
    const balance = await getTokenBalance(
      wallet.signer.provider!,
      fromToken.address,
      wallet.address,
      fromToken.isNative
    )

    if (balance < BigInt(srcAmountWei)) {
      throw new Error(
        `Insufficient balance: have ${fromWei(balance.toString(), fromToken.decimals)} ${fromToken.symbol}, need ${amount}`
      )
    }

    KatanaLogger.info(PREFIX, `${modePrefix} Balance check passed: ${fromWei(balance.toString(), fromToken.decimals)} ${fromToken.symbol}`)

    // Variables to hold transaction data
    let txResponse: any
    let receipt: any
    let blockchainOrderId: number | null = null

    if (testingMode) {
      // ========== TESTING MODE: Simulate order without blockchain ==========
      KatanaLogger.warn(PREFIX, '[TEST MODE] Simulating order placement - NO BLOCKCHAIN TRANSACTION')

      // Generate mock transaction hash
      const mockTxHash = `0xtest${Date.now()}${Math.random().toString(36).substr(2, 9)}`
      const mockBlockNumber = Math.floor(Math.random() * 1000000) + 1000000
      const mockOrderId = Math.floor(Math.random() * 100000) + 1

      // Create mock transaction response
      txResponse = {
        hash: mockTxHash,
        wait: async () => ({
          blockNumber: mockBlockNumber,
          status: 1
        })
      }

      receipt = await txResponse.wait()
      blockchainOrderId = mockOrderId

      KatanaLogger.info(PREFIX, `[TEST MODE] Mock transaction: ${mockTxHash}`)
      KatanaLogger.info(PREFIX, `[TEST MODE] Mock block: ${mockBlockNumber}`)
      KatanaLogger.info(PREFIX, `[TEST MODE] Mock blockchain order ID: ${mockOrderId}`)

    } else {
      // ========== PRODUCTION MODE: Actual blockchain transaction ==========

      // 3. Prepare transaction via TWAP SDK
      const transaction = TwapService.prepareLimitOrder({
        srcToken: fromToken.address as any,
        dstToken: toToken.address as any,
        srcAmount: srcAmountWei.toString(),
        dstMinAmount: dstMinAmountWei.toString(),
        srcChunkAmount: srcAmountWei.toString(), // For limit orders, chunk = total amount
        fillDelay: { unit: 'Minutes', value: 3 },
        deadline: deadline
      })

      KatanaLogger.info(PREFIX, `Transaction prepared: to=${transaction.to}, value=${transaction.value}`)

      // 4. Approve token (if ERC20)
      if (!fromToken.isNative) {
        KatanaLogger.info(PREFIX, `Checking token approval for ${fromToken.symbol}...`)
        const approvalResult = await ensureTokenApproval(
          wallet.signer,
          fromToken.address,
          transaction.to,
          srcAmountWei,
          false
        )

        if (approvalResult.needsApproval) {
          KatanaLogger.info(PREFIX, `Token approved: ${approvalResult.txHash}`)
        } else {
          KatanaLogger.info(PREFIX, 'Token already approved')
        }
      }

      // 5. Send transaction
      KatanaLogger.info(PREFIX, 'Sending transaction...')
      txResponse = await wallet.signer.sendTransaction(transaction)
      KatanaLogger.info(PREFIX, `Transaction sent: ${txResponse.hash}`)

      receipt = await txResponse.wait()
      KatanaLogger.info(PREFIX, `Transaction confirmed: block ${receipt?.blockNumber}`)

      // 6. Wait for blockchain indexing (CRITICAL!)
      KatanaLogger.info(PREFIX, 'Waiting 5s for blockchain indexing...')
      await sleep(5000)

      // 7. Fetch blockchain_order_id from SDK
      try {
        const orders = await TwapService.fetchLimitOrders(wallet.address)
        const newOrder = orders.ALL.find((o: any) => o.txHash === txResponse.hash)
        blockchainOrderId = newOrder?.id || null

        if (blockchainOrderId) {
          KatanaLogger.info(PREFIX, `Blockchain order ID fetched: ${blockchainOrderId}`)
        } else {
          KatanaLogger.warn(PREFIX, `Could not fetch blockchain order ID for tx ${txResponse.hash}`)
        }
      } catch (fetchError) {
        KatanaLogger.error(PREFIX, 'Failed to fetch blockchain order ID', fetchError)
      }
    }

    // 8. Find or create user
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

    // 9. Generate order ID
    const orderId = `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    // 10. Prepare data for both tables
    // Convert wei to decimal-normalized values for database storage
    const dstMinAmountDecimal = fromWei(dstMinAmountWei, toToken.decimals)

    const botOrderData = {
      execution_id: executionId,
      wallet_index: wallet.index,
      wallet_address: wallet.address,
      order_id: orderId,
      blockchain_order_id: blockchainOrderId,
      parent_order_id: parentOrderId,
      order_type: orderType,
      grid_offset_percent: gridOffset,
      tx_hash: txResponse.hash,
      chain_id: CHAIN_ID,
      src_token_address: fromToken.address,
      src_token_symbol: fromToken.symbol,
      src_amount: amount,
      dst_token_address: toToken.address,
      dst_token_symbol: toToken.symbol,
      dst_min_amount: parseFloat(dstMinAmountDecimal).toFixed(toToken.decimals),
      filled_src_amount: '0',
      filled_dst_amount: '0',
      progress: 0,
      usd_volume: 0, // Will be updated when order fills
      status: 'pending',
      placed_at: new Date(),
      deadline: deadline
    }

    const sushiActivityData = {
      user_id: user.id,
      wallet_address: wallet.address,
      swap_type: 'LIMIT_ORDER' as const,
      tx_hash: txResponse.hash,
      chain_id: CHAIN_ID,
      block_number: receipt?.blockNumber || null,
      block_timestamp: null,
      token_from_address: fromToken.address,
      token_from_symbol: fromToken.symbol,
      token_from_amount: amount,
      token_to_address: toToken.address,
      token_to_symbol: toToken.symbol,
      token_to_amount: '0',
      usd_volume: 0,
      execution_price: 0,
      pool_id: null,
      order_id: orderId, // Will be set by createOrderInBothTables
      filled_src_amount: '0',
      filled_dst_amount: '0',
      is_partial_fill: false,
      progress: 0,
      status: 'pending',
      metadata: {
        order_type: orderType,
        limit_price: limitPrice,
        parent_order_id: parentOrderId,
        grid_offset: gridOffset
      },
      timestamp: new Date()
    }

    // 11. Log to BOTH tables atomically
    const botOrder = await createOrderInBothTables(botOrderData, sushiActivityData)

    KatanaLogger.info(
      PREFIX,
      `✅ Order placed successfully: ${orderId} (blockchain: ${blockchainOrderId || 'pending'})`
    )

    return botOrder
  } catch (error) {
    KatanaLogger.error(PREFIX, `Failed to place ${orderType} order`, error)
    throw error
  }
}
