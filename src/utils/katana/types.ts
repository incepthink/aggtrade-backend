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
    pools?: Pool[];
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