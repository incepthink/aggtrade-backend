import type { Request, Response, NextFunction } from "express"
import { parseUnits, createPublicClient, http, type Address, encodeFunctionData } from "viem"
import type {
  MorphoWithdrawRequest,
  MorphoWithdrawResponse,
  MorphoDepositRequest,
  MorphoDepositResponse,
  MorphoBorrowRequest,
  MorphoBorrowResponse,
  MorphoRepayRequest,
  MorphoRepayResponse,
  MorphoTransactionData
} from "../../../types/transaction"
import { SimulationState } from "@morpho-org/simulation-sdk"
import {
  type InputBundlerOperation,
  encodeBundle,
  finalizeBundle,
  populateBundle,
} from "@morpho-org/bundler-sdk-viem"
import { addresses, Market, type MarketId, DEFAULT_SLIPPAGE_TOLERANCE,  } from "@morpho-org/blue-sdk"

// Katana chain configuration
const katana = {
  id: 747474,
  name: "Katana",
  nativeCurrency: {
    decimals: 18,
    name: "RON",
    symbol: "RON",
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.katana.network"],
    },
    public: {
      http: ["https://rpc.katana.network"],
    },
  },
} as const

/**
 * Validate Ethereum address format
 */
const isValidAddress = (address: string): boolean => {
  return /^0x[a-fA-F0-9]{40}$/.test(address)
}

/**
 * POST /transaction/morpho/withdraw/prepare
 * Prepare withdraw transaction for Morpho Blue vault using bundler SDK
 */
export const prepareMorphoWithdraw = async (
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<any> => {
  try {
    const {
      vaultAddress,
      assetAddress,
      userAddress,
      amount,
      chainId,
      decimals
    } = req.body as MorphoWithdrawRequest

    // Validate required fields
    if (!vaultAddress || !assetAddress || !userAddress || !amount || !chainId || decimals === undefined) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Missing required fields: vaultAddress, assetAddress, userAddress, amount, chainId, decimals"
      })
    }

    // Validate chain ID (only Katana supported)
    if (chainId !== 747474) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Only Katana (chainId: 747474) is supported"
      })
    }

    // Validate addresses
    if (!isValidAddress(vaultAddress)) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Invalid vault address format"
      })
    }

    if (!isValidAddress(assetAddress)) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Invalid asset address format"
      })
    }

    if (!isValidAddress(userAddress)) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Invalid user address format"
      })
    }

    // Validate amount
    const parsedAmountFloat = parseFloat(amount)
    if (isNaN(parsedAmountFloat) || parsedAmountFloat <= 0) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Amount must be greater than 0"
      })
    }

    // Validate decimals
    if (decimals < 0 || decimals > 77 || !Number.isInteger(decimals)) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Invalid decimals value"
      })
    }

    // Parse amount to BigInt
    let parsedAmount: bigint
    try {
      parsedAmount = parseUnits(amount, decimals)
    } catch (error) {
      return res.status(400).json({
        message: "Failed to prepare withdraw transaction",
        error: "Invalid amount format"
      })
    }

    // Create public client for fetching vault data
    const publicClient = createPublicClient({
      chain: katana,
      transport: http("https://rpc.katana.network")
    })

    console.log("[Morpho Withdraw] Preparing withdraw:", {
      vault: vaultAddress,
      asset: assetAddress,
      user: userAddress,
      amount: amount,
      parsedAmount: parsedAmount.toString(),
      chainId
    })

    // Initialize SimulationState for bundler
    try {
      const block = await publicClient.getBlock()

      const simulationState = new SimulationState({
        chainId: chainId,
        block: {
          number: block.number,
          timestamp: block.timestamp,
        },
      })

      console.log("[Morpho Withdraw] Simulation state initialized:", {
        chainId,
        blockNumber: block.number.toString(),
        blockTimestamp: block.timestamp.toString()
      })

      // Create bundled operations for withdraw
      const inputOperations: InputBundlerOperation[] = [
        {
          type: "MetaMorpho_Withdraw",
          address: vaultAddress as Address,
          sender: userAddress as Address,
          args: {
            assets: parsedAmount,
            receiver: userAddress as Address,
            owner: userAddress as Address,
          },
        },
      ]

      console.log("[Morpho Withdraw] Creating bundled operations...")

      // Populate and finalize bundle
      let { operations } = populateBundle(inputOperations, simulationState, {
        publicAllocatorOptions: {
          enabled: true,
        },
      })

      operations = finalizeBundle(
        operations,
        simulationState,
        userAddress as Address
      )

      console.log("[Morpho Withdraw] Bundle finalized with", operations.length, "operations")

      // Encode bundle (without signatures for now - frontend will handle)
      const bundle = encodeBundle(operations, simulationState, false)

      // Get all required transactions
      const txRequirements = bundle.requirements.txs.map(({ tx }) => tx)
      const mainTx = bundle.tx()
      const allTxs = [...txRequirements, mainTx]

      console.log("[Morpho Withdraw] Generated", allTxs.length, "transaction(s)")

      // Convert to response format
      const transactions: MorphoTransactionData[] = allTxs.map((tx) => {
        return {
          to: tx.to || "",
          data: tx.data || "0x",
          value: tx.value?.toString() || "0"
        }
      })

      const response: MorphoWithdrawResponse = {
        transactions,
        needsApproval: false  // Morpho vault shares don't need approval for withdrawal
      }

      console.log("[Morpho Withdraw] Transaction prepared successfully")

      return res.status(200).json({
        message: "Withdraw transaction prepared",
        data: response
      })

    } catch (error) {
      console.error("[Morpho Withdraw] Failed to prepare bundle:", error)
      return res.status(500).json({
        message: "Failed to prepare withdraw transaction",
        error: error instanceof Error ? error.message : String(error)
      })
    }

  } catch (error) {
    console.error("[Morpho Withdraw] Error:", error)
    return res.status(500).json({
      message: "Failed to prepare withdraw transaction",
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * POST /transaction/morpho/deposit/prepare
 * Prepare deposit transaction for Morpho Blue vault using bundler SDK
 */
export const prepareMorphoDeposit = async (
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<any> => {
  try {
    const {
      vaultAddress,
      assetAddress,
      userAddress,
      amount,
      chainId,
      decimals
    } = req.body as MorphoDepositRequest

    // Validate required fields
    if (!vaultAddress || !assetAddress || !userAddress || !amount || !chainId || decimals === undefined) {
      return res.status(400).json({
        message: "Failed to prepare deposit transaction",
        error: "Missing required fields: vaultAddress, assetAddress, userAddress, amount, chainId, decimals"
      })
    }

    // Validate chain ID (only Katana supported)
    if (chainId !== 747474) {
      return res.status(400).json({
        message: "Failed to prepare deposit transaction",
        error: "Only Katana (chainId: 747474) is supported"
      })
    }

    // Validate addresses
    if (!isValidAddress(vaultAddress)) {
      return res.status(400).json({
        message: "Failed to prepare deposit transaction",
        error: "Invalid vault address format"
      })
    }

    if (!isValidAddress(assetAddress)) {
      return res.status(400).json({
        message: "Failed to prepare deposit transaction",
        error: "Invalid asset address format"
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

    // Create public client for fetching vault data
    const publicClient = createPublicClient({
      chain: katana,
      transport: http("https://rpc.katana.network")
    })

    console.log("[Morpho Deposit] Preparing deposit:", {
      vault: vaultAddress,
      asset: assetAddress,
      user: userAddress,
      amount: amount,
      parsedAmount: parsedAmount.toString(),
      chainId
    })

    // Initialize SimulationState for bundler
    try {
      const block = await publicClient.getBlock()

      const simulationState = new SimulationState({
        chainId: chainId,
        block: {
          number: block.number,
          timestamp: block.timestamp,
        },
      })

      console.log("[Morpho Deposit] Simulation state initialized:", {
        chainId,
        blockNumber: block.number.toString(),
        blockTimestamp: block.timestamp.toString()
      })

      // Create bundled operations for deposit
      const inputOperations: InputBundlerOperation[] = [
        {
          type: "MetaMorpho_Deposit",
          address: vaultAddress as Address,
          sender: userAddress as Address,
          args: {
            assets: parsedAmount,
            owner: userAddress as Address,
          },
        },
      ]

      console.log("[Morpho Deposit] Creating bundled operations...")

      // Populate and finalize bundle
      let { operations } = populateBundle(inputOperations, simulationState, {
        publicAllocatorOptions: {
          enabled: true,
        },
      })

      operations = finalizeBundle(
        operations,
        simulationState,
        userAddress as Address
      )

      console.log("[Morpho Deposit] Bundle finalized with", operations.length, "operations")

      // Encode bundle (without signatures for now - frontend will handle)
      const bundle = encodeBundle(operations, simulationState, false)

      // Get all required transactions
      const txRequirements = bundle.requirements.txs.map(({ tx }) => tx)
      const mainTx = bundle.tx()
      const allTxs = [...txRequirements, mainTx]

      console.log("[Morpho Deposit] Generated", allTxs.length, "transaction(s)")

      // Convert to response format
      const transactions: MorphoTransactionData[] = allTxs.map((tx) => {
        return {
          to: tx.to || "",
          data: tx.data || "0x",
          value: tx.value?.toString() || "0"
        }
      })

      // Check if approval is needed (if there are multiple transactions, first one is approval)
      const needsApproval = allTxs.length > 1

      const response: MorphoDepositResponse = {
        transactions,
        needsApproval
      }

      console.log("[Morpho Deposit] Transaction prepared successfully", {
        needsApproval,
        transactionCount: transactions.length
      })

      return res.status(200).json({
        message: "Deposit transaction prepared",
        data: response
      })

    } catch (error) {
      console.error("[Morpho Deposit] Failed to prepare bundle:", error)
      return res.status(500).json({
        message: "Failed to prepare deposit transaction",
        error: error instanceof Error ? error.message : String(error)
      })
    }

  } catch (error) {
    console.error("[Morpho Deposit] Error:", error)
    return res.status(500).json({
      message: "Failed to prepare deposit transaction",
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * POST /transaction/morpho/borrow/prepare
 * Prepare borrow transaction for Morpho Blue market using bundler SDK
 * This bundles collateral supply + borrow operations into a single transaction
 */
export const prepareMorphoBorrow = async (
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<any> => {
  try {
    const {
      marketId,
      collateralAmount,
      borrowAmount,
      collateralDecimals,
      borrowDecimals,
      userAddress,
      chainId
    } = req.body as MorphoBorrowRequest

    // Validate required fields
    if (!marketId || !collateralAmount || !borrowAmount || !userAddress || !chainId ||
        collateralDecimals === undefined || borrowDecimals === undefined) {
      return res.status(400).json({
        message: "Failed to prepare borrow transaction",
        error: "Missing required fields: marketId, collateralAmount, borrowAmount, collateralDecimals, borrowDecimals, userAddress, chainId"
      })
    }

    // Validate chain ID (only Katana supported)
    if (chainId !== 747474) {
      return res.status(400).json({
        message: "Failed to prepare borrow transaction",
        error: "Only Katana (chainId: 747474) is supported"
      })
    }

    // Validate user address
    if (!isValidAddress(userAddress)) {
      return res.status(400).json({
        message: "Failed to prepare borrow transaction",
        error: "Invalid user address format"
      })
    }

    // Validate amounts
    const parsedCollateralFloat = parseFloat(collateralAmount)
    if (isNaN(parsedCollateralFloat) || parsedCollateralFloat <= 0) {
      return res.status(400).json({
        message: "Failed to prepare borrow transaction",
        error: "Collateral amount must be greater than 0"
      })
    }

    const parsedBorrowFloat = parseFloat(borrowAmount)
    if (isNaN(parsedBorrowFloat) || parsedBorrowFloat <= 0) {
      return res.status(400).json({
        message: "Failed to prepare borrow transaction",
        error: "Borrow amount must be greater than 0"
      })
    }

    // Validate decimals
    if (collateralDecimals < 0 || collateralDecimals > 77 || !Number.isInteger(collateralDecimals)) {
      return res.status(400).json({
        message: "Failed to prepare borrow transaction",
        error: "Invalid collateral decimals value"
      })
    }

    if (borrowDecimals < 0 || borrowDecimals > 77 || !Number.isInteger(borrowDecimals)) {
      return res.status(400).json({
        message: "Failed to prepare borrow transaction",
        error: "Invalid borrow decimals value"
      })
    }

    // Parse amounts to BigInt
    let parsedCollateral: bigint
    let parsedBorrow: bigint
    try {
      parsedCollateral = parseUnits(collateralAmount, collateralDecimals)
      parsedBorrow = parseUnits(borrowAmount, borrowDecimals)
    } catch (error) {
      return res.status(400).json({
        message: "Failed to prepare borrow transaction",
        error: "Invalid amount format"
      })
    }

    // Create public client for fetching market data
    const publicClient = createPublicClient({
      chain: katana,
      transport: http("https://rpc.katana.network")
    })

    console.log("[Morpho Borrow] Preparing borrow:", {
      marketId,
      collateral: collateralAmount,
      borrow: borrowAmount,
      user: userAddress,
      parsedCollateral: parsedCollateral.toString(),
      parsedBorrow: parsedBorrow.toString(),
      chainId
    })

    // Initialize SimulationState for bundler
    try {
      const block = await publicClient.getBlock()

      const simulationState = new SimulationState({
        chainId: chainId,
        block: {
          number: block.number,
          timestamp: block.timestamp,
        },
      })

      console.log("[Morpho Borrow] Simulation state initialized:", {
        chainId,
        blockNumber: block.number.toString(),
        blockTimestamp: block.timestamp.toString()
      })

      // Fetch market parameters to populate SDK cache
      console.log("[Morpho Borrow] Fetching market parameters from blockchain...")
      try {
        await Market.fetch(marketId as MarketId, publicClient)
        console.log("[Morpho Borrow] Market parameters loaded successfully")
      } catch (error) {
        console.error("[Morpho Borrow] Failed to fetch market parameters:", error)
        return res.status(400).json({
          message: "Failed to prepare borrow transaction",
          error: "Market not found on-chain. Please verify the market exists and is valid."
        })
      }

      // Create bundled operations for collateral supply + borrow
      const inputOperations: InputBundlerOperation[] = [
        {
          type: "Blue_SupplyCollateral",
          sender: userAddress as Address,
          args: {
            id: marketId as MarketId,
            assets: parsedCollateral,
            onBehalf: userAddress as Address,
          },
        },
        {
          type: "Blue_Borrow",
          sender: userAddress as Address,
          args: {
            id: marketId as MarketId,
            assets: parsedBorrow,
            onBehalf: userAddress as Address,
            receiver: userAddress as Address,
            slippage: DEFAULT_SLIPPAGE_TOLERANCE,
          },
        },
      ]

      console.log("[Morpho Borrow] Creating bundled operations...")

      // Populate and finalize bundle
      let { operations } = populateBundle(inputOperations, simulationState, {
        publicAllocatorOptions: {
          enabled: true,
        },
      })

      operations = finalizeBundle(
        operations,
        simulationState,
        userAddress as Address
      )

      console.log("[Morpho Borrow] Bundle finalized with", operations.length, "operations")

      // Encode bundle (without signatures - frontend will handle)
      const bundle = encodeBundle(operations, simulationState, false)

      // Get all required transactions
      const txRequirements = bundle.requirements.txs.map(({ tx }) => tx)
      const mainTx = bundle.tx()
      const allTxs = [...txRequirements, mainTx]

      console.log("[Morpho Borrow] Generated", allTxs.length, "transaction(s)")

      // Convert to response format
      const transactions: MorphoTransactionData[] = allTxs.map((tx) => {
        return {
          to: tx.to || "",
          data: tx.data || "0x",
          value: tx.value?.toString() || "0"
        }
      })

      // Check if approval is needed (if there are multiple transactions, first one is approval)
      const needsApproval = allTxs.length > 1

      const response: MorphoBorrowResponse = {
        transactions,
        needsApproval
      }

      console.log("[Morpho Borrow] Transaction prepared successfully", {
        needsApproval,
        transactionCount: transactions.length
      })

      return res.status(200).json({
        message: "Borrow transaction prepared",
        data: response
      })

    } catch (error) {
      console.error("[Morpho Borrow] Failed to prepare bundle:", error)
      return res.status(500).json({
        message: "Failed to prepare borrow transaction",
        error: error instanceof Error ? error.message : String(error)
      })
    }

  } catch (error) {
    console.error("[Morpho Borrow] Error:", error)
    return res.status(500).json({
      message: "Failed to prepare borrow transaction",
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * POST /transaction/morpho/repay/prepare
 * Prepare repay transaction for Morpho Blue market using bundler SDK
 * This bundles loan repayment + optional collateral withdraw operations into a single transaction
 */
export const prepareMorphoRepay = async (
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<any> => {
  try {
    const {
      marketId,
      repayAmount,
      withdrawAmount,
      repayDecimals,
      withdrawDecimals,
      userAddress,
      chainId
    } = req.body as MorphoRepayRequest

    // Validate required fields
    if (!marketId || !repayAmount || !userAddress || !chainId || repayDecimals === undefined) {
      return res.status(400).json({
        message: "Failed to prepare repay transaction",
        error: "Missing required fields: marketId, repayAmount, repayDecimals, userAddress, chainId"
      })
    }

    // Validate chain ID (only Katana supported)
    if (chainId !== 747474) {
      return res.status(400).json({
        message: "Failed to prepare repay transaction",
        error: "Only Katana (chainId: 747474) is supported"
      })
    }

    // Validate user address
    if (!isValidAddress(userAddress)) {
      return res.status(400).json({
        message: "Failed to prepare repay transaction",
        error: "Invalid user address format"
      })
    }

    // Validate repay amount
    const parsedRepayFloat = parseFloat(repayAmount)
    if (isNaN(parsedRepayFloat) || parsedRepayFloat <= 0) {
      return res.status(400).json({
        message: "Failed to prepare repay transaction",
        error: "Repay amount must be greater than 0"
      })
    }

    // Validate repay decimals
    if (repayDecimals < 0 || repayDecimals > 77 || !Number.isInteger(repayDecimals)) {
      return res.status(400).json({
        message: "Failed to prepare repay transaction",
        error: "Invalid repay decimals value"
      })
    }

    // Validate optional withdraw amount and decimals
    let hasWithdraw = false
    if (withdrawAmount && parseFloat(withdrawAmount) > 0) {
      hasWithdraw = true

      const parsedWithdrawFloat = parseFloat(withdrawAmount)
      if (isNaN(parsedWithdrawFloat) || parsedWithdrawFloat <= 0) {
        return res.status(400).json({
          message: "Failed to prepare repay transaction",
          error: "Withdraw amount must be greater than 0 if provided"
        })
      }

      if (withdrawDecimals === undefined) {
        return res.status(400).json({
          message: "Failed to prepare repay transaction",
          error: "withdrawDecimals is required when withdrawAmount is provided"
        })
      }

      if (withdrawDecimals < 0 || withdrawDecimals > 77 || !Number.isInteger(withdrawDecimals)) {
        return res.status(400).json({
          message: "Failed to prepare repay transaction",
          error: "Invalid withdraw decimals value"
        })
      }
    }

    // Parse amounts to BigInt
    let parsedRepay: bigint
    let parsedWithdraw: bigint | undefined
    try {
      parsedRepay = parseUnits(repayAmount, repayDecimals)

      if (hasWithdraw && withdrawAmount && withdrawDecimals !== undefined) {
        parsedWithdraw = parseUnits(withdrawAmount, withdrawDecimals)
      }
    } catch (error) {
      return res.status(400).json({
        message: "Failed to prepare repay transaction",
        error: "Invalid amount format"
      })
    }

    // Create public client for fetching market data
    const publicClient = createPublicClient({
      chain: katana,
      transport: http("https://rpc.katana.network")
    })

    console.log("[Morpho Repay] Preparing repay:", {
      marketId,
      repay: repayAmount,
      withdraw: withdrawAmount || "0",
      user: userAddress,
      parsedRepay: parsedRepay.toString(),
      parsedWithdraw: parsedWithdraw?.toString() || "0",
      chainId
    })

    // Initialize SimulationState for bundler
    try {
      const block = await publicClient.getBlock()

      const simulationState = new SimulationState({
        chainId: chainId,
        block: {
          number: block.number,
          timestamp: block.timestamp,
        },
      })

      console.log("[Morpho Repay] Simulation state initialized:", {
        chainId,
        blockNumber: block.number.toString(),
        blockTimestamp: block.timestamp.toString()
      })

      // Fetch market parameters to populate SDK cache
      console.log("[Morpho Repay] Fetching market parameters from blockchain...")
      try {
        await Market.fetch(marketId as MarketId, publicClient)
        console.log("[Morpho Repay] Market parameters loaded successfully")
      } catch (error) {
        console.error("[Morpho Repay] Failed to fetch market parameters:", error)
        return res.status(400).json({
          message: "Failed to prepare repay transaction",
          error: "Market not found on-chain. Please verify the market exists and is valid."
        })
      }

      // Create bundled operations for repay + optional withdraw
      const inputOperations: InputBundlerOperation[] = [
        {
          type: "Blue_Repay",
          sender: userAddress as Address,
          args: {
            id: marketId as MarketId,
            assets: parsedRepay,
            onBehalf: userAddress as Address,
            slippage: DEFAULT_SLIPPAGE_TOLERANCE,
          },
        },
      ]

      // Add withdraw operation if amount provided
      if (hasWithdraw && parsedWithdraw !== undefined) {
        console.log("[Morpho Repay] Adding withdraw collateral operation")
        inputOperations.push({
          type: "Blue_WithdrawCollateral",
          sender: userAddress as Address,
          args: {
            id: marketId as MarketId,
            assets: parsedWithdraw,
            onBehalf: userAddress as Address,
            receiver: userAddress as Address,
          },
        })
      }

      console.log("[Morpho Repay] Creating bundled operations...")

      // Populate and finalize bundle
      let { operations } = populateBundle(inputOperations, simulationState, {
        publicAllocatorOptions: {
          enabled: true,
        },
      })

      operations = finalizeBundle(
        operations,
        simulationState,
        userAddress as Address
      )

      console.log("[Morpho Repay] Bundle finalized with", operations.length, "operations")

      // Encode bundle (without signatures - frontend will handle)
      const bundle = encodeBundle(operations, simulationState, false)

      // Get all required transactions
      const txRequirements = bundle.requirements.txs.map(({ tx }) => tx)
      const mainTx = bundle.tx()
      const allTxs = [...txRequirements, mainTx]

      console.log("[Morpho Repay] Generated", allTxs.length, "transaction(s)")

      // Convert to response format
      const transactions: MorphoTransactionData[] = allTxs.map((tx) => {
        return {
          to: tx.to || "",
          data: tx.data || "0x",
          value: tx.value?.toString() || "0"
        }
      })

      // Check if approval is needed (if there are multiple transactions, first one is approval)
      const needsApproval = allTxs.length > 1

      const response: MorphoRepayResponse = {
        transactions,
        needsApproval
      }

      console.log("[Morpho Repay] Transaction prepared successfully", {
        needsApproval,
        transactionCount: transactions.length
      })

      return res.status(200).json({
        message: "Repay transaction prepared",
        data: response
      })

    } catch (error) {
      console.error("[Morpho Repay] Failed to prepare bundle:", error)
      return res.status(500).json({
        message: "Failed to prepare repay transaction",
        error: error instanceof Error ? error.message : String(error)
      })
    }

  } catch (error) {
    console.error("[Morpho Repay] Error:", error)
    return res.status(500).json({
      message: "Failed to prepare repay transaction",
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
