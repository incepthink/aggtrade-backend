import axios from 'axios'
import { KatanaLogger } from '../../utils/logger'
import { sleep } from '../utils/botHelpers'

const PREFIX = '[PriceManager]'

const FALLBACK_PRICE = 3000 // Fallback ETH price in USD
const MAX_RETRIES = 3 // Maximum number of retry attempts
const RETRY_DELAY_MS = 3000 // 3 seconds delay between retries

const ETH_ADDRESS = '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62'
const CHAIN_ID = 747474 // Katana

/**
 * Fetch current ETH price from Sushi API (no caching, with retry logic)
 */
export async function getCurrentETHPrice(): Promise<number> {
  const url = `https://api.sushi.com/price/v1/${CHAIN_ID}/${ETH_ADDRESS.toLowerCase()}`

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      KatanaLogger.info(PREFIX, `Fetching ETH price from Sushi API (attempt ${attempt}/${MAX_RETRIES}): ${url}`)

      const response = await axios.get(url)

      if (!response.data) {
        throw new Error(`Sushi API returned ${response.status}: ${response.statusText}`)
      }

      const data = await response.data
      const price = data

      if (!price || price <= 0) {
        throw new Error(`Invalid price received: ${price}`)
      }

      KatanaLogger.info(PREFIX, `ETH price from API: $${price}`)
      return price
    } catch (error) {
      KatanaLogger.error(PREFIX, `Failed to fetch ETH price (attempt ${attempt}/${MAX_RETRIES})`, error)

      // If this is not the last attempt, wait and retry
      if (attempt < MAX_RETRIES) {
        KatanaLogger.info(PREFIX, `Waiting ${RETRY_DELAY_MS / 1000}s before retry...`)
        await sleep(RETRY_DELAY_MS)
      } else {
        // Last attempt failed, use fallback
        KatanaLogger.warn(PREFIX, `All ${MAX_RETRIES} attempts failed. Using fallback price: $${FALLBACK_PRICE}`)
        return FALLBACK_PRICE
      }
    }
  }

  // This should never be reached, but TypeScript requires a return
  return FALLBACK_PRICE
}

/**
 * Calculate USD value of token amount
 */
export function calculateUSDValue(
  tokenSymbol: string,
  amount: number,
  ethPrice: number
): number {
  if (tokenSymbol === 'USDC') {
    return amount
  } else if (tokenSymbol === 'ETH' || tokenSymbol === 'WETH') {
    return amount * ethPrice
  } else {
    throw new Error(`Unsupported token: ${tokenSymbol}`)
  }
}
