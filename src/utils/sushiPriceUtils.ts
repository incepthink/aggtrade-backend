// utils/sushiPriceUtils.ts
import axios from "axios";

type Address = string;

// Sushi API URL
const SUSHI_API_BASE = "https://api.sushi.com/price/v1";

// Cache for token prices to avoid repeated API calls
const priceCache = new Map<string, { price: number; timestamp: number }>();
const CACHE_TTL = 60 * 1000; // 1 minute cache

/**
 * Fetch token price from Sushi API with caching
 */
export const fetchTokenPriceFromSushi = async (
  tokenAddress: Address,
  chainId: number
): Promise<number | null> => {
  const cacheKey = `${chainId}-${tokenAddress.toLowerCase()}`;
  const now = Date.now();
  
  // Check cache first
  const cached = priceCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    // console.log(`Using cached price for ${tokenAddress}: $${cached.price}`);
    return cached.price;
  }

  console.log("Fetching price from Sushi API for:", tokenAddress);

  try {
    const { data } = await axios.get(
      `${SUSHI_API_BASE}/${chainId}/${tokenAddress}`,
      {
        timeout: 5000, // 5 second timeout for price fetching
      }
    );

    console.log("Sushi API response:", data);

    if (!data || typeof data !== 'number') {
      // Fallback for Katana (chainId 747474) - use SushiSwap V3 contract
      if (chainId === 747474) {
        console.log("Using SushiSwap V3 contract fallback for Katana...");
        try {
          const fallbackPrice = await fetchTokenPriceFromSushiV3(tokenAddress);
          console.log("SushiV3 fallback price:", fallbackPrice);
          
          if (fallbackPrice !== null) {
            // Cache the fallback price
            priceCache.set(cacheKey, { price: fallbackPrice, timestamp: now });
            return fallbackPrice;
          }
        } catch (fallbackError) {
          console.error("SushiV3 fallback also failed:", fallbackError);
        }
      }
      return null;
    }

    // Cache the successful result
    priceCache.set(cacheKey, { price: data, timestamp: now });
    
    return data;
  } catch (error) {
    console.error("Failed to fetch token price from Sushi API:", error);

    // Fallback for Katana (chainId 747474)
    if (chainId === 747474) {
      console.log("Using SushiSwap V3 contract fallback for Katana...");
      try {
        const fallbackPrice = await fetchTokenPriceFromSushiV3(tokenAddress);
        if (fallbackPrice !== null) {
          priceCache.set(cacheKey, { price: fallbackPrice, timestamp: now });
          return fallbackPrice;
        }
      } catch (fallbackError) {
        console.error("SushiV3 fallback also failed:", fallbackError);
      }
    }

    if (axios.isAxiosError(error)) {
      if (error.response?.status === 404) {
        console.warn("Token not found on this network:", tokenAddress);
        return null;
      }
    }

    return null;
  }
};

/**
 * Placeholder for SushiV3 contract fallback - implement based on your existing logic
 */
const fetchTokenPriceFromSushiV3 = async (tokenAddress: Address): Promise<number | null> => {
  // TODO: Implement your existing SushiV3 contract fallback logic here
  console.log("SushiV3 fallback not yet implemented for:", tokenAddress);
  return null;
};

/**
 * Get USD price for a token, with fallback logic
 */
export const getTokenUSDPrice = async (
  tokenAddress: string,
  tokenSymbol: string,
  chainId: number = 747474 // Default to Katana
): Promise<number> => {
  const normalizedAddress = tokenAddress.toLowerCase();
  
  // Known stable tokens
  const STABLE_TOKENS = {
    "0x203a662b0bd271a6ed5a60edfbd04bfce608fd36": 1.0, // USDC
    "0x00000000efe302beaa2b3e6e1b18d08d69a9012a": 1.0, // AUSD
  };

  // Check if it's a known stable token
  //@ts-ignore
  if (STABLE_TOKENS[normalizedAddress]) {
    //@ts-ignore
    return STABLE_TOKENS[normalizedAddress];
  }

  // Fetch from Sushi API
  const price = await fetchTokenPriceFromSushi(normalizedAddress, chainId);
  
  if (price !== null && price > 0) {
    // console.log(`Got price for ${tokenSymbol} (${tokenAddress}): $${price}`);
    return price;
  }

  console.warn(`Could not fetch price for ${tokenSymbol} (${tokenAddress}), defaulting to 0`);
  return 0;
};