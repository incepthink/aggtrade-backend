import { Address } from "viem"

// Token information for swap operations
export interface SwapTokenInfo {
  address: Address
  decimals: number
}

// Quote request body
export interface QuoteRequest {
  tokenIn: SwapTokenInfo
  tokenOut: SwapTokenInfo
  amount: string  // Human-readable amount (e.g., "1.5")
  slippage: number  // Percentage (e.g., 0.5 for 0.5%)
}

// Quote response data
export interface QuoteResponse {
  amountOut: string
  priceImpact: string
  swapPrice: string
  amountIn: string
  tokenFrom: string
  tokenTo: string
  status: string
  routerAddress: string
}

// Execute request body (extends QuoteRequest with userAddress)
export interface ExecuteRequest extends QuoteRequest {
  userAddress: Address
}

// Execute response data
export interface ExecuteResponse {
  to: string  // Router contract address
  data: string  // Calldata for transaction
  value: string  // ETH value to send
}

// Yearn Finance - Deposit request body
export interface YearnDepositRequest {
  vaultAddress: Address
  tokenAddress: Address
  amount: string  // Human-readable amount (e.g., "100.5")
  decimals: number  // Token decimals (e.g., 18)
  receiverAddress: Address  // User's wallet address
  userAddress: Address  // For approval check
  chainId: number  // Chain ID (e.g., 747474 for Katana)
}

// Yearn Finance - Withdraw request body
export interface YearnWithdrawRequest {
  vaultAddress: Address
  shares: string  // Amount of vault shares to redeem (human-readable)
  decimals: number  // Vault token decimals
  receiverAddress: Address  // Address to receive underlying assets
  ownerAddress: Address  // Owner of the shares (usually same as receiver)
  maxLoss?: string  // Optional, default "1" (0.01%)
  chainId: number  // Chain ID
}

// Yearn Finance - Transaction data
export interface YearnTransactionData {
  to: string  // Contract address
  data: string  // Encoded calldata
  value: string  // ETH value to send (usually "0")
}

// Yearn Finance - Deposit response (may include approval)
export interface YearnDepositResponse {
  approval?: YearnTransactionData  // Optional approval transaction
  deposit: YearnTransactionData  // Deposit transaction
}

// Yearn Finance - Withdraw response
export interface YearnWithdrawResponse extends YearnTransactionData {}

// TWAP (Orbs) Limit Orders - Fill delay
export interface TwapFillDelay {
  unit: "Seconds" | "Minutes" | "Hours" | "Days"
  value: number
}

// TWAP (Orbs) Limit Orders - Prepare limit order request
export interface TwapLimitOrderRequest {
  srcToken: Address
  dstToken: Address
  srcAmount: string  // Wei amount as string
  dstMinAmount: string  // Wei amount as string
  srcChunkAmount: string  // Wei amount as string (chunk size for TWAP)
  deadline: number  // Unix timestamp
  fillDelay: TwapFillDelay  // Time delay between fills
}

// TWAP (Orbs) Limit Orders - Transaction response
export interface TwapLimitOrderResponse {
  to: string  // TWAP contract address
  data: string  // Encoded transaction data
  value: string  // ETH/RON value to send
}

// Morpho Blue - Withdraw request body
export interface MorphoWithdrawRequest {
  vaultAddress: Address  // Morpho vault address
  assetAddress: Address  // Underlying asset address
  userAddress: Address  // User's wallet address
  amount: string  // Token amount to withdraw (human-readable, e.g., "100.5")
  chainId: number  // Chain ID (747474 for Katana)
  decimals: number  // Asset decimals (e.g., 18)
}

// Morpho Blue - Transaction data
export interface MorphoTransactionData {
  to: string  // Contract address
  data: string  // Encoded calldata
  value: string  // ETH/RON value to send (usually "0")
}

// Morpho Blue - Withdraw response (may include multiple bundled transactions)
export interface MorphoWithdrawResponse {
  transactions: MorphoTransactionData[]  // Array of transactions to execute in sequence
  needsApproval: boolean  // Whether approval is needed
}

// Morpho Blue - Deposit request body
export interface MorphoDepositRequest {
  vaultAddress: Address  // Morpho vault address
  assetAddress: Address  // Underlying asset address
  userAddress: Address  // User's wallet address
  amount: string  // Token amount to deposit (human-readable, e.g., "100.5")
  chainId: number  // Chain ID (747474 for Katana)
  decimals: number  // Asset decimals (e.g., 18)
}

// Morpho Blue - Deposit response (may include approval + deposit bundled transactions)
export interface MorphoDepositResponse {
  transactions: MorphoTransactionData[]  // Array of transactions to execute in sequence
  needsApproval: boolean  // Whether approval is needed (true if approval tx included)
}

// Morpho Blue - Borrow request body
export interface MorphoBorrowRequest {
  marketId: string  // Market ID (unique key from market)
  collateralAmount: string  // Collateral amount to supply (human-readable, e.g., "1.5")
  borrowAmount: string  // Amount to borrow (human-readable, e.g., "100.5")
  collateralDecimals: number  // Collateral token decimals
  borrowDecimals: number  // Borrow token decimals
  userAddress: Address  // User's wallet address
  chainId: number  // Chain ID (747474 for Katana)
}

// Morpho Blue - Borrow response (includes bundled collateral supply + borrow transactions)
export interface MorphoBorrowResponse {
  transactions: MorphoTransactionData[]  // Array of transactions to execute in sequence
  needsApproval: boolean  // Whether collateral approval is needed
}

// Morpho Blue - Repay request body
export interface MorphoRepayRequest {
  marketId: string  // Market ID (unique key from market)
  repayAmount: string  // Amount to repay (human-readable, e.g., "100.5")
  withdrawAmount?: string  // Optional collateral to withdraw (human-readable, e.g., "1.5")
  repayDecimals: number  // Repay token (loan) decimals
  withdrawDecimals?: number  // Withdraw token (collateral) decimals
  userAddress: Address  // User's wallet address
  chainId: number  // Chain ID (747474 for Katana)
}

// Morpho Blue - Repay response (includes bundled repay + optional withdraw transactions)
export interface MorphoRepayResponse {
  transactions: MorphoTransactionData[]  // Array of transactions to execute in sequence
  needsApproval: boolean  // Whether loan token approval is needed
}
