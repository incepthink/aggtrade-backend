// src/controllers/katana/utils/graphqlQueries.ts

/**
 * Get GraphQL query to find pools containing a specific token, ordered by TVL
 */
export function getPoolsByTVLQuery(): string {
  return `
    query GetPoolsByTVL($tokenAddress: String!) {
      pools(
        where: {
          or: [
            { token0_: { id: $tokenAddress } }
            { token1_: { id: $tokenAddress } }
          ]
        }
        orderBy: totalValueLockedUSD
        orderDirection: desc
        first: 20
      ) {
        id
        token0 { id symbol name decimals }
        token1 { id symbol name decimals }
        feeTier
        totalValueLockedUSD
        volumeUSD
      }
    }
  `;
}

/**
 * Get GraphQL query for fetching swaps in a specific time range
 */
export function getSwapsQuery(): string {
  return `
    query GetSwaps($poolId: String!, $startTime: Int!, $endTime: Int!, $first: Int!, $skip: Int!) {
      swaps(
        where: { pool: $poolId, timestamp_gte: $startTime, timestamp_lte: $endTime }
        orderBy: timestamp
        orderDirection: desc
        first: $first
        skip: $skip
      ) {
        id
        timestamp
        token0 { id symbol name decimals }
        token1 { id symbol name decimals }
        token0PriceUSD
        token1PriceUSD
        amount0USD
        amount1USD
        amountUSD
        sqrtPriceX96
        pool { id }
      }
    }
  `;
}

/**
 * Get GraphQL query for fetching historical swaps (older than a specific timestamp)
 * Used for appending historical data
 */
export function getHistoricalSwapsQuery(): string {
  return `
    query GetHistoricalSwaps($poolId: String!, $olderThan: Int!, $first: Int!, $skip: Int!) {
      swaps(
        where: { pool: $poolId, timestamp_lt: $olderThan }
        orderBy: timestamp
        orderDirection: desc
        first: $first
        skip: $skip
      ) {
        id
        timestamp
        token0 { id symbol name decimals }
        token1 { id symbol name decimals }
        token0PriceUSD
        token1PriceUSD
        amount0USD
        amount1USD
        amountUSD
        sqrtPriceX96
        pool { id }
      }
    }
  `;
}

/**
 * Get GraphQL query for fetching pool details
 */
export function getPoolInfoQuery(): string {
  return `
    query GetPoolInfo($poolId: String!) {
      pool(id: $poolId) {
        id
        token0 { id symbol name decimals }
        token1 { id symbol name decimals }
        feeTier
        totalValueLockedUSD
        volumeUSD
      }
    }
  `;
}

/**
 * Get all pools with their 24h and 7d data
 */
export function getPoolsWithMetricsQuery(): string {
  return `
    query GetPoolsWithMetrics {
      pools(
        orderBy: totalValueLockedUSD
        orderDirection: desc
        first: 1000
      ) {
        id
        token0 {
          id
          symbol
          name
          decimals
        }
        token1 {
          id
          symbol
          name
          decimals
        }
        feeTier
        liquidity
        totalValueLockedUSD
        volumeUSD
        txCount
        poolDayData(first: 7, orderBy: date, orderDirection: desc) {
          date
          volumeUSD
          tvlUSD
          txCount
        }
      }
    }
  `;
}