import axios from 'axios'
import { KatanaLogger } from '../../utils/logger'
import { sleep } from '../utils/botHelpers'
import { getToken } from './tokenPairs.config'

const PREFIX = '[PriceManager]'

const MAX_RETRIES = 3 // Maximum number of retry attempts
const RETRY_DELAY_MS = 3000 // 3 seconds delay between retries
const CHAIN_ID = 747474 // Katana

// Fallback prices for different tokens
const FALLBACK_PRICES: Record<string, number> = {
  ETH: 3000,
  USDC: 1,
  JitoSOL: 150,
  LBTC: 95000
}

/**
 * Fetch current token price from Sushi API (no caching, with retry logic)
 */
export async function getCurrentTokenPrice(tokenSymbol: string, silent: boolean = false): Promise<number> {
  // USDC is always $1
  if (tokenSymbol === 'USDC') {
    return 1
  }

  const token = getToken(tokenSymbol)
  const url = `https://api.sushi.com/price/v1/${CHAIN_ID}/${token.address.toLowerCase()}`

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get(url)

      if (!response.data) {
        throw new Error(`Sushi API returned ${response.status}: ${response.statusText}`)
      }

      const price = response.data

      if (!price || price <= 0) {
        throw new Error(`Invalid price received: ${price}`)
      }

      return price
    } catch (error) {
      // If this is not the last attempt, wait and retry
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS)
      } else {
        // Last attempt failed, use fallback
        const fallback = FALLBACK_PRICES[tokenSymbol] || 0
        if (!silent) {
          KatanaLogger.warn(PREFIX, `All ${MAX_RETRIES} attempts failed. Using fallback price for ${tokenSymbol}: $${fallback}`)
        }
        return fallback
      }
    }
  }

  // This should never be reached, but TypeScript requires a return
  return FALLBACK_PRICES[tokenSymbol] || 0
}

/**
 * Fetch current ETH price from Sushi API (no caching, with retry logic)
 * @deprecated Use getCurrentTokenPrice('ETH') instead
 */
export async function getCurrentETHPrice(): Promise<number> {
  return getCurrentTokenPrice('ETH')
}

/**
 * Calculate USD value of token amount
 * @deprecated Use getCurrentTokenPrice() and multiply directly instead
 */
export function calculateUSDValue(
  tokenSymbol: string,
  amount: number,
  tokenPrice: number
): number {
  if (tokenSymbol === 'USDC') {
    return amount
  } else {
    return amount * tokenPrice
  }
}
