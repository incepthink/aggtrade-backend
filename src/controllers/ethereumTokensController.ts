// src/controllers/ethereumTokensController.ts
import type { Request, Response, NextFunction } from "express";
import axios from "axios";
import TokenModel from "../models/Token";
import { Op } from "sequelize";

// -----------------------------
// GraphQL/Processing Interfaces
// -----------------------------
interface GraphToken {
  id: string;
  symbol: string;
  name: string;
  decimals: string;
  totalSupply: string;
  tradeVolume: string;
  tradeVolumeUSD: string;
  untrackedVolumeUSD: string;
  txCount: string;
  totalLiquidity: string;
  derivedETH: string;
}

interface GraphPair {
  id: string;
  createdAtTimestamp: string;
  reserveUSD: string;
  volumeUSD: string;
  token0: GraphToken;
  token1: GraphToken;
}

interface SushiGraphResponse {
  data: {
    pairs?: GraphPair[];
    tokens?: GraphToken[];
  };
  errors?: unknown[];
}

export interface ProcessedToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  totalSupply: string;
  pairCount: number;
  totalValueLockedUSD: number;
  volumeUSD: number;
  txCount: number;
  pairs: string[]; // Pair addresses where this token is present
}

// -----------------------------
// Constants
// -----------------------------
const ETHEREUM_SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/106601/sushi-v-2-eth/version/latest";
const ETHEREUM_CHAIN_ID = 1;

// -----------------------------
// GraphQL query
// -----------------------------
function getAllPairsQuery(): string {
  return `
    query GetAllPairs($first: Int!, $skip: Int!, $minVolume: BigDecimal!) {
      pairs(
        where: {
          volumeUSD_gte: $minVolume
        }
        first: $first
        skip: $skip
        orderBy: reserveUSD
        orderDirection: desc
      ) {
        id
        createdAtTimestamp
        reserveUSD
        volumeUSD
        token0 {
          id
          symbol
          name
          decimals
          totalSupply
          tradeVolume
          tradeVolumeUSD
          untrackedVolumeUSD
          txCount
          totalLiquidity
          derivedETH
        }
        token1 {
          id
          symbol
          name
          decimals
          totalSupply
          tradeVolume
          tradeVolumeUSD
          untrackedVolumeUSD
          txCount
          totalLiquidity
          derivedETH
        }
      }
    }
  `;
}

// -----------------------------
// Fetch all pairs with pagination
// -----------------------------
async function fetchAllPairs(): Promise<GraphPair[]> {
  const allPairs: GraphPair[] = [];
  let hasMore = true;
  let skip = 0;
  const batchSize = 1000;
  const minVolume = "10000"; // Only fetch pairs with >$10k volume

  console.log("[Ethereum Tokens] Fetching all pairs with volume >$10k...");

  while (hasMore) {
    try {
      const response = await axios.post<SushiGraphResponse>(
        ETHEREUM_SUBGRAPH_URL,
        {
          query: getAllPairsQuery(),
          variables: { first: batchSize, skip, minVolume },
        },
        {
          timeout: 15000,
          headers: { "Content-Type": "application/json" },
        }
      );

      const pairs = response.data?.data?.pairs ?? [];

      if (!pairs.length) {
        console.log("[Ethereum Tokens] No more pairs returned, ending pagination");
        hasMore = false;
        break;
      }

      allPairs.push(...pairs);
      console.log(
        `[Ethereum Tokens] Fetched ${pairs.length} pairs, total: ${allPairs.length}`
      );

      if (pairs.length < batchSize) {
        hasMore = false;
      } else {
        skip += batchSize;
      }

      // Gentle rate-limit
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error: any) {
      console.error(
        `[Ethereum Tokens] Error fetching pairs at skip ${skip}:`,
        error?.message ?? error
      );
      break;
    }
  }

  console.log(
    `[Ethereum Tokens] Completed fetching ${allPairs.length} total pairs`
  );
  return allPairs;
}

// -----------------------------
// Process tokens from pairs
// -----------------------------
function processTokensFromPairs(pairs: GraphPair[]): Map<string, ProcessedToken> {
  const tokensMap = new Map<string, ProcessedToken>();

  for (const pair of pairs) {
    const upsert = (gt: GraphToken) => {
      const addrLower = gt.id.toLowerCase();
      const existing = tokensMap.get(addrLower);

      if (!existing) {
        tokensMap.set(addrLower, {
          address: gt.id,
          symbol: gt.symbol,
          name: gt.name,
          decimals: Number.parseInt(gt.decimals, 10) || 0,
          totalSupply: gt.totalSupply,
          pairCount: 1, // Will be counted as we process pairs
          totalValueLockedUSD: Number.parseFloat(gt.totalLiquidity) || 0,
          volumeUSD: Number.parseFloat(gt.tradeVolumeUSD) || 0,
          txCount: Number.parseInt(gt.txCount, 10) || 0,
          pairs: [pair.id],
        });
      } else if (!existing.pairs.includes(pair.id)) {
        existing.pairs.push(pair.id);
        existing.pairCount = existing.pairs.length;
      }
    };

    upsert(pair.token0);
    upsert(pair.token1);
  }

  // Filter out tokens with less than 2 pairs
  const filteredTokensMap = new Map<string, ProcessedToken>();
  for (const [address, token] of tokensMap.entries()) {
    if (token.pairCount >= 2) {
      filteredTokensMap.set(address, token);
    }
  }

  console.log(
    `[Ethereum Tokens] Processed ${tokensMap.size} unique tokens from ${pairs.length} pairs`
  );
  console.log(
    `[Ethereum Tokens] Filtered to ${filteredTokensMap.size} tokens with >= 2 pairs`
  );
  
  return filteredTokensMap;
}

// -----------------------------
// Save tokens to DB (bulk upsert)
// -----------------------------
async function saveTokensToDatabase(
  tokens: ProcessedToken[]
): Promise<{ saved: number; updated: number; errors: number }> {
  let saved = 0;
  let updated = 0;
  let errors = 0;

  console.log(`[Ethereum Tokens] Saving ${tokens.length} tokens to database...`);

  try {
    const tokensData = tokens.map((t) => ({
      address: t.address.toLowerCase(),
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      total_supply: t.totalSupply ?? null,
      pool_count: t.pairCount, // Using pairCount instead of poolCount for V2
      chain_id: ETHEREUM_CHAIN_ID,
      tradable: true,
    }));

    // Soft-type custom model method to avoid TS errors if not declared on the model type
    const results: Array<{ created?: boolean }> = await (TokenModel as any)
      .bulkUpsertTokens(tokensData);

    for (const r of results) {
      if (r?.created) saved++;
      else updated++;
    }

    console.log(
      `[Ethereum Tokens] Database operation completed: ${saved} new tokens, ${updated} updated tokens`
    );
  } catch (err) {
    console.error("[Ethereum Tokens] Error saving tokens to database:", err);
    errors = tokens.length;
  }

  return { saved, updated, errors };
}

// -----------------------------
// Controller: Sync tokens from subgraph to database
// -----------------------------
export async function getEthereumTokens(
  req: Request<{}, {}, {}, { force?: string; minTVL?: string }>,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { minTVL = "0" } = req.query;
    const minTVLValue = Number.parseFloat(minTVL || "0") || 0;

    console.log("[Ethereum Tokens] Fetching fresh data from subgraph...");
    const allPairs = await fetchAllPairs();

    if (!allPairs.length) {
      res.status(404).json({
        status: "error",
        msg: "No pairs found on Ethereum",
        chain: "ethereum",
      });
      return;
    }

    const tokensMap = processTokensFromPairs(allPairs);
    const allTokens = Array.from(tokensMap.values()).sort(
      (a, b) => (b.totalValueLockedUSD || 0) - (a.totalValueLockedUSD || 0)
    );

    // Always save to database
    const dbStats = await saveTokensToDatabase(allTokens);

    // Get tokens from database (this ensures we get the complete data including tradable flags)
    const dbTokens = await (TokenModel as any).findAll({
      where: { chain_id: ETHEREUM_CHAIN_ID },
      order: [
        ["pool_count", "DESC"],
        ["symbol", "ASC"],
      ],
      raw: true,
    });

    // Apply minTVL filter to the fresh data for response
    const filteredTokens =
      minTVLValue > 0
        ? allTokens.filter((t) => (t.totalValueLockedUSD || 0) >= minTVLValue)
        : allTokens;

    const metadata = {
      totalPairs: allPairs.length,
      totalTokens: allTokens.length,
      filteredCount: filteredTokens.length,
      tokensInDatabase: dbTokens.length,
      minTVLFilter: minTVLValue,
      lastUpdate: Math.floor(Date.now() / 1000),
      chain: "ethereum",
      dex: "sushiswap-v2",
      topTokensByTVL: filteredTokens.slice(0, 10).map((t) => ({
        symbol: t.symbol,
        address: t.address,
        tvl: t.totalValueLockedUSD,
        pairCount: t.pairCount,
      })),
      databaseStats: {
        tokensSaved: dbStats.saved,
        tokensUpdated: dbStats.updated,
        errors: dbStats.errors,
      },
    };

    res.status(200).json({
      status: "success",
      data: { tokens: filteredTokens, metadata },
      source: "ethereum-subgraph",
      cached: false,
      chain: "ethereum",
      stats: {
        totalPairs: allPairs.length,
        totalTokens: allTokens.length,
        returnedTokens: filteredTokens.length,
        databaseStats: dbStats,
      },
    });
  } catch (error: any) {
    console.error("[Ethereum Tokens] Controller error:", error);
    res.status(500).json({
      status: "error",
      msg: "Failed to fetch token data",
      debug: { error: error?.message ?? String(error) },
      chain: "ethereum",
    });
  }
}

// -----------------------------
// Controller: DB reads (search/filter/tradable)
// -----------------------------
export async function getEthereumTokensFromDatabase(
  req: Request<{}, {}, {}, { tradable?: string; search?: string; minPools?: string }>,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { tradable = "true", search, minPools } = req.query;
    const onlyTradable = tradable === "true";
    const minPoolsValue = minPools ? Number.parseInt(minPools, 10) || 0 : 0;

    let tokens: any[] = [];

    // Define attributes to exclude timestamps
    const attributes = [
      'address',
      'symbol',
      'name',
      'decimals',
      'total_supply',
      'pool_count',
      'tradable',
      'chain_id',
      'logo_uri'
    ];

    if (search) {
      tokens = await (TokenModel as any).findAll({
        attributes,
        where: {
          chain_id: ETHEREUM_CHAIN_ID,
          tradable: true,
          [Op.or]: [
            { symbol: { [Op.like]: `%${search}%` } },
            { name: { [Op.like]: `%${search}%` } }
          ]
        },
        order: [['pool_count', 'DESC'], ['symbol', 'ASC']],
        limit: 100,
        raw: true
      });
    } else if (minPoolsValue > 0) {
      tokens = await (TokenModel as any).findAll({
        attributes,
        where: {
          chain_id: ETHEREUM_CHAIN_ID,
          tradable: true,
          pool_count: { [Op.gte]: minPoolsValue }
        },
        order: [['pool_count', 'DESC']],
        raw: true
      });
    } else if (onlyTradable) {
      tokens = await (TokenModel as any).findAll({
        attributes,
        where: {
          chain_id: ETHEREUM_CHAIN_ID,
          tradable: true
        },
        order: [['pool_count', 'DESC'], ['symbol', 'ASC']],
        raw: true
      });
    } else {
      tokens = await (TokenModel as any).findAll({
        attributes,
        where: { chain_id: ETHEREUM_CHAIN_ID },
        order: [
          ["pool_count", "DESC"],
          ["symbol", "ASC"],
        ],
        raw: true,
      });
    }

    res.status(200).json({
      status: "success",
      data: {
        tokens,
        metadata: {
          count: tokens.length,
          chain: "ethereum",
          filters: {
            tradable: onlyTradable,
            search: search || null,
            minPools: minPoolsValue || null,
          },
        },
      },
      source: "database",
      chain: "ethereum",
    });
  } catch (error: any) {
    console.error("[Ethereum Tokens DB] Controller error:", error);
    res.status(500).json({
      status: "error",
      msg: "Failed to fetch tokens from database",
      debug: { error: error?.message ?? String(error) },
      chain: "ethereum",
    });
  }
}

// -----------------------------
// Controller: Update token fields (single or batch)
// -----------------------------
export async function updateEthereumToken(
  req: Request<{}, {}, { tokens?: Array<{ address: string; [key: string]: any }> }>,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { tokens } = req.body;

    if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
      res.status(400).json({
        status: "error",
        msg: "tokens array is required and must contain at least one token",
      });
      return;
    }

    // Validate each token has an address
    const invalidTokens = tokens.filter(token => !token.address);
    if (invalidTokens.length > 0) {
      res.status(400).json({
        status: "error",
        msg: "All tokens must have an address field",
        invalidTokens,
      });
      return;
    }

    const results = [];
    const errors = [];

    for (const tokenUpdate of tokens) {
      try {
        const { address, ...updateFields } = tokenUpdate;
        
        // Filter out invalid fields and prepare update data
        const allowedFields = ['symbol', 'name', 'decimals', 'total_supply', 'pool_count', 'tradable', 'logo_uri'];
        const filteredFields: any = {};
        
        for (const [key, value] of Object.entries(updateFields)) {
          if (allowedFields.includes(key)) {
            // Handle specific field types
            if (key === 'decimals' && value !== null && value !== undefined) {
              filteredFields[key] = Number.parseInt(String(value), 10);
            } else if (key === 'pool_count' && value !== null && value !== undefined) {
              filteredFields[key] = Number.parseInt(String(value), 10);
            } else if (key === 'tradable' && value !== null && value !== undefined) {
              filteredFields[key] = Boolean(value);
            } else {
              filteredFields[key] = value;
            }
          }
        }

        if (Object.keys(filteredFields).length === 0) {
          errors.push({
            address,
            error: "No valid fields to update",
            allowedFields,
          });
          continue;
        }

        // Update the token
        const [updatedCount] = await (TokenModel as any).update(
          filteredFields,
          {
            where: {
              address: address.toLowerCase(),
              chain_id: ETHEREUM_CHAIN_ID,
            },
          }
        );

        if (updatedCount === 0) {
          errors.push({
            address,
            error: "Token not found",
          });
        } else {
          results.push({
            address,
            updatedFields: filteredFields,
            success: true,
          });
        }
      } catch (error: any) {
        errors.push({
          address: tokenUpdate.address,
          error: error?.message ?? String(error),
        });
      }
    }

    const response: any = {
      status: "success",
      data: {
        totalRequested: tokens.length,
        successful: results.length,
        failed: errors.length,
        results,
      },
    };

    if (errors.length > 0) {
      response.data.errors = errors;
      response.status = results.length > 0 ? "partial" : "error";
    }

    res.status(errors.length === tokens.length ? 400 : 200).json(response);
  } catch (error: any) {
    console.error("[Ethereum Tokens Update] Controller error:", error);
    res.status(500).json({
      status: "error",
      msg: "Failed to update tokens",
      debug: { error: error?.message ?? String(error) },
    });
  }
}

// -----------------------------
// Controller: Database stats summary
// -----------------------------
export async function getEthereumTokensStats(
  _req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    // Get all tokens from database for statistics
    const tokens = await (TokenModel as any).findAll({
      where: { chain_id: ETHEREUM_CHAIN_ID },
      order: [["pool_count", "DESC"]],
      raw: true,
    });

    if (!tokens.length) {
      res.status(200).json({
        status: "success",
        data: {
          message: "No tokens found in database. Call /ethereum/tokens to sync from subgraph.",
          stats: { totalTokens: 0 },
        },
        chain: "ethereum",
        source: "database",
      });
      return;
    }

    const totalTokens = tokens.length;
    const tradableTokens = tokens.filter((t: any) => t.tradable === true);
    const nonTradableTokens = tokens.filter((t: any) => t.tradable === false);
    
    // Calculate pair count statistics (using pool_count field which stores pair count for Ethereum)
    const tokensWithPairs = tokens.filter((t: any) => (t.pool_count || 0) > 0);
    const avgPairCount = tokensWithPairs.length > 0 
      ? tokensWithPairs.reduce((sum: number, t: any) => sum + (t.pool_count || 0), 0) / tokensWithPairs.length 
      : 0;

    res.status(200).json({
      status: "success",
      data: {
        summary: {
          totalTokens,
          tradableTokens: tradableTokens.length,
          nonTradableTokens: nonTradableTokens.length,
          tokensWithPairs: tokensWithPairs.length,
          averagePairCount: Number(avgPairCount.toFixed(2)),
        },
        topTokensByPairs: tokens.slice(0, 20).map((t: any) => ({
          symbol: t.symbol,
          name: t.name,
          address: t.address,
          pairCount: t.pool_count || 0, // pool_count stores pair count for Ethereum
          decimals: t.decimals,
          tradable: t.tradable,
        })),
        recentTokens: tokens
          .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .slice(0, 10)
          .map((t: any) => ({
            symbol: t.symbol,
            name: t.name,
            address: t.address,
            pairCount: t.pool_count || 0,
            createdAt: t.created_at,
            tradable: t.tradable,
          })),
      },
      chain: "ethereum",
      source: "database",
    });
  } catch (error: any) {
    console.error("[Ethereum Tokens Stats] Controller error:", error);
    res.status(500).json({
      status: "error",
      msg: "Failed to fetch token statistics",
      debug: { error: error?.message ?? String(error) },
      chain: "ethereum",
    });
  }
}