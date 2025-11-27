/**
 * Bot Helper Functions
 * Utilities for amount calculations, price conversions, etc.
 * Mimics the frontend derivedstate-twap-provider.tsx logic
 */

/**
 * Convert human-readable amount to Wei
 */
export function toWei(amount: string, decimals: number): string {
  const amountBigInt = BigInt(Math.floor(parseFloat(amount) * Math.pow(10, decimals)))
  return amountBigInt.toString()
}

/**
 * Convert Wei to human-readable amount
 */
export function fromWei(wei: string, decimals: number): string {
  const weiNum = parseFloat(wei)
  return (weiNum / Math.pow(10, decimals)).toString()
}

/**
 * Calculate output amount based on limit price
 * limitPrice represents how much output token you get for 1 input token
 * Example: if limitPrice = 2000, then 1 ETH = 2000 USDC
 */
export function calculateOutputAmount(
  inputAmount: string,
  limitPrice: number,
  inputDecimals: number,
  outputDecimals: number
): string {
  const inputAmountNumber = parseFloat(inputAmount)
  const outputAmountNumber = inputAmountNumber * limitPrice

  // Convert to Wei
  const outputAmountWei = BigInt(
    Math.floor(outputAmountNumber * Math.pow(10, outputDecimals))
  )

  return outputAmountWei.toString()
}

/**
 * Calculate minimum amount out with slippage
 * For limit orders, we apply a small slippage buffer (0.1%)
 */
export function calculateMinAmountOut(expectedAmountWei: string, slippagePercent: number = 0.1): string {
  const expected = BigInt(expectedAmountWei)
  const slippageFactor = BigInt(Math.floor((100 - slippagePercent) * 100))
  const minAmount = (expected * slippageFactor) / BigInt(10000)
  return minAmount.toString()
}

/**
 * Calculate amount per chunk
 * This mimics TwapSDK.getSrcTokenChunkAmount()
 */
export function calculateChunkAmount(totalAmount: string, chunks: number): string {
  const total = BigInt(totalAmount)
  const chunkAmount = total / BigInt(chunks)
  return chunkAmount.toString()
}

/**
 * Calculate order deadline timestamp (Unix milliseconds)
 */
export function calculateDeadline(expiryHours: number): number {
  const now = Date.now() // Milliseconds
  const expiryMilliseconds = expiryHours * 60 * 60 * 1000
  return now + expiryMilliseconds
}

/**
 * Generate a unique execution ID based on timestamp
 */
export function generateExecutionId(): string {
  const timestamp = Date.now()
  const random = Math.floor(Math.random() * 1000)
  return `exec_${timestamp}_${random}`
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Format timestamp to ISO string
 */
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString()
}

/**
 * Check if token is native ETH
 */
export function isNativeToken(tokenAddress: string): boolean {
  return tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
}

/**
 * Calculate USD volume for tracking
 * Uses simple price lookup
 */
export async function calculateUSDVolume(
  tokenAddress: string,
  amountWei: string,
  decimals: number,
  prices: Record<string, number>
): Promise<number> {
  const normalizedAddress = tokenAddress.toLowerCase()
  const price = prices[normalizedAddress] || 0

  if (price === 0) {
    console.warn(`[USD Volume] No price found for ${tokenAddress}`)
    return 0
  }

  const amount = parseFloat(fromWei(amountWei, decimals))
  return amount * price
}