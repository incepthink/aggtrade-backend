import type { Request, Response, NextFunction } from "express"
import SushiswapActivity from "../../models/SushiswapActivity"
import User from "../../models/User"
import Token from "../../models/Token"

interface LimitOrderSyncRequest {
  walletAddress: string
  chainId?: number
  orders: any[] // Full order objects from TwapSDK
}

/**
 * POST /tracking/sushiswap/limit-orders/sync
 * Sync limit order fills from TwapSDK on page load
 */
export const syncLimitOrders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data: LimitOrderSyncRequest = req.body
    console.log("Received sync request:", JSON.stringify(data, null, 2))

    // Validate required fields
    if (!data.walletAddress || !data.orders || !Array.isArray(data.orders)) {
      return res.status(400).json({
        error: 'Missing required fields: walletAddress, orders (array)'
      })
    }
    console.log(data.orders[0]);
    

    // Normalize wallet address
    const normalizedWallet = data.walletAddress.toLowerCase()

    // Get or create user
    const [user] = await User.findOrCreate({
      where: { wallet_address: normalizedWallet },
      defaults: {
        wallet_address: normalizedWallet,
        chain_id: data.chainId || 747474,
        is_active: true,
        token_addresses: [],
        last_balance_check: null
      }
    })

    let processedCount = 0
    let newRecordsCount = 0
    let updatedCount = 0

    // Iterate through each order
    for (const order of data.orders) {
      processedCount++

      const orderId = String(order.id || order.orderId)
      const orderTxHash = order.txHash || order.tx_hash

      if (!orderTxHash) {
        continue // Skip orders without transaction hash
      }

      // Check if order already exists by order_id
      const existing = await SushiswapActivity.findOne({
        where: { order_id: orderId }
      })

      // Extract token addresses
      const srcTokenAddress = (order.srcTokenAddress || order.srcToken?.address || order.srcToken)?.toLowerCase()
      const dstTokenAddress = (order.dstTokenAddress || order.dstToken?.address || order.dstToken)?.toLowerCase()

      if (!srcTokenAddress || !dstTokenAddress) {
        continue // Skip orders without valid token addresses
      }

      // Fetch token info from database to get decimals and symbols
      const [srcToken, dstToken] = await Promise.all([
        Token.findByAddress(srcTokenAddress, data.chainId || 747474),
        Token.findByAddress(dstTokenAddress, data.chainId || 747474)
      ])

      // Raw amounts from order
      const srcAmountRaw = String(order.srcAmount || order.src_amount || '0')
      const dstAmountRaw = String(order.dstMinAmount || order.dstAmount || order.dst_amount || '0')
      const filledSrcAmountRaw = String(order.filledSrcAmount || '0')
      const filledDstAmountRaw = String(order.filledDstAmount || '0')

      // Normalize amounts by dividing by 10^decimals (if token info available)
      let srcAmount: string
      let dstAmount: string
      let filledSrcAmount: string
      let filledDstAmount: string
      let srcTokenSymbol: string
      let dstTokenSymbol: string

      if (srcToken && dstToken) {
        // Tokens found - normalize amounts
        srcAmount = (parseFloat(srcAmountRaw) / Math.pow(10, srcToken.decimals)).toString()
        dstAmount = (parseFloat(dstAmountRaw) / Math.pow(10, dstToken.decimals)).toString()
        filledSrcAmount = (parseFloat(filledSrcAmountRaw) / Math.pow(10, srcToken.decimals)).toString()
        filledDstAmount = (parseFloat(filledDstAmountRaw) / Math.pow(10, dstToken.decimals)).toString()
        srcTokenSymbol = srcToken.symbol
        dstTokenSymbol = dstToken.symbol
      } else {
        // Tokens not found - store raw values and use symbols from order
        console.warn(`Tokens not found in database, storing raw values: src=${srcTokenAddress}, dst=${dstTokenAddress}`)
        srcAmount = srcAmountRaw
        dstAmount = dstAmountRaw
        filledSrcAmount = filledSrcAmountRaw
        filledDstAmount = filledDstAmountRaw
        srcTokenSymbol = order.srcTokenSymbol || order.srcToken?.symbol || 'UNKNOWN'
        dstTokenSymbol = order.dstTokenSymbol || order.dstToken?.symbol || 'UNKNOWN'
      }

      // Progress
      const progress = order.progress !== undefined ? Number(order.progress) : 0

      // USD volume
      const usdVolume = order.tradeDollarValueIn
        ? parseFloat(order.tradeDollarValueIn)
        : order.usdVolume || 0

      // Calculate execution price
      let executionPrice = 0
      if (parseFloat(filledSrcAmount) > 0 && parseFloat(filledDstAmount) > 0) {
        executionPrice = parseFloat(filledDstAmount) / parseFloat(filledSrcAmount)
      } else if (parseFloat(srcAmount) > 0 && parseFloat(dstAmount) > 0) {
        executionPrice = parseFloat(dstAmount) / parseFloat(srcAmount)
      }

      // Determine status
      let status = 'pending'
      if (order.status === 'OPEN' && progress === 0) {
        status = 'pending'
      } else if (order.status === 'COMPLETED' || progress === 100) {
        status = 'success'
      } else if (progress > 0) {
        status = 'partial'
      } else if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
        status = 'canceled'
      }

      // Parse timestamp
      let timestamp = new Date()
      if (order.createdAt) {
        timestamp = typeof order.createdAt === 'number'
          ? new Date(order.createdAt)
          : new Date(order.createdAt)
      }

      if (existing) {
        // Update existing record with latest data
        await existing.update({
          token_from_amount: srcAmount,
          token_to_amount: dstAmount,
          filled_src_amount: filledSrcAmount,
          filled_dst_amount: filledDstAmount,
          progress: progress,
          status: status,
          usd_volume: usdVolume,
          execution_price: executionPrice,
          metadata: {
            ...existing.metadata,
            orderStatus: order.status,
            deadline: order.deadline,
            fills: order.fills,
            syncedAt: new Date().toISOString()
          }
        })
        updatedCount++
      } else {
        // Create new record
        await SushiswapActivity.create({
          user_id: user.id,
          wallet_address: normalizedWallet,
          swap_type: 'LIMIT_ORDER',
          tx_hash: orderTxHash,
          chain_id: data.chainId || 747474,
          block_number: order.blockNumber ? parseInt(order.blockNumber) : null,
          block_timestamp: null,
          token_from_address: srcTokenAddress,
          token_from_symbol: srcTokenSymbol,
          token_from_amount: srcAmount,
          token_to_address: dstTokenAddress,
          token_to_symbol: dstTokenSymbol,
          token_to_amount: dstAmount,
          usd_volume: usdVolume,
          execution_price: executionPrice,
          pool_id: null,
          order_id: orderId,
          filled_src_amount: filledSrcAmount,
          filled_dst_amount: filledDstAmount,
          is_partial_fill: progress > 0 && progress < 100,
          progress: progress,
          status: status,
          metadata: {
            orderStatus: order.status,
            deadline: order.deadline,
            fills: order.fills,
            syncedAt: new Date().toISOString()
          },
          timestamp: timestamp
        })

        newRecordsCount++
      }
    }

    return res.status(200).json({
      message: 'Limit orders synced successfully',
      summary: {
        processed: processedCount,
        new: newRecordsCount,
        updated: updatedCount
      }
    })

  } catch (error) {
    console.error("Error syncing limit orders:", error)
    next(error)
  }
}
