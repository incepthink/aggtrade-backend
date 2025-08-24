// src/types/sushiswap.ts

// Base interfaces for shared fields
export interface TokenInfo {
  id: string;
  symbol: string;
  name: string;
  decimals: string;
}

// V3 (Katana) Swap Data
export interface SwapDataV3 {
  id: string;
  timestamp: string;
  token0: TokenInfo;
  token1: TokenInfo;
  token0PriceUSD: string;
  token1PriceUSD: string;
  amount0USD: string;
  amount1USD: string;
  amountUSD: string;
  pool: {
    id: string;
  };
}

// V2 (Ethereum) Swap Data
export interface SwapDataV2 {
  id: string;
  timestamp: string;
  pair: {
    id: string;
    token0: TokenInfo;
    token1: TokenInfo;
  };
  token0PriceUSD: string;
  token1PriceUSD: string;
  amount0USD: string;
  amount1USD: string;
  amountUSD: string;
}

// Unified swap data type
export type SwapData = SwapDataV3 | SwapDataV2;

// V3 Pool (Katana)
export interface PoolV3 {
  id: string;
  token0: TokenInfo;
  token1: TokenInfo;
  feeTier: string;
  totalValueLockedUSD: string;
  volumeUSD: string;
}

// V2 Pair (Ethereum)
export interface PairV2 {
  id: string;
  token0: TokenInfo;
  token1: TokenInfo;
  reserveUSD: string;
  volumeUSD: string;
}

// Unified pool/pair type
export type Pool = PoolV3 | PairV2;

// Normalized pool interface for internal use
export interface NormalizedPool {
  id: string;
  token0: TokenInfo;
  token1: TokenInfo;
  feeTier?: string; // Optional for v2
  tvlUSD: string; // Normalized TVL field
  volumeUSD: string;
  version: 'v2' | 'v3';
}

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
      token0: TokenInfo;
      token1: TokenInfo;
      feeTier?: string; // Optional for v2
      totalValueLockedUSD: number;
      volumeUSD: number;
      version: 'v2' | 'v3';
    };
    isToken0: boolean;
    quoteToken: TokenInfo;
    lastUpdate: number; // Last time we updated the data
    lastSwapTimestamp: number; // Timestamp of most recent swap
    dataRange: {
      start: number;
      end: number;
    };
    chain: string;
    dexId: string;
  };
}

export interface ProcessedSwap {
  id: string;
  timestamp: number;
  tokenPriceUSD: number;
  tokenVolumeUSD: number;
  totalVolumeUSD: number;
}

// V3 GraphQL Response
export interface SushiGraphResponseV3 {
  data: {
    swaps?: SwapDataV3[];
    pools?: PoolV3[];
  };
  errors?: any[];
}

// V2 GraphQL Response  
export interface SushiGraphResponseV2 {
  data: {
    swaps?: SwapDataV2[];
    pairs?: PairV2[];
  };
  errors?: any[];
}

// Unified response type
export type SushiGraphResponse = SushiGraphResponseV3 | SushiGraphResponseV2;

export interface ChainConfig {
  subgraphUrl: string;
  redisPrefix: string;
  chain: string;
  dexId: string;
  redisImport: string;
  version: 'v2' | 'v3'; // Add version field
}