import type { Request, Response, NextFunction } from "express"
import SushiswapActivity from "../../models/SushiswapActivity"
import User from "../../models/User"
import Token from "../../models/Token"

// SSE clients manager
const sseClients = new Set<Response>()

interface ClassicSwapRequest {
  walletAddress: string
  txHash: string
  chainId?: number
  blockNumber?: number
  blockTimestamp?: string
  tokenFrom: {
    address: string
    symbol: string
    amount: string
  }
  tokenTo: {
    address: string
    symbol: string
    amount: string
  }
  usdVolume: number
  executionPrice: number
  poolId?: string
  timestamp?: string
  status?: 'success' | 'failed' | 'pending'
}

/**
 * POST /tracking/sushiswap/classic-swap
 * Log a classic swap execution from frontend
 */
export const logClassicSwap = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data: ClassicSwapRequest = req.body

    // Validate required fields
    if (!data.walletAddress || !data.txHash || !data.tokenFrom || !data.tokenTo || data.usdVolume === undefined || data.executionPrice === undefined) {
      return res.status(400).json({
        error: 'Missing required fields: walletAddress, txHash, tokenFrom, tokenTo, usdVolume, executionPrice'
      })
    }

    // Normalize wallet address
    const normalizedWallet = data.walletAddress.toLowerCase()

    // Get or create user
    const [user, created] = await User.findOrCreate({
      where: { wallet_address: normalizedWallet },
      defaults: {
        wallet_address: normalizedWallet,
        chain_id: data.chainId || 747474,
        is_active: true,
        token_addresses: [],
        last_balance_check: null
      }
    })

    // Check if transaction already logged
    const existing = await SushiswapActivity.findOne({
      where: { tx_hash: data.txHash }
    })

    if (existing) {
      return res.status(409).json({
        error: 'Transaction already logged',
        activity: existing
      })
    }

    // Create activity record
    const activity = await SushiswapActivity.create({
      user_id: user.id,
      wallet_address: normalizedWallet,
      swap_type: 'CLASSIC',
      tx_hash: data.txHash,
      chain_id: data.chainId || 747474,
      block_number: data.blockNumber || null,
      block_timestamp: data.blockTimestamp ? new Date(data.blockTimestamp) : null,
      token_from_address: data.tokenFrom.address.toLowerCase(),
      token_from_symbol: data.tokenFrom.symbol,
      token_from_amount: data.tokenFrom.amount,
      token_to_address: data.tokenTo.address.toLowerCase(),
      token_to_symbol: data.tokenTo.symbol,
      token_to_amount: data.tokenTo.amount,
      usd_volume: data.usdVolume,
      execution_price: data.executionPrice,
      pool_id: data.poolId || null,
      order_id: null,
      filled_src_amount: null,
      filled_dst_amount: null,
      is_partial_fill: false,
      progress: null,
      status: data.status || 'success',
      metadata: {
        userCreated: created
      },
      timestamp: data.timestamp ? new Date(data.timestamp) : new Date()
    })
    
    // Broadcast to SSE clients
    broadcastNewSwap(activity)

    return res.status(201).json({
      message: 'Classic swap logged successfully',
      activity: {
        id: activity.id,
        txHash: activity.tx_hash,
        swapType: activity.swap_type,
        usdVolume: activity.usd_volume,
        timestamp: activity.timestamp
      }
    })

  } catch (error) {
    next(error)
  }
}

/**
 * GET /tracking/sushiswap/user/:walletAddress/volume
 * Get user's total swap volume
 */
export const getUserVolume = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { walletAddress } = req.params
    const { startDate, endDate } = req.query

    const normalizedWallet = walletAddress.toLowerCase()

    const whereClause: any = {
      wallet_address: normalizedWallet,
      swap_type: 'CLASSIC',
      status: 'success'
    }

    if (startDate && endDate) {
      whereClause.timestamp = {
        $between: [new Date(startDate as string), new Date(endDate as string)]
      }
    }

    const result = await SushiswapActivity.findOne({
      attributes: [
        [SushiswapActivity.sequelize!.fn('SUM', SushiswapActivity.sequelize!.col('usd_volume')), 'total_volume'],
        [SushiswapActivity.sequelize!.fn('COUNT', SushiswapActivity.sequelize!.col('id')), 'swap_count']
      ],
      where: whereClause,
      raw: true
    })

    return res.status(200).json({
      walletAddress,
      totalVolume: (result as any)?.total_volume || 0,
      swapCount: (result as any)?.swap_count || 0
    })

  } catch (error) {
    next(error)
  }
}

/**
 * GET /tracking/sushiswap/user/:walletAddress/history
 * Get user's swap history
 */
export const getUserSwapHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { walletAddress } = req.params
    const { limit = 50, offset = 0 } = req.query

    const normalizedWallet = walletAddress.toLowerCase()

    const swaps = await SushiswapActivity.findAll({
      where: {
        wallet_address: normalizedWallet,
        swap_type: 'CLASSIC'
      },
      order: [['timestamp', 'DESC']],
      limit: Number(limit),
      offset: Number(offset)
    })

    return res.status(200).json({
      walletAddress,
      swaps
    })

  } catch (error) {
    next(error)
  }
}

/**
 * GET /tracking/sushiswap/tx/:txHash
 * Get swap details by transaction hash
 */
export const getSwapByTxHash = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { txHash } = req.params

    const swap = await SushiswapActivity.findOne({
      where: { tx_hash: txHash }
    })

    if (!swap) {
      return res.status(404).json({ error: 'Swap not found' })
    }

    return res.status(200).json({ swap })

  } catch (error) {
    next(error)
  }
}

/**
 * GET /tracking/sushiswap/stream
 * SSE endpoint for real-time swap updates
 */
export const streamSwaps = (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  sseClients.add(res)

  req.on('close', () => {
    sseClients.delete(res)
  })
}

/**
 * Broadcast new swap to all SSE clients
 */
export const broadcastNewSwap = async (activity: SushiswapActivity) => {
  try {
    const tokenFromLookup = activity.token_from_address === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    ? '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62'
    : activity.token_from_address
  const tokenToLookup = activity.token_to_address === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    ? '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62'
    : activity.token_to_address

  const tokens = await Token.findAll({
    where: {
      address: [tokenFromLookup, tokenToLookup]
    },
    attributes: ['address', 'logo_uri'],
    raw: true
  })

  const logoMap = new Map(tokens.map((t: any) => [t.address, t.logo_uri]))

  const swapData = {
    id: activity.id,
    wallet_address: activity.wallet_address,
    swap_type: activity.swap_type,
    token_from_address: activity.token_from_address,
    token_from_amount: activity.token_from_amount,
    token_from_symbol: activity.token_from_symbol,
    token_from_logo: logoMap.get(tokenFromLookup) || null,
    token_to_address: activity.token_to_address,
    token_to_amount: activity.token_to_amount,
    token_to_symbol: activity.token_to_symbol,
    token_to_logo: logoMap.get(tokenToLookup) || null,
    usd_volume: activity.usd_volume.toString(),
    timestamp: activity.timestamp.toISOString(),
    status: activity.status,
    filled_src_amount: activity.filled_src_amount,
    filled_dst_amount: activity.filled_dst_amount,
    is_partial_fill: activity.is_partial_fill
  }
  console.log(swapData);
  

  const message = `data: ${JSON.stringify(swapData)}\n\n`
  sseClients.forEach(client => client.write(message))
  } catch (error) {
    console.log("broadcastNewSwap", error); 
  }
}
