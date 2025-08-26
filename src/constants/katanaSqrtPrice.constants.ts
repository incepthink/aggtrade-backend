// constants/katanaSqrtPrice.constants.ts

// API Endpoints
export const KATANA_SUBGRAPH_URL = "https://api.studio.thegraph.com/query/106601/sushi-v-3-katana/version/latest";
export const SUSHI_API_BASE = "https://api.sushi.com/price/v1";
export const KATANA_CHAIN_ID = 747474;

// Cache configuration
export const SQRT_PRICE_DATA_PREFIX = "sqrt_price_katana_";
export const SQRT_PRICE_DATA_TTL = 365 * 24 * 60 * 60;
export const UPDATE_LOCK_PREFIX = "sqrt_update_lock_katana_";
export const UPDATE_LOCK_TTL = 60 * 60;

// Data fetching constants
export const FULL_DATA_DAYS = 365;
export const UPDATE_INTERVAL_HOURS = 1;
export const MAX_SWAPS_DEFAULT = 30000; // Reduced from 50k for better memory management
export const BATCH_SIZE = 1000;
export const MAX_SKIP = 5000; // The Graph's skip limit
export const SAVE_PROGRESS_EVERY_N_BATCHES = 3; // More frequent saves
export const MAX_FAILED_RANGES = 5;

// Memory management constants
export const MAX_DATA_SIZE_MB = 0.8; // Leave buffer for Redis free tier
export const CHUNK_SIZE = 2000; // Swaps per chunk
export const RECENT_DATA_DAYS = 30; // Keep only last 30 days in reduced mode
export const PRICE_CHANGE_THRESHOLD = 5; // Rescale if price changes more than 5%

// Rate limiting
export const RATE_LIMIT_RESERVOIR = 60;
export const RATE_LIMIT_REFRESH_AMOUNT = 60;
export const RATE_LIMIT_REFRESH_INTERVAL = 60 * 1000;
export const RATE_LIMIT_MAX_CONCURRENT = 2;
export const RATE_LIMIT_MIN_TIME = 1000;

// Request timeouts
export const GRAPHQL_TIMEOUT = 50000;
export const API_TIMEOUT = 10000;
export const POOLS_TIMEOUT = 25000;

// Delays
export const BATCH_DELAY = 500;
export const ERROR_DELAY = 2000;
export const TIMESTAMP_SKIP_AHEAD = 3600; // 1 hour

// Log prefixes for better debugging
export const LOG_PREFIX = "[Katana SqrtPrice]";
export const MEMORY_LOG_PREFIX = "[Memory Manager]";
export const FETCH_LOG_PREFIX = "[Fetch Manager]";
export const PRICE_LOG_PREFIX = "[Price Calculator]";