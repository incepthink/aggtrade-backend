// src/controllers/katana/utils/priceCalculations.ts

import { USDC_KATANA, AUSD_KATANA } from './constants';
import type { SwapData, TokenPrices } from './types';

/**
 * Convert sqrtPriceX96 to token prices
 * Used for Uniswap V3 / SushiSwap V3 pools
 */
export function sqrtPriceX96ToTokenPrices(
  sqrtPriceX96: string,
  token0Decimals: number,
  token1Decimals: number
): TokenPrices {
  try {
    const Q192 = BigInt(2) ** BigInt(192);
    const sqrtPrice = BigInt(sqrtPriceX96);
    const price = sqrtPrice * sqrtPrice;
    
    const token0DecimalsBN = BigInt(10) ** BigInt(token0Decimals);
    const token1DecimalsBN = BigInt(10) ** BigInt(token1Decimals);
    
    // Convert to regular numbers for calculation
    const priceNumber = Number(price) / Number(Q192);
    const token0Price = priceNumber * Number(token0DecimalsBN) / Number(token1DecimalsBN);
    const token1Price = 1 / token0Price;
    
    return { token0Price, token1Price };
  } catch (error) {
    console.error("Error calculating price from sqrtPriceX96:", error);
    return { token0Price: 0, token1Price: 0 };
  }
}

/**
 * Calculate correct USD price for a token in a swap
 * Handles stablecoin pairs (USDC, AUSD) and returns accurate pricing
 * 
 * @param swap - Raw swap data from subgraph
 * @param isToken0 - Whether the target token is token0 in the pool
 * @returns USD price of the token
 */
export function calculateTokenUSDPrice(swap: SwapData, isToken0: boolean): number {
  // Calculate prices from sqrtPriceX96
  const prices = sqrtPriceX96ToTokenPrices(
    swap.sqrtPriceX96,
    parseInt(swap.token0.decimals),
    parseInt(swap.token1.decimals)
  );
  
  let correctTokenPrice: number;
  
  // For USDC pairs, use direct USD pricing (USDC = $1)
  if (swap.token1.id.toLowerCase() === USDC_KATANA) {
    // USDC is token1, so token0Price gives price in USDC terms (= USD)
    correctTokenPrice = isToken0 ? prices.token0Price : 1.0;
  } else if (swap.token0.id.toLowerCase() === USDC_KATANA) {
    // USDC is token0, so token1Price gives price in USDC terms (= USD)
    correctTokenPrice = isToken0 ? 1.0 : prices.token1Price;
  } else if (swap.token1.id.toLowerCase() === AUSD_KATANA) {
    // AUSD is token1, so token0Price gives price in AUSD terms (= USD)
    correctTokenPrice = isToken0 ? prices.token0Price : 1.0;
  } else if (swap.token0.id.toLowerCase() === AUSD_KATANA) {
    // AUSD is token0, so token1Price gives price in AUSD terms (= USD)
    correctTokenPrice = isToken0 ? 1.0 : prices.token1Price;
  } else {
    // For non-stable pairs, fallback to token price from sqrtPriceX96
    // Note: This won't have USD conversion for non-stable pairs
    correctTokenPrice = isToken0 ? prices.token0Price : prices.token1Price;
    console.warn(`Non-stablecoin pair detected: ${swap.token0.symbol}/${swap.token1.symbol}, using fallback price calculation`);
  }
  
  return correctTokenPrice;
}

/**
 * Check if a token address is a known stablecoin
 */
export function isStablecoin(tokenAddress: string): boolean {
  const normalized = tokenAddress.toLowerCase();
  return normalized === USDC_KATANA || normalized === AUSD_KATANA;
}

/**
 * Get the stablecoin in a pool (if any)
 */
export function getStablecoinFromPool(token0Address: string, token1Address: string): string | null {
  if (isStablecoin(token0Address)) return token0Address.toLowerCase();
  if (isStablecoin(token1Address)) return token1Address.toLowerCase();
  return null;
}