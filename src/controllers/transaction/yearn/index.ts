import type { Request, Response, NextFunction } from "express"
import { encodeFunctionData, parseUnits, createPublicClient, http, type Address } from "viem"
import { erc20ABI, vaultV3ABI } from "../../../abi/yearn"
import type {
  YearnDepositRequest,
  YearnWithdrawRequest,
  YearnDepositResponse,
  YearnWithdrawResponse
} from "../../../types/transaction"
import { katana } from "viem/chains"

/**
 * Validate Ethereum address format
 */
const isValidAddress = (address: string): boolean => {
  return /^0x[a-fA-F0-9]{40}$/.test(address)
}

/**
 * POST /transaction/yearn/deposit/prepare
 * Prepare deposit transaction for Yearn vault
 */
export const prepareYearnDeposit = async (
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<any> => {
  try {
    const {
      vaultAddress,
      tokenAddress,
      amount,
      decimals,
      receiverAddress,
      userAddress,
      chainId
    } = req.body as YearnDepositRequest

    // Validate required fields
    if (!vaultAddress || !tokenAddress || !amount || decimals === undefined || !receiverAddress || !userAddress || !chainId) {
      return res.status(400).json({
        message: "Failed to prepare deposit transaction",
        error: "Missing required fields: vaultAddress, tokenAddress, amount, decimals, receiverAddress, userAddress, chainId"
      })
    }

    // Validate addresses
    if (!isValidAddress(vaultAddress)) {
      return res.status(400).json({
        message: "Failed to prepare deposit transaction",
        error: "Invalid vault address format"
      })
    }

    if (!isValidAddress(tokenAddress)) {
      return res.status(400).json({
        message: "Failed to prepare deposit transaction",
        error: "Invalid token address format"
      })
    }

    if (!isValidAddress(receiverAddress)) {
      return res.status(400).json({
        message: "Failed to prepare deposit transaction",
        error: "Invalid receiver address format"
      })
    }

    if (!isValidAddress(userAddress)) {
      return res.status(400).json({
        message: "Failed to prepare deposit transaction",
        error: "Invalid user address format"
      })
    }

    // Validate amount
    const parsedAmountFloat = parseFloat(amount)
    if (isNaN(parsedAmountFloat) || parsedAmountFloat <= 0) {
      return res.status(400).json({
        message: "Failed to prepare deposit transaction",
        error: "Amount must be greater than 0"
      })
    }

    // Validate decimals
    if (decimals < 0 || decimals > 77 || !Number.isInteger(decimals)) {
      return res.status(400).json({
        message: "Failed to prepare deposit transaction",
        error: "Invalid decimals value"
      })
    }

    // Parse amount to BigInt
    let parsedAmount: bigint
    try {
      parsedAmount = parseUnits(amount, decimals)
    } catch (error) {
      return res.status(400).json({
        message: "Failed to prepare deposit transaction",
        error: "Invalid amount format"
      })
    }

    // Create public client for checking allowance
    const publicClient = createPublicClient({
    chain: katana, // or your custom chain definition
    transport: http('https://rpc.katana.network/') // Your RPC URL
  })
    try {
    } catch (error) {
      return res.status(400).json({
        message: "Failed to prepare deposit transaction",
        error: error instanceof Error ? error.message : String(error)
      })
    }

    // Check if approval is needed
    let needsApproval = false
    try {
      const allowance = await publicClient.readContract({
        address: tokenAddress as Address,
        abi: erc20ABI,
        functionName: "allowance",
        args: [userAddress as Address, vaultAddress as Address],
      }) as bigint

      needsApproval = allowance < parsedAmount
    } catch (error) {
      console.error("[Yearn Deposit] Failed to check allowance:", error)
      return res.status(500).json({
        message: "Failed to prepare deposit transaction",
        error: "Failed to check token approval"
      })
    }

    const response: YearnDepositResponse = {
      deposit: {
        to: "",
        data: "",
        value: "0"
      }
    }

    // Encode approval transaction if needed
    if (needsApproval) {
      try {
        const approvalData = encodeFunctionData({
          abi: erc20ABI,
          functionName: "approve",
          args: [vaultAddress as Address, parsedAmount]
        })

        response.approval = {
          to: tokenAddress,
          data: approvalData,
          value: "0"
        }
      } catch (error) {
        console.error("[Yearn Deposit] Failed to encode approval:", error)
        return res.status(500).json({
          message: "Failed to prepare deposit transaction",
          error: "Failed to encode approval transaction"
        })
      }
    }

    // Encode deposit transaction
    try {
      const depositData = encodeFunctionData({
        abi: vaultV3ABI,
        functionName: "deposit",
        args: [parsedAmount, receiverAddress as Address]
      })

      response.deposit = {
        to: vaultAddress,
        data: depositData,
        value: "0"
      }
    } catch (error) {
      console.error("[Yearn Deposit] Failed to encode deposit:", error)
      return res.status(500).json({
        message: "Failed to prepare deposit transaction",
        error: "Failed to encode deposit transaction"
      })
    }

    return res.status(200).json({
      message: "Deposit transaction prepared",
      data: response
    })

  } catch (error) {
    console.error("[Yearn Deposit] Error:", error)
    return res.status(500).json({
      message: "Failed to prepare deposit transaction",
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * POST /transaction/yearn/withdraw/prepare
 * Prepare withdraw (redeem) transaction from Yearn vault
 */
export const prepareYearnWithdraw = async (
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<any> => {
  try {
    const {
      vaultAddress,
      shares,
      decimals,
      receiverAddress,
      ownerAddress,
      maxLoss,
      chainId
    } = req.body as YearnWithdrawRequest

    // Validate required fields
    if (!vaultAddress || !shares || decimals === undefined || !receiverAddress || !ownerAddress || !chainId) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Missing required fields: vaultAddress, shares, decimals, receiverAddress, ownerAddress, chainId"
      })
    }

    // Validate addresses
    if (!isValidAddress(vaultAddress)) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Invalid vault address format"
      })
    }

    if (!isValidAddress(receiverAddress)) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Invalid receiver address format"
      })
    }

    if (!isValidAddress(ownerAddress)) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Invalid owner address format"
      })
    }

    // Validate shares
    const parsedSharesFloat = parseFloat(shares)
    if (isNaN(parsedSharesFloat) || parsedSharesFloat <= 0) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Shares must be greater than 0"
      })
    }

    // Validate decimals
    if (decimals < 0 || decimals > 77 || !Number.isInteger(decimals)) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Invalid decimals value"
      })
    }

    // Parse shares to BigInt
    let parsedShares: bigint
    try {
      parsedShares = parseUnits(shares, decimals)
    } catch (error) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Invalid shares format"
      })
    }

    // Parse maxLoss (default to "1" which means 0.01%)
    const maxLossValue = maxLoss || "1"
    let parsedMaxLoss: bigint
    try {
      parsedMaxLoss = BigInt(maxLossValue)
    } catch (error) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Invalid maxLoss format"
      })
    }

    // Encode redeem transaction
    let redeemData: string
    try {
      redeemData = encodeFunctionData({
        abi: vaultV3ABI,
        functionName: "redeem",
        args: [parsedShares, receiverAddress as Address, ownerAddress as Address, parsedMaxLoss]
      })
    } catch (error) {
      console.error("[Yearn Withdraw] Failed to encode redeem:", error)
      return res.status(500).json({
        message: "Failed to prepare withdraw transaction",
        error: "Failed to encode redeem transaction"
      })
    }

    const response: YearnWithdrawResponse = {
      to: vaultAddress,
      data: redeemData,
      value: "0"
    }

    return res.status(200).json({
      message: "Withdraw transaction prepared",
      data: response
    })

  } catch (error) {
    console.error("[Yearn Withdraw] Error:", error)
    return res.status(500).json({
      message: "Failed to prepare withdraw transaction",
      error: error instanceof Error ? error.message : String(error)
    })
  }
}