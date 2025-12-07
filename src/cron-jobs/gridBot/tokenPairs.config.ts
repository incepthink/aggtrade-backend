import { TokenConfig } from './types'

/**
 * Token configurations for grid bot trading
 * Add new tokens here to enable trading
 */
export const TOKENS: Record<string, TokenConfig> = {
  ETH: {
    address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    symbol: 'ETH',
    decimals: 18,
    isNative: true
  },
  USDC: {
    address: '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36',
    symbol: 'USDC',
    decimals: 6,
    isNative: false
  },
  WETH: {
    address: '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62',
    symbol: 'WETH',
    decimals: 18,
    isNative: false
  },
  WBTC: {
    address: '0x0913DA6Da4b42f538B445599b46Bb4622342Cf52',
    symbol: 'WBTC',
    decimals: 8,
    isNative: false
  },
  POL: {
    address: '0xb24e3035d1FCBC0E43CF3143C3Fd92E53df2009b',
    symbol: 'POL',
    decimals: 18,
    isNative: false
  },
  AUSD: {
    address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
    symbol: 'AUSD',
    decimals: 6,
    isNative: false
  },
  BTCK: {
    address: '0xB0F70C0bD6FD87dbEb7C10dC692a2a6106817072',
    symbol: 'BTCK',
    decimals: 8,
    isNative: false
  },
  SUSHI: {
    address: '0x17BFF452dae47e07CeA877Ff0E1aba17eB62b0aB',
    symbol: 'SUSHI',
    decimals: 18,
    isNative: false
  },
  FRXUSD: {
    address: '0x80Eede496655FB9047dd39d9f418d5483ED600df',
    symbol: 'FRXUSD',
    decimals: 18,
    isNative: false
  },
  SFRXUSD: {
    address: '0x5Bff88cA1442c2496f7E475E9e7786383Bc070c0',
    symbol: 'SFRXUSD',
    decimals: 18,
    isNative: false
  },
  USOL: {
    address: '0x9B8Df6E244526ab5F6e6400d331DB28C8fdDdb55',
    symbol: 'USOL',
    decimals: 18,
    isNative: false
  },
  WSTETH: {
    address: '0x7Fb4D0f51544F24F385a421Db6e7D4fC71Ad8e5C',
    symbol: 'WSTETH',
    decimals: 18,
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
export const TARGET_TOKENS = ['WETH', 'WBTC', 'POL', 'AUSD', 'BTCK', 'SUSHI', 'FRXUSD', 'SFRXUSD', 'USOL', 'WSTETH'] as const

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
