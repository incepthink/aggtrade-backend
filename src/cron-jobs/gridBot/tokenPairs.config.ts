import { TokenConfig } from './types'

/**
 * Token configurations for grid bot trading
 * Add new tokens here to enable trading
 */
export const TOKENS: Record<string, TokenConfig> = {
  WETH: {
    address: '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62',
    symbol: 'WETH',
    decimals: 18,
    isNative: false
  },
  USDC: {
    address: '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36',
    symbol: 'USDC',
    decimals: 6,
    isNative: false
  },
  JitoSOL: {
    address: '0x6c16e26013f2431e8b2e1ba7067ecccad0db6c52',
    symbol: 'JitoSOL',
    decimals: 18,
    isNative: false
  },
  LBTC: {
    address: '0xecac9c5f704e954931349da37f60e39f515c11c1',
    symbol: 'LBTC',
    decimals: 8,
    isNative: false
  }
}

/**
 * Base currencies - currencies used to buy other tokens
 * The bot will use whichever base currency has higher balance
 */
export const BASE_CURRENCIES = ['USDC', 'ETH'] as const

/**
 * Target tokens - tokens to trade (buy/sell)
 * Each target will be paired with base currencies based on balance
 */
export const TARGET_TOKENS = ['ETH', 'JitoSOL', 'LBTC'] as const

/**
 * Get all available tokens
 */
export function getAllTokens(): TokenConfig[] {
  return Object.values(TOKENS)
}

/**
 * Get token by symbol
 */
export function getToken(symbol: string): TokenConfig {
  const token = TOKENS[symbol]
  if (!token) {
    throw new Error(`Token ${symbol} not found in configuration`)
  }
  return token
}

/**
 * Get base currency tokens
 */
export function getBaseCurrencies(): TokenConfig[] {
  return BASE_CURRENCIES.map(symbol => getToken(symbol))
}

/**
 * Get target tokens
 */
export function getTargetTokens(): TokenConfig[] {
  return TARGET_TOKENS.map(symbol => getToken(symbol))
}
