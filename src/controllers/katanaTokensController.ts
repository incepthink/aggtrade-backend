// src/controllers/katanaTokensController.ts
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
  poolCount: string;
  totalValueLockedUSD: string;
  volumeUSD: string;
  txCount: string;
}

interface GraphPool {
  id: string;
  createdAtTimestamp: string;
  feeTier: string;
  totalValueLockedUSD: string;
  volumeUSD: string;
  token0: GraphToken;
  token1: GraphToken;
}

interface SushiGraphResponse {
  data: {
    pools?: GraphPool[];
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
  poolCount: number;
  totalValueLockedUSD: number;
  volumeUSD: number;
  txCount: number;
  pools: string[]; // Pool addresses where this token is present
}

// -----------------------------
// Constants
// -----------------------------
const KATANA_SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/106601/sushi-v-3-katana-2/version/latest";
const KATANA_CHAIN_ID = 747474;

// -----------------------------
// GraphQL query
// -----------------------------
function getAllPoolsQuery(): string {
  return `
    query GetAllPools($first: Int!, $skip: Int!) {
      pools(
        first: $first
        skip: $skip
        orderBy: totalValueLockedUSD
        orderDirection: desc
      ) {
        id
        createdAtTimestamp
        feeTier
        totalValueLockedUSD
        volumeUSD
        token0 {
          id
          symbol
          name
          decimals
          totalSupply
          poolCount
          totalValueLockedUSD
          volumeUSD
          txCount
        }
        token1 {
          id
          symbol
          name
          decimals
          totalSupply
          poolCount
          totalValueLockedUSD
          volumeUSD
          txCount
        }
      }
    }
  `;
}

// -----------------------------
// Fetch all pools with pagination
// -----------------------------
async function fetchAllPools(): Promise<GraphPool[]> {
  const allPools: GraphPool[] = [];
  let hasMore = true;
  let skip = 0;
  const batchSize = 1000;

  console.log("[Katana Tokens] Fetching all pools...");

  while (hasMore) {
    try {
      const response = await axios.post<SushiGraphResponse>(
        KATANA_SUBGRAPH_URL,
        {
          query: getAllPoolsQuery(),
          variables: { first: batchSize, skip },
        },
        {
          timeout: 15000,
          headers: { "Content-Type": "application/json" },
        }
      );

      const pools = response.data?.data?.pools ?? [];

      if (!pools.length) {
        console.log("[Katana Tokens] No more pools returned, ending pagination");
        hasMore = false;
        break;
      }

      allPools.push(...pools);
      console.log(
        `[Katana Tokens] Fetched ${pools.length} pools, total: ${allPools.length}`
      );

      if (pools.length < batchSize) {
        hasMore = false;
      } else {
        skip += batchSize;
      }

      // Gentle rate-limit
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error: any) {
      console.error(
        `[Katana Tokens] Error fetching pools at skip ${skip}:`,
        error?.message ?? error
      );
      break;
    }
  }

  console.log(
    `[Katana Tokens] Completed fetching ${allPools.length} total pools`
  );
  return allPools;
}

// -----------------------------
// Process tokens from pools
// -----------------------------
function processTokensFromPools(pools: GraphPool[]): Map<string, ProcessedToken> {
  const tokensMap = new Map<string, ProcessedToken>();

  for (const pool of pools) {
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
          poolCount: Number.parseInt(gt.poolCount, 10) || 0,
          totalValueLockedUSD: Number.parseFloat(gt.totalValueLockedUSD) || 0,
          volumeUSD: Number.parseFloat(gt.volumeUSD) || 0,
          txCount: Number.parseInt(gt.txCount, 10) || 0,
          pools: [pool.id],
        });
      } else if (!existing.pools.includes(pool.id)) {
        existing.pools.push(pool.id);
      }
    };

    upsert(pool.token0);
    upsert(pool.token1);
  }

  console.log(
    `[Katana Tokens] Processed ${tokensMap.size} unique tokens from ${pools.length} pools`
  );
  return tokensMap;
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

  console.log(`[Katana Tokens] Saving ${tokens.length} tokens to database...`);

  try {
    const tokensData = tokens.map((t) => ({
      address: t.address.toLowerCase(),
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      total_supply: t.totalSupply ?? null,
      pool_count: t.poolCount,
      chain_id: KATANA_CHAIN_ID,
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
      `[Katana Tokens] Database operation completed: ${saved} new tokens, ${updated} updated tokens`
    );
  } catch (err) {
    console.error("[Katana Tokens] Error saving tokens to database:", err);
    errors = tokens.length;
  }

  return { saved, updated, errors };
}

// -----------------------------
// Controller: Sync tokens from subgraph to database
// -----------------------------
export async function getKatanaTokens(
  req: Request<{}, {}, {}, { force?: string; minTVL?: string }>,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { minTVL = "0" } = req.query;
    const minTVLValue = Number.parseFloat(minTVL || "0") || 0;

    console.log("[Katana Tokens] Fetching fresh data from subgraph...");
    const allPools = await fetchAllPools();

    if (!allPools.length) {
      res.status(404).json({
        status: "error",
        msg: "No pools found on Katana",
        chain: "katana",
      });
      return;
    }

    const tokensMap = processTokensFromPools(allPools);
    const allTokens = Array.from(tokensMap.values()).sort(
      (a, b) => (b.totalValueLockedUSD || 0) - (a.totalValueLockedUSD || 0)
    );

    // Always save to database
    const dbStats = await saveTokensToDatabase(allTokens);

    // Get tokens from database (this ensures we get the complete data including tradable flags)
    const dbTokens = await (TokenModel as any).findAll({
      where: { chain_id: KATANA_CHAIN_ID },
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
      totalPools: allPools.length,
      totalTokens: allTokens.length,
      filteredCount: filteredTokens.length,
      tokensInDatabase: dbTokens.length,
      minTVLFilter: minTVLValue,
      lastUpdate: Math.floor(Date.now() / 1000),
      chain: "katana",
      dex: "sushiswap-v3",
      topTokensByTVL: filteredTokens.slice(0, 10).map((t) => ({
        symbol: t.symbol,
        address: t.address,
        tvl: t.totalValueLockedUSD,
        poolCount: t.poolCount,
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
      source: "katana-subgraph",
      cached: false,
      chain: "katana",
      stats: {
        totalPools: allPools.length,
        totalTokens: allTokens.length,
        returnedTokens: filteredTokens.length,
        databaseStats: dbStats,
      },
    });
  } catch (error: any) {
    console.error("[Katana Tokens] Controller error:", error);
    res.status(500).json({
      status: "error",
      msg: "Failed to fetch token data",
      debug: { error: error?.message ?? String(error) },
      chain: "katana",
    });
  }
}

// -----------------------------
// Controller: DB reads (search/filter/tradable)
// -----------------------------
export async function getTokensFromDatabase(
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
          chain_id: KATANA_CHAIN_ID,
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
          chain_id: KATANA_CHAIN_ID,
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
          chain_id: KATANA_CHAIN_ID,
          tradable: true
        },
        order: [['pool_count', 'DESC'], ['symbol', 'ASC']],
        raw: true
      });
    } else {
      tokens = await (TokenModel as any).findAll({
        attributes,
        where: { chain_id: KATANA_CHAIN_ID },
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
          chain: "katana",
          filters: {
            tradable: onlyTradable,
            search: search || null,
            minPools: minPoolsValue || null,
          },
        },
      },
      source: "database",
      chain: "katana",
    });
  } catch (error: any) {
    console.error("[Katana Tokens DB] Controller error:", error);
    res.status(500).json({
      status: "error",
      msg: "Failed to fetch tokens from database",
      debug: { error: error?.message ?? String(error) },
      chain: "katana",
    });
  }
}

// -----------------------------
// Controller: Update token fields (single or batch)
// -----------------------------
export async function updateToken(
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
              chain_id: KATANA_CHAIN_ID,
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
    console.error("[Katana Tokens Update] Controller error:", error);
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
export async function getKatanaTokensStats(
  _req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    // Get all tokens from database for statistics
    const tokens = await (TokenModel as any).findAll({
      where: { chain_id: KATANA_CHAIN_ID },
      order: [["pool_count", "DESC"]],
      raw: true,
    });

    if (!tokens.length) {
      res.status(200).json({
        status: "success",
        data: {
          message: "No tokens found in database. Call /katana/tokens to sync from subgraph.",
          stats: { totalTokens: 0 },
        },
        chain: "katana",
        source: "database",
      });
      return;
    }

    const totalTokens = tokens.length;
    const tradableTokens = tokens.filter((t: any) => t.tradable === true);
    const nonTradableTokens = tokens.filter((t: any) => t.tradable === false);
    
    // Calculate pool count statistics
    const tokensWithPools = tokens.filter((t: any) => (t.pool_count || 0) > 0);
    const avgPoolCount = tokensWithPools.length > 0 
      ? tokensWithPools.reduce((sum: number, t: any) => sum + (t.pool_count || 0), 0) / tokensWithPools.length 
      : 0;

    res.status(200).json({
      status: "success",
      data: {
        summary: {
          totalTokens,
          tradableTokens: tradableTokens.length,
          nonTradableTokens: nonTradableTokens.length,
          tokensWithPools: tokensWithPools.length,
          averagePoolCount: Number(avgPoolCount.toFixed(2)),
        },
        topTokensByPools: tokens.slice(0, 20).map((t: any) => ({
          symbol: t.symbol,
          name: t.name,
          address: t.address,
          poolCount: t.pool_count || 0,
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
            poolCount: t.pool_count || 0,
            createdAt: t.created_at,
            tradable: t.tradable,
          })),
      },
      chain: "katana",
      source: "database",
    });
  } catch (error: any) {
    console.error("[Katana Tokens Stats] Controller error:", error);
    res.status(500).json({
      status: "error",
      msg: "Failed to fetch token statistics",
      debug: { error: error?.message ?? String(error) },
      chain: "katana",
    });
  }
}