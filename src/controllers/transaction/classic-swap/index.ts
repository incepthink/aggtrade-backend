import type { Request, Response, NextFunction } from "express"
import { ChainId } from "sushi"
import { getQuote, getSwap } from "sushi/evm"
import type { QuoteRequest, ExecuteRequest } from "../../../types/transaction"
import { Address, decodeAbiParameters, parseAbiParameters } from "viem"
import { extractPoolFeeTiers } from "./poolFeeExtractor"

/**
 * POST /transaction/classic-swap/quote
 * Generate swap quote with router address
 */
export const getClassicSwapQuote = async (
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<any> => {
  try {
    const { tokenIn, tokenOut, amount, slippage } = req.body as QuoteRequest

    // Validate required fields
    if (!tokenIn || !tokenOut || !amount || slippage === undefined) {
      return res.status(400).json({
        error: 'Missing required fields: tokenIn, tokenOut, amount, slippage'
      })
    }

    // Validate tokenIn structure
    if (!tokenIn.address || tokenIn.decimals === undefined) {
      return res.status(400).json({
        error: 'Invalid tokenIn: address and decimals required'
      })
    }

    // Validate tokenOut structure
    if (!tokenOut.address || tokenOut.decimals === undefined) {
      return res.status(400).json({
        error: 'Invalid tokenOut: address and decimals required'
      })
    }

    // Validate amount
    const parsedAmount = parseFloat(amount)
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        error: 'Invalid amount: must be a positive number'
      })
    }

    // Convert amount to Wei
    const amountInWei = BigInt(
      Math.floor(parsedAmount * Math.pow(10, tokenIn.decimals))
    )

    // Get quote data from Sushi SDK
    const quote = await getQuote({
      chainId: ChainId.KATANA,
      tokenIn: tokenIn.address as Address,
      tokenOut: tokenOut.address as Address,
      amount: amountInWei,
      maxSlippage: slippage / 100
    })

    // Get router address using dummy sender
    const dummySwap = await getSwap({
      chainId: ChainId.KATANA,
      tokenIn: tokenIn.address as Address,
      tokenOut: tokenOut.address as Address,
      amount: amountInWei,
      maxSlippage: slippage / 100,
      sender: "0x0000000000000000000000000000000000000000"
    })

    const routerAddress = dummySwap.tx?.to || ''
    console.log(dummySwap, quote);

    // Extract pool fee tiers from transaction data
    let poolFees: any[] = []
    if (dummySwap.tx?.data) {
      try {
        // Get token addresses to exclude from pool search
        const excludeAddresses = [
          tokenIn.address.toLowerCase(),
          tokenOut.address.toLowerCase(),
        ]
        poolFees = await extractPoolFeeTiers(dummySwap.tx.data, excludeAddresses)
        console.log('[Classic Swap Quote] Pool fees:', poolFees)
      } catch (error) {
        console.error('[Classic Swap Quote] Error extracting pool fees:', error)
      }
    }

    // Format response
    return res.status(200).json({
      message: 'Quote generated successfully',
      data: {
        amountOut: quote.assumedAmountOut?.toString() || '0',
        priceImpact: quote.priceImpact?.toString() || '0',
        swapPrice: quote.swapPrice?.toString() || '0',
        amountIn: quote.amountIn?.toString() || amountInWei.toString(),
        tokenFrom: quote.tokenFrom?.address || tokenIn.address,
        tokenTo: quote.tokenTo?.address || tokenOut.address,
        status: quote.status || 'success',
        routerAddress,
        poolFees: poolFees.map(pf => ({
          poolAddress: pf.poolAddress,
          feeTier: pf.feeTier,
          feePercentage: pf.feePercentage
        }))
      }
    })

  } catch (error) {
    console.error('[Classic Swap Quote] Error:', error)
    return res.status(500).json({
      error: 'Failed to generate quote',
      details: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * POST /transaction/classic-swap/execute
 * Generate swap transaction data for execution
 */
export const executeClassicSwap = async (
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<any> => {
  try {
    const { tokenIn, tokenOut, amount, slippage, userAddress } = req.body as ExecuteRequest

    // Validate required fields
    if (!tokenIn || !tokenOut || !amount || slippage === undefined || !userAddress) {
      return res.status(400).json({
        error: 'Missing required fields: tokenIn, tokenOut, amount, slippage, userAddress'
      })
    }

    // Validate tokenIn structure
    if (!tokenIn.address || tokenIn.decimals === undefined) {
      return res.status(400).json({
        error: 'Invalid tokenIn: address and decimals required'
      })
    }

    // Validate tokenOut structure
    if (!tokenOut.address || tokenOut.decimals === undefined) {
      return res.status(400).json({
        error: 'Invalid tokenOut: address and decimals required'
      })
    }

    // Validate userAddress format
    const addressRegex = /^0x[a-fA-F0-9]{40}$/
    if (!addressRegex.test(userAddress)) {
      return res.status(400).json({
        error: 'Invalid userAddress format'
      })
    }

    // Validate amount
    const parsedAmount = parseFloat(amount)
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        error: 'Invalid amount: must be a positive number'
      })
    }

    // Convert amount to Wei
    const amountInWei = BigInt(
      Math.floor(parsedAmount * Math.pow(10, tokenIn.decimals))
    )

    // Get swap transaction data from Sushi SDK
    const swap = await getSwap({
      chainId: ChainId.KATANA,
      tokenIn: tokenIn.address as Address,
    tokenOut: tokenOut.address as Address,
      amount: amountInWei,
      maxSlippage: slippage / 100,
      sender: userAddress as Address
    })

    // Validate swap response
    if (!swap || !swap.tx || !swap.tx.to || !swap.tx.data) {
      return res.status(500).json({
        error: 'Failed to generate swap transaction',
        details: 'Invalid response from Sushi SDK'
      })
    }

    // Extract pool fee tiers from transaction data
    let poolFees: any[] = []
    let totalFees: any = null
    try {
      // Get token addresses to exclude from pool search
      const excludeAddresses = [
        tokenIn.address.toLowerCase(),
        tokenOut.address.toLowerCase(),
      ]
      poolFees = await extractPoolFeeTiers(swap.tx.data, excludeAddresses)
      console.log('[Classic Swap Execute] Pool fees:', poolFees)

      // Calculate total fees if we have pool fee info
      if (poolFees.length > 0 && swap.amountIn) {
        const { calculateTotalFees } = await import('./poolFeeExtractor')
        const amountInBigInt = BigInt(swap.amountIn)
        const feeCalculation = calculateTotalFees(amountInBigInt, poolFees)

        totalFees = {
          totalFeeAmount: feeCalculation.totalFeeAmount.toString(),
          totalFeePercentage: feeCalculation.totalFeePercentage,
          feeBreakdown: feeCalculation.feeBreakdown.map(fb => ({
            poolAddress: fb.pool,
            feeAmount: fb.feeAmount.toString(),
            feeTier: fb.feeTier,
            feePercentage: `${fb.feeTier / 10000}%`
          }))
        }
      }
    } catch (error) {
      console.error('[Classic Swap Execute] Error extracting pool fees:', error)
    }

    // Format response
    return res.status(200).json({
      message: 'Swap transaction generated successfully',
      data: {
        to: swap.tx.to,
        data: swap.tx.data,
        value: swap.tx.value?.toString() || '0',
        poolFees: poolFees.map(pf => ({
          poolAddress: pf.poolAddress,
          feeTier: pf.feeTier,
          feePercentage: pf.feePercentage
        })),
        fees: totalFees
      }
    })

  } catch (error) {
    console.error('[Classic Swap Execute] Error:', error)
    return res.status(500).json({
      error: 'Failed to generate swap transaction',
      details: error instanceof Error ? error.message : String(error)
    })
  }
}
