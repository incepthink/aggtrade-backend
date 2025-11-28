import {redis} from '../../redis'
import { KatanaLogger } from '../../utils/logger'

const PREFIX = '[PriceManager]'

const CACHE_KEY = 'grid_bot:eth_price'
const CACHE_TTL = 30 // 30 seconds
const FALLBACK_PRICE = 2000 // Fallback ETH price in USD

const ETH_ADDRESS = '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62'
const CHAIN_ID = 747474 // Katana

/**
 * Fetch current ETH price from Sushi API with Redis caching
 */
export async function getCurrentETHPrice(): Promise<number> {
  try {
    // 1. Check Redis cache
    const cached = await redis.get(CACHE_KEY)
    if (cached) {
      const price = parseFloat(cached)
      KatanaLogger.info(PREFIX, `ETH price from cache: $${price}`)
      return price
    }

    // 2. Fetch from Sushi API
    const url = `https://api.sushi.com/price/v1/${CHAIN_ID}/${ETH_ADDRESS}`
    KatanaLogger.info(PREFIX, `Fetching ETH price from Sushi API: ${url}`)

    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`Sushi API returned ${response.status}: ${response.statusText}`)
    }

    const data = await response.json()
    const price = data?.price || FALLBACK_PRICE

    if (!price || price <= 0) {
      throw new Error(`Invalid price received: ${price}`)
    }

    // 3. Cache for 30 seconds
    await redis.setex(CACHE_KEY, CACHE_TTL, price.toString())

    KatanaLogger.info(PREFIX, `ETH price from API: $${price} (cached for ${CACHE_TTL}s)`)
    return price
  } catch (error) {
    KatanaLogger.error(PREFIX, 'Failed to fetch ETH price from Sushi API', error)

    // 4. Try to get last cached value (expired or not)
    try {
      const lastCached = await redis.get(CACHE_KEY)
      if (lastCached) {
        const price = parseFloat(lastCached)
        KatanaLogger.warn(PREFIX, `Using expired cached price: $${price}`)
        return price
      }
    } catch (cacheError) {
      KatanaLogger.error(PREFIX, 'Failed to read from cache', cacheError)
    }

    // 5. Final fallback
    KatanaLogger.warn(PREFIX, `Using fallback price: $${FALLBACK_PRICE}`)
    return FALLBACK_PRICE
  }
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

/**
 * Clear price cache (useful for testing or manual refresh)
 */
export async function clearPriceCache(): Promise<void> {
  try {
    await redis.del(CACHE_KEY)
    KatanaLogger.info(PREFIX, 'Price cache cleared')
  } catch (error) {
    KatanaLogger.error(PREFIX, 'Failed to clear price cache', error)
  }
}
