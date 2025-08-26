// types/katanaSqrtPrice.types.ts

export interface SwapDataWithSqrt {
  id: string;
  timestamp: string;
  sqrtPriceX96: string;
  tick: string;
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
  amount0USD: string;
  amount1USD: string;
  amountUSD: string;
  pool: {
    id: string;
  };
}

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
  token0Price: string;
  token1Price: string;
  sqrtPrice: string;
  tick: string;
}

export interface ProcessedSwap {
  id: string;
  timestamp: number;
  poolPrice: number; // Scaled USD price
  rawPoolPrice: number; // Original pool ratio
  tokenVolumeUSD: number;
  totalVolumeUSD: number;
  sqrtPriceX96: string;
  tick: number;
}

export interface FetchProgress {
  lastFetchedTimestamp: number;
  totalBatches: number;
  completedBatches: number;
  isComplete: boolean;
  failedRanges: Array<{ start: number; end: number; error: string }>;
  lastBatchSize: number;
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
      token0: any;
      token1: any;
      feeTier: string;
      totalValueLockedUSD: number;
      volumeUSD: number;
      currentPoolPrice: number;
      currentSushiPrice: number;
      scalingFactor: number;
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
    fetchProgress: FetchProgress;
  };
}

export interface SushiGraphResponse {
  data: {
    swaps?: SwapDataWithSqrt[];
    pools?: Pool[];
  };
  errors?: any[];
}

// Compressed storage types for Redis optimization
export interface CompressedSwap {
  id: string;
  ts: number; // timestamp
  rp: number; // rawPoolPrice
  tv: number; // tokenVolumeUSD
  ttv: number; // totalVolumeUSD
  sp: string; // sqrtPriceX96
  tk: number; // tick
}

export interface CompressedSwapData {
  swaps: CompressedSwap[];
  // It's fine to use an indexed access type for a property
  metadata: StoredSwapData['metadata'];
}

// ---- Fix: give the indexed access a name, then extend it ----
type Metadata = StoredSwapData['metadata'];

export interface ChunkedMetadata extends Metadata {
  totalChunks: number;
  totalSwaps: number;
}

export interface FetchConfig {
  poolId: string;
  startTime: number;
  endTime: number;
  maxSwaps: number;
  batchSize: number;
  maxSkip: number;
  saveProgressEveryNBatches: number;
}
