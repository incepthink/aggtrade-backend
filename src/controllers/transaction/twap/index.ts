import type { Request, Response, NextFunction } from "express"
import { TwapService } from "../../../services/twap"
import type { TwapLimitOrderRequest } from "../../../types/transaction"

/**
 * POST /transaction/twap/limit-order/prepare
 * Prepare TWAP limit order transaction for SushiSwap on Katana
 */
export const prepareLimitOrder = async (
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<any> => {
  try {
    const {
      srcToken,
      dstToken,
      srcAmount,
      dstMinAmount,
      srcChunkAmount,
      deadline,
      fillDelay,
    } = req.body as TwapLimitOrderRequest

    // Validate required fields
    if (!srcToken || !dstToken) {
      return res.status(400).json({
        error: 'Missing required fields: srcToken and dstToken are required'
      })
    }

    if (!srcAmount || !dstMinAmount || !srcChunkAmount) {
      return res.status(400).json({
        error: 'Missing required fields: srcAmount, dstMinAmount, and srcChunkAmount are required'
      })
    }

    if (!deadline) {
      return res.status(400).json({
        error: 'Missing required field: deadline is required'
      })
    }

    if (!fillDelay || !fillDelay.unit || !fillDelay.value) {
      return res.status(400).json({
        error: 'Invalid fillDelay: must have {unit, value} where unit is one of [Seconds, Minutes, Hours, Days]'
      })
    }

    // Validate fillDelay unit
    const validUnits = ['Seconds', 'Minutes', 'Hours', 'Days']
    if (!validUnits.includes(fillDelay.unit)) {
      return res.status(400).json({
        error: `Invalid fillDelay.unit: must be one of ${validUnits.join(', ')}`
      })
    }

    // Validate amounts are valid BigInt strings
    try {
      BigInt(srcAmount)
      BigInt(dstMinAmount)
      BigInt(srcChunkAmount)
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid amount format: srcAmount, dstMinAmount, and srcChunkAmount must be valid Wei amounts (string representation of BigInt)'
      })
    }

    // Validate deadline is in the future
    const now = Math.floor(Date.now() / 1000)
    if (deadline <= now) {
      return res.status(400).json({
        error: 'Invalid deadline: must be in the future'
      })
    }

    // Validate fillDelay value is positive
    if (fillDelay.value <= 0) {
      return res.status(400).json({
        error: 'Invalid fillDelay.value: must be positive'
      })
    }

    // Prepare limit order transaction
    const transaction = TwapService.prepareLimitOrder({
      srcToken,
      dstToken,
      srcAmount,
      dstMinAmount,
      srcChunkAmount,
      deadline,
      fillDelay,
    })

    console.log('[TWAP Controller] Transaction prepared:', {
      to: transaction.to,
      value: transaction.value,
      dataLength: transaction.data.length
    })

    return res.status(200).json({
      message: 'Limit order transaction prepared successfully',
      data: transaction
    })

  } catch (error) {
    console.error('[TWAP Limit Order] Error:', error)
    return res.status(500).json({
      error: 'Failed to prepare limit order transaction',
      details: error instanceof Error ? error.message : String(error)
    })
  }
}