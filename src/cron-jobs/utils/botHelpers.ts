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
  inputAmountWei: string,
  limitPrice: number,
  inputDecimals: number,
  outputDecimals: number
): string {
  // Step 1: Convert input WEI to human-readable amount
  const inputHuman = parseFloat(inputAmountWei) / Math.pow(10, inputDecimals)

  // Step 2: Calculate output in human-readable amount
  const outputHuman = inputHuman * limitPrice

  // Step 3: Convert output to WEI
  const outputAmountWei = BigInt(
    Math.floor(outputHuman * Math.pow(10, outputDecimals))
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
 * Calculate order deadline timestamp (Unix seconds)
 * IMPORTANT: TWAP contract expects deadline in SECONDS, not milliseconds
 */
export function calculateDeadline(expiryHours: number): number {
  const nowSeconds = Math.floor(Date.now() / 1000) // Convert to seconds
  const expirySeconds = expiryHours * 60 * 60
  return nowSeconds + expirySeconds
}

/**
 * Generate a unique execution ID based on timestamp
 */
export function generateExecutionId(): string {
  const timestamp = Date.now()
  const random = Math.floor(Math.random() * 1000)
  return `${timestamp}_${random}`
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

/**
 * Format fill delay to human-readable text
 */
export function formatFillDelay(fillDelayMs: number): string {
  const seconds = Math.floor(fillDelayMs / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    return `${days} day${days > 1 ? 's' : ''}`
  }
  if (hours > 0) {
    return `${hours} hour${hours > 1 ? 's' : ''}`
  }
  if (minutes > 0) {
    return `${minutes} minute${minutes > 1 ? 's' : ''}`
  }
  return `${seconds} second${seconds !== 1 ? 's' : ''}`
}

/**
 * Format order for display
 */
export function formatOrder(order: any): string {
  const date = new Date(order.createdAt).toISOString()
  const deadline = new Date(order.deadline).toISOString()
  const fillDelayText = formatFillDelay(order.fillDelayMs)

  return `
Order #${order.id}
  Status: ${order.status}
  Progress: ${order.progress}%
  From: ${order.srcTokenAddress}
  To: ${order.dstTokenAddress}
  Amount In: ${order.srcAmount} (smallest unit)
  Amount Per Chunk: ${order.srcAmountPerChunk} (smallest unit)
  Min Amount Out Per Chunk: ${order.dstMinAmountPerChunk} (smallest unit)
  Filled Src Amount: ${order.filledSrcAmount} (smallest unit)
  Filled Dst Amount: ${order.filledDstAmount} (smallest unit)
  Chunks: ${order.chunks}
  Fill Delay: ${fillDelayText}
  Created: ${date}
  Deadline: ${deadline}
  Maker: ${order.maker}
  Transaction: ${order.txHash}
  `.trim()
}