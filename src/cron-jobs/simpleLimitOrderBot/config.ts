/**
 * Configuration for Simple Limit Order Bot
 */

export const BOT_CONFIG = {
  RPC_URL: 'https://rpc.katana.network',
  CRON_INTERVAL_HOURS: 4,
  CHAIN_ID: 747474
}

export const GRID_CONFIG = {
  BUY_OFFSETS: [-1, -1.5, -2, -2.5, -3],
  SELL_OFFSETS: [1, 1.5, 2, 2.5, 3],
  MIN_ORDER_SIZE_USD: 6,
  EXPIRY_HOURS: 168
}

export const COUNTER_ORDER_CONFIG = {
  PROFIT_MARGIN_PERCENT: 1,
  MIN_ORDER_SIZE_USD: 6,
  EXPIRY_HOURS: 168
}

export const TEST_MODE_CONFIG = {
  enabled: process.env.BOT_TEST_MODE === 'true',
  intervalSeconds: 10,
  simulatedOrders: new Map<string, any[]>()
}
