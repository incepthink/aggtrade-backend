// src/queries/sushiswap.ts

/**
 * Get GraphQL query to find pools containing a specific token, ordered by TVL (V3)
 */
export function getPoolsByTVLQueryV3(): string {
  return `
    query GetPoolsByTVL($tokenAddress: String!) {
      pools(
        where: {
          or: [
            { token0: $tokenAddress },
            { token1: $tokenAddress }
          ]
        }
        orderBy: totalValueLockedUSD
        orderDirection: desc
        first: 10
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
        totalValueLockedUSD
        volumeUSD
      }
    }
  `;
}

/**
 * Get GraphQL query to find pairs containing a specific token, ordered by TVL (V2)
 */
export function getPairsByTVLQueryV2(): string {
  return `
    query GetPairsByTVL($tokenAddress: Bytes!) {
      pairs(
        where: {
          or: [
            { token0: $tokenAddress },
            { token1: $tokenAddress }
          ]
        }
        orderBy: reserveUSD
        orderDirection: desc
        first: 10
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
        reserveUSD
        volumeUSD
      }
    }
  `;
}

/**
 * Get GraphQL query for swap data from a specific pool with time filtering (V3)
 */
export function getSwapsQueryV3(): string {
  return `
    query GetSwaps($poolId: String!, $startTime: Int!, $endTime: Int!, $first: Int!, $skip: Int!) {
      swaps(
        where: {
          pool: $poolId,
          timestamp_gte: $startTime,
          timestamp_lte: $endTime
        }
        orderBy: timestamp
        orderDirection: asc
        first: $first
        skip: $skip
      ) {
        id
        timestamp
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
        token0PriceUSD
        token1PriceUSD
        amount0USD
        amount1USD
        amountUSD
        pool {
          id
        }
      }
    }
  `;
}

/**
 * Get GraphQL query for swap data from a specific pair with time filtering (V2)
 */
export function getSwapsQueryV2(): string {
  return `
    query GetSwaps($pairId: Bytes!, $startTime: BigInt!, $endTime: BigInt!, $first: Int!, $skip: Int!) {
      swaps(
        where: {
          pair: $pairId,
          timestamp_gte: $startTime,
          timestamp_lte: $endTime
        }
        orderBy: timestamp
        orderDirection: asc
        first: $first
        skip: $skip
      ) {
        id
        timestamp
        pair {
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
        }
        token0PriceUSD
        token1PriceUSD
        amount0USD
        amount1USD
        amountUSD
      }
    }
  `;
}

/**
 * Get appropriate pools/pairs query based on version
 */
export function getPoolsQuery(version: 'v2' | 'v3'): string {
  return version === 'v3' ? getPoolsByTVLQueryV3() : getPairsByTVLQueryV2();
}

/**
 * Get appropriate swaps query based on version
 */
export function getSwapsQuery(version: 'v2' | 'v3'): string {
  return version === 'v3' ? getSwapsQueryV3() : getSwapsQueryV2();
}

export function getUserTVLSimplifiedV3(): string {
  return `
    query GetUserTVLSimplified($userAddress: Bytes!) {
      positions(
        where: {
          owner: $userAddress,
          liquidity_gt: "0"
        }
      ) {
        id
        liquidity
        amountDepositedUSD
        amountWithdrawnUSD
        pool {
          id
          token0 {
            symbol
          }
          token1 {
            symbol
          }
        }
      }
    }
  `;
}