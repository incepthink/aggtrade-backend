// Token information for swap operations
export interface SwapTokenInfo {
  address: string
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
  userAddress: string
}

// Execute response data
export interface ExecuteResponse {
  to: string  // Router contract address
  data: string  // Calldata for transaction
  value: string  // ETH value to send
}
