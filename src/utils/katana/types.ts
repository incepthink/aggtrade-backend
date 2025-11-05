// src/controllers/katana/utils/types.ts

/**
 * Raw swap data from SushiSwap subgraph
 */
export interface SwapData {
  id: string;
  timestamp: string;
  token0: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  token1: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  token0PriceUSD: string;
  token1PriceUSD: string;
  amount0USD: string;
  amount1USD: string;
  amountUSD: string;
  sqrtPriceX96: string;
  pool: {
    id: string;
  };
}

/**
 * Pool information from SushiSwap subgraph
 */
export interface Pool {
  id: string;
  token0: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  token1: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  feeTier: string;
  totalValueLockedUSD: string;
  volumeUSD: string;
}

/**
 * Processed swap data (internal format)
 */
export interface ProcessedSwap {
  id: string;
  timestamp: number; // milliseconds
  tokenPriceUSD: number;
  tokenVolumeUSD: number;
  totalVolumeUSD: number;
}

/**
 * Stored swap data in Redis
 */
export interface StoredSwapData {
  swaps: ProcessedSwap[];
  metadata: {
    token: {
      address: string;
      name: string;
      symbol: string;
      decimals: string;
    };
    pool: {
      id: string;
      address: string;
      token0: any;
      token1: any;
      feeTier: string;
      totalValueLockedUSD: number;
      volumeUSD: number;
    };
    isToken0: boolean;
    quoteToken: any;
    lastUpdate: number;
    lastSwapTimestamp: number;
    dataRange: {
      start: number;
      end: number;
    };
    chain: string;
    dexId: string;
  };
}

/**
 * Redis swap data (used in appendHistorical)
 */
export interface RedisSwapData {
  swaps: ProcessedSwap[];
  metadata: {
    pool: {
      id: string;
      token0: any;
      token1: any;
      feeTier: string;
      totalValueLockedUSD: number;
      volumeUSD: number;
    };
    isToken0: boolean;
    lastSwapTimestamp: number;
  };
}

/**
 * Existing swap info from MySQL (for pool metadata)
 */
export interface ExistingSwapInfo {
  pool_id: string;
  pool_token0_address: string;
  pool_token0_symbol: string;
  pool_token1_address: string;
  pool_token1_symbol: string;
  pool_fee_tier: number;
  is_token0: boolean;
}

/**
 * MySQL swap query result
 */
export interface MySQLSwapResult {
  id: string;
  timestamp: Date;
  token_price_usd: string | number;
  token_volume_usd: string | number;
  total_volume_usd: string | number;
}

/**
 * SushiSwap GraphQL API response
 */
export interface SushiGraphResponse {
  data: {
    swaps?: SwapData[];
    pools?: Pool[] | PoolWithMetrics[]; // Support both Pool and PoolWithMetrics
  };
  errors?: any[];
}

/**
 * Token price calculation result
 */
export interface TokenPrices {
  token0Price: number;
  token1Price: number;
}

/**
 * Pool day data from subgraph
 */
export interface PoolDayData {
  date: number;
  volumeUSD: string;
  tvlUSD: string;
  txCount: string;
}

/**
 * Raw pool data from subgraph with metrics
 */
export interface PoolWithMetrics {
  id: string;
  token0: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  token1: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
  };
  feeTier: string;
  liquidity: string;
  totalValueLockedUSD: string;
  volumeUSD: string;
  txCount: string;
  poolDayData: PoolDayData[];
}

/**
 * Processed pool data for frontend
 */
export interface ProcessedPool {
  id: string;
  address: string;
  name: string;
  token0Address: string;
  token1Address: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Name: string;
  token1Name: string;
  token0LogoUri: string | null;
  token1LogoUri: string | null;
  swapFee: number;
  protocol: 'SUSHISWAP_V3';
  chainId: number;
  
  // Current metrics
  liquidityUSD: number;
  volumeUSD1d: number;
  volumeUSD1w: number;
  txCount1d: number;
  
  // Changes (percentage)
  liquidityUSDChange1d: number;
  volumeUSDChange1d: number;
  volumeUSDChange1w: number;
  
  // APR (calculated from fees)
  totalApr1d: number;
}