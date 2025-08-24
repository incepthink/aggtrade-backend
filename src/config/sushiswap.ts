// src/config/sushiswap.ts
import Bottleneck from "bottleneck";
import type { ChainConfig } from "../types/sushiswap";

// Rate limiter for SushiSwap subgraph
export const sushiLimiter = new Bottleneck({
  reservoir: 60,
  reservoirRefreshAmount: 60,
  reservoirRefreshInterval: 60 * 1000, // per minute
  maxConcurrent: 2,
  minTime: 1000,
});

// Cache configuration
export const FULL_SWAP_DATA_TTL = 365 * 24 * 60 * 60; // 365 days (1 year)
export const UPDATE_LOCK_TTL = 60 * 60; // 1 hour lock

// Constants
export const FULL_DATA_DAYS = 365;
export const UPDATE_INTERVAL_HOURS = 1;

// Chain configurations
export const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  katana: {
    subgraphUrl: "https://api.studio.thegraph.com/query/106601/sushi-v-3-katana/version/latest",
    redisPrefix: "full_swaps_katana_",
    chain: "katana",
    dexId: "katana-sushiswap",
    redisImport: "../redis/katanaTokens",
    version: "v3"
  },
  ethereum: {
    subgraphUrl: "https://api.studio.thegraph.com/query/119169/sushi-v-2-eth/version/latest",
    redisPrefix: "full_swaps_ethereum_",
    chain: "ethereum",
    dexId: "ethereum-sushiswap",
    redisImport: "../redis/ethereumTokens",
    version: "v2"
  }
};

export const UPDATE_LOCK_PREFIX = "update_lock_";