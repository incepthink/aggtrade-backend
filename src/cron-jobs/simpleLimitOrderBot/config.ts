/**
 * Configuration for Simple Limit Order Bot
 *
 * HIGH VOLUME STRATEGY:
 * - Optimized for $100 wallets to generate $1,000 daily volume (10x turnover)
 * - 5-minute cycles for rapid order placement and fills
 * - Pair-specific configs for maximum efficiency
 */

export const BOT_CONFIG = {
  RPC_URL: 'https://rpc.katana.network',
  CRON_INTERVAL_MINUTES: 5,  // Changed from 4 hours to 5 minutes (288 cycles/day)
  CRON_INTERVAL_HOURS: 4,    // Keep for backward compatibility
  CHAIN_ID: 747474
}

/**
 * Rate limiting configuration
 * NOTE: Wallets are processed sequentially (one at a time) for clean logs and no race conditions
 */
export const RATE_LIMIT_CONFIG = {
  WALLET_BATCH_SIZE: 3,  // DEPRECATED: No longer used (kept for backward compatibility)
  BATCH_DELAY_MS: 2000   // Delay between sequential wallet processing (in milliseconds)
}

/**
 * PAIR-SPECIFIC GRID CONFIGURATIONS
 * Optimized for different liquidity levels and volatility
 */
export const PAIR_GRID_CONFIGS: Record<string, {
  BUY_OFFSETS: number[]
  SELL_OFFSETS: number[]
  MIN_ORDER_SIZE_USD: number
  EXPIRY_HOURS: number
  PROFIT_MARGIN_PERCENT: number
  DESCRIPTION: string
}> = {
  // USDC/WETH - Highest liquidity, tightest spreads
  'USDC/WETH': {
    BUY_OFFSETS: [-0.04, -0.06, -0.08, -0.10, -0.12],     // 5 buy orders
    SELL_OFFSETS: [0.04, 0.06, 0.08, 0.10, 0.12],         // 5 sell orders
    MIN_ORDER_SIZE_USD: 10,  // Minimum $10 per order
    EXPIRY_HOURS: 12,       // Shorter expiry for faster capital recycling
    PROFIT_MARGIN_PERCENT: 0.15,  // Tight margin for fast counter fills
    DESCRIPTION: 'Ultra-aggressive for highest liquidity pair'
  },

  // USDC/WBTC - High liquidity, tight spreads
  'USDC/WBTC': {
    BUY_OFFSETS: [-0.04, -0.06, -0.08, -0.10, -0.12],
    SELL_OFFSETS: [0.04, 0.06, 0.08, 0.10, 0.12],
    MIN_ORDER_SIZE_USD: 10,
    EXPIRY_HOURS: 12,
    PROFIT_MARGIN_PERCENT: 0.15,
    DESCRIPTION: 'Ultra-aggressive for high liquidity BTC pair'
  },

  // WBTC/WETH - Lower liquidity, slightly wider spreads
  'WBTC/WETH': {
    BUY_OFFSETS: [-0.05, -0.10, -0.15, -0.20, -0.25],
    SELL_OFFSETS: [0.05, 0.10, 0.15, 0.20, 0.25],
    MIN_ORDER_SIZE_USD: 10,
    EXPIRY_HOURS: 12,
    PROFIT_MARGIN_PERCENT: 0.25,  // Wider margin for safety
    DESCRIPTION: 'Aggressive for cross-asset pair'
  },

  // Reverse pairs (support both notations)
  'WETH/USDC': {
    BUY_OFFSETS: [-0.04, -0.06, -0.08, -0.10, -0.12],
    SELL_OFFSETS: [0.04, 0.06, 0.08, 0.10, 0.12],
    MIN_ORDER_SIZE_USD: 10,
    EXPIRY_HOURS: 12,
    PROFIT_MARGIN_PERCENT: 0.15,
    DESCRIPTION: 'Same as USDC/WETH (reverse notation)'
  },

  'WBTC/USDC': {
    BUY_OFFSETS: [-0.04, -0.06, -0.08, -0.10, -0.12],
    SELL_OFFSETS: [0.04, 0.06, 0.08, 0.10, 0.12],
    MIN_ORDER_SIZE_USD: 10,
    EXPIRY_HOURS: 12,
    PROFIT_MARGIN_PERCENT: 0.15,
    DESCRIPTION: 'Same as USDC/WBTC (reverse notation)'
  },

  'WETH/WBTC': {
    BUY_OFFSETS: [-0.05, -0.10, -0.15, -0.20, -0.25],
    SELL_OFFSETS: [0.05, 0.10, 0.15, 0.20, 0.25],
    MIN_ORDER_SIZE_USD: 10,
    EXPIRY_HOURS: 12,
    PROFIT_MARGIN_PERCENT: 0.25,
    DESCRIPTION: 'Same as WBTC/WETH (reverse notation)'
  }
}

/**
 * DEFAULT GRID CONFIG (fallback for other pairs)
 * More conservative settings for lower liquidity pairs
 */
export const GRID_CONFIG = {
  BUY_OFFSETS: [-0.1, -0.15, -0.2, -0.25, -0.3],
  SELL_OFFSETS: [0.1, 0.15, 0.2, 0.25, 0.3],
  MIN_ORDER_SIZE_USD: 10,
  EXPIRY_HOURS: 12
}

/**
 * COUNTER ORDER CONFIG
 * Used when grid orders fill and counter orders are placed
 */
export const COUNTER_ORDER_CONFIG = {
  PROFIT_MARGIN_PERCENT: 0.2,  // Default, overridden by pair-specific config
  MIN_ORDER_SIZE_USD: 10,
  EXPIRY_HOURS: 12
}

/**
 * Helper function to get config for a specific trading pair
 * Normalizes pair format and returns appropriate configuration
 */
export function getGridConfigForPair(tradingPool: string): {
  BUY_OFFSETS: number[]
  SELL_OFFSETS: number[]
  MIN_ORDER_SIZE_USD: number
  EXPIRY_HOURS: number
  PROFIT_MARGIN_PERCENT: number
} {
  // Normalize trading pool format (remove spaces, uppercase)
  const normalizedPool = tradingPool.replace(/\s+/g, '').toUpperCase()

  // Check if we have a specific config for this pair
  if (PAIR_GRID_CONFIGS[normalizedPool]) {
    console.log(`[Config] Using specific config for ${normalizedPool}`)
    return PAIR_GRID_CONFIGS[normalizedPool]
  }

  // Try reverse order (e.g., WETH/USDC -> USDC/WETH)
  const [token1, token2] = normalizedPool.split('/')
  if (token1 && token2) {
    const reversedPool = `${token2}/${token1}`

    if (PAIR_GRID_CONFIGS[reversedPool]) {
      console.log(`[Config] Using reversed config for ${normalizedPool} -> ${reversedPool}`)
      return PAIR_GRID_CONFIGS[reversedPool]
    }
  }

  // Fallback to default config
  console.warn(`[Config] No specific config for ${tradingPool}, using default`)
  return {
    ...GRID_CONFIG,
    PROFIT_MARGIN_PERCENT: COUNTER_ORDER_CONFIG.PROFIT_MARGIN_PERCENT
  }
}

export const TEST_MODE_CONFIG = {
  enabled: process.env.BOT_TEST_MODE === 'true',
  intervalSeconds: 10,
  simulatedOrders: new Map<string, any[]>(),
  forceMidnightReset: process.env.FORCE_MIDNIGHT_RESET === 'true',
  testWalletIndex: process.env.TEST_WALLET_INDEX ? parseInt(process.env.TEST_WALLET_INDEX) : null,
  singleWalletMode: process.env.SINGLE_WALLET_MODE === 'true',
  orderPairCap: process.env.ORDER_PAIR_CAP ? parseInt(process.env.ORDER_PAIR_CAP) : null
}

/**
 * REBALANCING CONFIG
 * Controls midnight wallet rebalancing to 50/50 allocation
 */
export const REBALANCE_CONFIG = {
  ENABLED: true,
  SLIPPAGE_PERCENT: 2.0,          // 2% slippage tolerance (increased from 0.5% to handle on-chain delays)
  MIN_IMBALANCE_PERCENT: 1,       // Only rebalance if >1% off from 50/50
  MIN_SWAP_SIZE_USD: 5,           // Don't swap if amount < $5
  APPROVAL_CONFIRMATION_DELAY_MS: 3000  // Wait 3s after approval before swap to ensure confirmation
}

/**
 * MNEMONIC WALLET CONFIGURATION
 *
 * Wallets are derived from a single mnemonic phrase (BOT_MNEMONIC env variable).
 * Trading pools alternate between USDC/WETH and USDC/WBTC based on wallet index.
 *
 * Usage:
 * - Set BOT_MNEMONIC in .env with your 12/24 word phrase
 * - Set BOT_WALLET_COUNT in .env to specify number of wallets to derive (default: 3)
 * - Wallet indices start at 0 (standard HD derivation path: m/44'/60'/0'/0/{index})
 *
 * Pattern:
 * - Even indices (0, 2, 4, ...): USDC/WETH
 * - Odd indices (1, 3, 5, ...): USDC/WBTC
 */
export const MNEMONIC_CONFIG = {
  WALLET_COUNT: process.env.BOT_WALLET_COUNT ? parseInt(process.env.BOT_WALLET_COUNT) : 3,
  POOLS: {
    EVEN: 'USDC/WETH',  // wallets 0, 2, 4, ...
    ODD: 'USDC/WBTC'    // wallets 1, 3, 5, ...
  }
}

/**
 * Get trading pool for a specific wallet index (alternating pattern)
 */
export function getTradingPoolForWallet(walletIndex: number): string {
  return walletIndex % 2 === 0 ? MNEMONIC_CONFIG.POOLS.EVEN : MNEMONIC_CONFIG.POOLS.ODD
}
