// src/services/sushiswap.ts
import axios from "axios";
import type {
  SwapData,
  NormalizedPool,
  ChainConfig,
} from "../types/sushiswap";
import { getPoolsQuery, getSwapsQuery } from "../queries/sushiswap";
import {
  normalizePool,
  getQueryVariables,
  formatTokenAddress,
} from "../utils/sushiswap";

/**
 * Fetch pools/pairs by TVL for a specific token (version-agnostic).
 * Always returns NormalizedPool[].
 */
export async function fetchPoolsByTVL(
  subgraphUrl: string,
  tokenAddress: string,
  version: "v2" | "v3" = "v3"
): Promise<NormalizedPool[]> {
  const query = getPoolsQuery(version);
  const variables = { tokenAddress: formatTokenAddress(tokenAddress, version) };

  console.log(`[${version.toUpperCase()}] Pools query vars:`, variables);

  const resp = await axios.post<any>(
    subgraphUrl,
    { query, variables },
    { timeout: 15_000, headers: { "Content-Type": "application/json" } }
  );

  // v3: data.pools; v2: data.pairs (we normalize both)
  const raw: any[] =
    version === "v3"
      ? resp?.data?.data?.pools ?? []
      : resp?.data?.data?.pairs ?? [];

  console.log(`[${version.toUpperCase()}] Found ${raw.length} pools/pairs`);

  return raw.map((p) => normalizePool(p)); // -> NormalizedPool
}

/**
 * Fetch swaps with pagination (version-agnostic).
 * Returns SwapData[].
 */
export async function fetchSwaps(
  subgraphUrl: string,
  poolId: string,
  startTime: number,
  endTime: number,
  maxSwaps: number = 50_000,
  chain: string = "unknown",
  version: "v2" | "v3" = "v3"
): Promise<SwapData[]> {
  const all: SwapData[] = [];
  let hasMore = true;
  let skip = 0;
  const batchSize = 1000;

  console.log(
    `[${String(chain).toUpperCase()} ${version.toUpperCase()}] Fetch swaps pool=${poolId} ${startTime}->${endTime}`
  );

  while (hasMore && all.length < maxSwaps) {
    const query = getSwapsQuery(version);
    const variables = getQueryVariables(
      poolId,
      startTime,
      endTime,
      Math.min(batchSize, maxSwaps - all.length),
      skip,
      version
    );

    console.log(
      `[${String(chain).toUpperCase()} ${version.toUpperCase()}] skip=${skip} first=${variables.first}`
    );

    const resp = await axios.post<any>(
      subgraphUrl,
      { query, variables },
      { timeout: 15_000, headers: { "Content-Type": "application/json" } }
    );

    // Our queries name the field "swaps" for both versions
    const swaps: SwapData[] = resp?.data?.data?.swaps ?? [];

    if (!swaps.length) {
      hasMore = false;
      break;
    }

    all.push(...swaps);

    if (swaps.length < variables.first) {
      hasMore = false;
    } else {
      skip += batchSize;
    }

    // throttle
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(
    `[${String(chain).toUpperCase()} ${version.toUpperCase()}] Total swaps=${all.length}`
  );
  return all;
}

/** Convenience: fetch normalized pools using ChainConfig */
export async function fetchPoolsByTVLWithConfig(
  config: ChainConfig,
  tokenAddress: string
): Promise<NormalizedPool[]> {
  return fetchPoolsByTVL(
    config.subgraphUrl,
    tokenAddress,
    config.version as "v2" | "v3"
  );
}

/** Convenience: fetch swaps using ChainConfig */
export async function fetchSwapsWithConfig(
  config: ChainConfig,
  poolId: string,
  startTime: number,
  endTime: number,
  maxSwaps: number = 50_000
): Promise<SwapData[]> {
  return fetchSwaps(
    config.subgraphUrl,
    poolId,
    startTime,
    endTime,
    maxSwaps,
    String(config.chain),
    config.version as "v2" | "v3"
  );
}
