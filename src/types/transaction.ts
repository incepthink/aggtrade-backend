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
