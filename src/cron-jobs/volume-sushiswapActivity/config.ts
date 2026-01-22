/**
 * Volume Sushiswap Activity Cron Job - Configuration
 *
 * Manages daily volume targets and hourly distribution for SushiSwap activity.
 */

// Chain configuration
export const CHAIN_ID = 747474 // Katana/Ronin

// Volume targets (USD)
export const VOLUME_CONFIG = {
  DAILY_TARGET_MIN: 95000,   // $95k minimum
  DAILY_TARGET_MAX: 125000,  // $125k maximum

  // Per-hour budget caps (when distributing remaining volume)
  HOURLY_MIN: 2000,          // Minimum volume per hour
  HOURLY_MAX: 15000,         // Maximum volume per hour

  // Variance settings
  HOURLY_VARIANCE: 0.3,      // +-30% variance on hourly budgets
  OVERSHOOT_BUFFER: 0.02,    // Allow 2% overshoot tolerance
}

// Classic vs Limit Order ratio
export const SWAP_RATIO_CONFIG = {
  CLASSIC_MIN: 0.55,         // Minimum 55% classic swaps
  CLASSIC_MAX: 0.75,         // Maximum 75% classic swaps
  VARIANCE: 0.05,            // +-5% variance per run
}

// Backfill configuration
export const BACKFILL_CONFIG = {
  START_DATE: '2026-01-21',  // Start backfill from this date
  // Backfill volume per day (no hourly distribution, just daily targets)
  BACKFILL_VOLUME_MIN: 95000,
  BACKFILL_VOLUME_MAX: 125000,
}

// Scheduling configuration
export const SCHEDULE_CONFIG = {
  CRON_EXPRESSION: '55 * * * *',  // Run at minute 55 of every hour
  TIMEZONE: 'UTC',
}

// Token addresses to search for top pools
export const COMMON_TOKENS = [
  '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62', // WETH
  '0x203a662b0bd271a6ed5a60edfbd04bfce608fd36', // USDC
  '0x0913da6da4b42f538b445599b46bb4622342cf52', // WBTC
  '0xecac9c5f704e954931349da37f60e39f515c11c1', // LBTC
  '0x6c16e26013f2431e8b2e1ba7067ecccad0db6c52', // JitoSOL
  '0x17bff452dae47e07cea877ff0e1aba17eb62b0ab', // SUSHI
  '0x9893989433e7a383cb313953e4c2365107dc19a7', // weETH
  '0x80eede496655fb9047dd39d9f418d5483ed600df', // frxUSD
  '0x1e5efca3d0db2c6d5c67a4491845c43253eb9e4e', // MORPHO
  '0x2dca96907fde857dd3d816880a0df407eeb2d2f2', // USDT
  '0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072', // BTCK
  '0x4772d2e014f9fc3a820c444e3313968e9a5c8121', // yUSD
  '0x7fb4d0f51544f24f385a421db6e7d4fc71ad8e5c', // wstETH
  '0x9b8df6e244526ab5f6e6400d331db28c8fdddb55', // uSOL
]

// Pools per token to fetch for swap data
export const POOLS_PER_TOKEN = 10

// Max swaps to fetch per pool
export const MAX_SWAPS_PER_POOL = 2000
