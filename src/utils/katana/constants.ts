// src/controllers/katana/utils/constants.ts

/**
 * Subgraph Configuration
 */
export const KATANA_SUBGRAPH_URL = 
  "https://api.studio.thegraph.com/query/106601/sushi-v-3-katana/version/latest";

/**
 * Rate Limiter Configuration
 */
export const RATE_LIMITER_CONFIG = {
  reservoir: 60,
  reservoirRefreshAmount: 60,
  reservoirRefreshInterval: 60 * 1000, // per minute
  maxConcurrent: 2,
  minTime: 1000,
};

// Tokens updated through cron job
export const PROACTIVE_TOKENS = [
  '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62', // WRON/ETH on Katana
];


/**
 * Cache Configuration
 */
export const FULL_SWAP_DATA_PREFIX = "full_swaps_katana_";
export const FULL_SWAP_DATA_TTL = 365 * 24 * 60 * 60; // 365 days (1 year)
export const UPDATE_LOCK_PREFIX = "update_lock_katana_";
export const UPDATE_LOCK_TTL = 60 * 60; // 1 hour lock
export const UPDATE_LOCK_TIMEOUT = 60 * 60 * 1000; // 1 hour (ms)
export const CANDLE_GAP_FIX_LOCK_PREFIX = "candle_gap_fix_lock_";
export const CANDLE_GAP_FIX_LOCK_TTL = 3600; // 1 hour (in seconds)

/**
 * Data Fetching Limits
 */
export const FULL_DATA_DAYS = 365;
export const UPDATE_INTERVAL_HOURS = 1;
export const MAX_SKIP_LIMIT = 5000; // Maximum skip value allowed (appendHistorical)
export const MAX_TOTAL_SWAPS = 6000; // Maximum total swaps (appendHistorical)
export const MAX_SKIP_LIMIT_INCREMENTAL = 2000; // Maximum skip value (incremental)
export const MAX_TOTAL_SWAPS_INCREMENTAL = 3000; // Maximum total swaps (incremental)

/**
 * Stablecoin Addresses on Katana (lowercase)
 */
export const USDC_KATANA = "0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36".toLowerCase();
export const AUSD_KATANA = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a".toLowerCase();

/**
 * Stablecoin array for easy checking
 */
export const STABLECOINS_KATANA = [USDC_KATANA, AUSD_KATANA];

/**
 * Chain Configuration
 */
export const KATANA_CHAIN_ID = 747474;
export const CHAIN_NAME = "katana";
export const DEX_ID = "katana-sushiswap";