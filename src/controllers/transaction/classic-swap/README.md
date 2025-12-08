# Classic Swap with Fee Tier Extraction

This module provides Sushiswap classic swap functionality with automatic pool fee tier extraction and calculation.

## Features

- **Quote Generation**: Get swap quotes with pool fee information
- **Swap Execution**: Generate swap transactions with detailed fee breakdown
- **Fee Tier Extraction**: Automatically extracts pool addresses from transaction data and queries their fee tiers
- **Fee Calculation**: Calculates total fees for single and multi-hop swaps

## Endpoints

### POST `/transaction/classic-swap/quote`

Generate a swap quote with pool fee information.

**Request Body:**
```json
{
  "tokenIn": {
    "address": "0x203a662b0bd271a6ed5a60edfbd04bfce608fd36",
    "decimals": 6
  },
  "tokenOut": {
    "address": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    "decimals": 18
  },
  "amount": "20",
  "slippage": 0.5
}
```

**Response:**
```json
{
  "message": "Quote generated successfully",
  "data": {
    "amountOut": "6365155564492644",
    "priceImpact": "0.0005012339961431023",
    "swapPrice": "318257778.2246322",
    "amountIn": "20000000",
    "tokenFrom": "0x203a662b0bd271a6ed5a60edfbd04bfce608fd36",
    "tokenTo": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    "status": "Success",
    "routerAddress": "0xac4c6e212a361c968f1725b4d055b47e63f80b75",
    "poolFees": [
      {
        "poolAddress": "0x2a2c512beaa8eb15495726c235472d82effb7a6b",
        "feeTier": 3000,
        "feePercentage": "0.3%"
      }
    ]
  }
}
```

### POST `/transaction/classic-swap/execute`

Generate swap transaction data with detailed fee breakdown.

**Request Body:**
```json
{
  "tokenIn": {
    "address": "0x203a662b0bd271a6ed5a60edfbd04bfce608fd36",
    "decimals": 6
  },
  "tokenOut": {
    "address": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    "decimals": 18
  },
  "amount": "20",
  "slippage": 0.5,
  "userAddress": "0xYourWalletAddress"
}
```

**Response:**
```json
{
  "message": "Swap transaction generated successfully",
  "data": {
    "to": "0xac4c6e212a361c968f1725b4d055b47e63f80b75",
    "data": "0x5f3bd1c8...",
    "value": "0",
    "poolFees": [
      {
        "poolAddress": "0x2a2c512beaa8eb15495726c235472d82effb7a6b",
        "feeTier": 3000,
        "feePercentage": "0.3%"
      }
    ],
    "fees": {
      "totalFeeAmount": "60000",
      "totalFeePercentage": 0.3,
      "feeBreakdown": [
        {
          "poolAddress": "0x2a2c512beaa8eb15495726c235472d82effb7a6b",
          "feeAmount": "60000",
          "feeTier": 3000,
          "feePercentage": "0.3%"
        }
      ]
    }
  }
}
```

## Fee Tiers

Sushiswap V3 pools have different fee tiers:

| Fee Tier | Percentage | Use Case |
|----------|------------|----------|
| 100      | 0.01%      | Stablecoin pairs (very low volatility) |
| 500      | 0.05%      | Correlated pairs (low volatility) |
| 3000     | 0.3%       | Standard pairs (medium volatility) |
| 10000    | 1%         | Exotic pairs (high volatility) |

## How It Works

1. **Transaction Data Extraction**: When you call `getQuote()` or `getSwap()` from the Sushi SDK, the response includes transaction data with encoded pool addresses.

2. **Pool Address Parsing**: The `extractPoolAddresses()` function parses the transaction calldata to find all pool addresses used in the swap route.

3. **Fee Tier Querying**: For each pool address, the system queries the pool's `fee()` function to get the fee tier.

4. **Fee Calculation**: The `calculateTotalFees()` function computes:
   - Individual fee for each pool in the route
   - Total fee amount in Wei
   - Total fee percentage (compounded for multi-hop swaps)

## Multi-Hop Swaps

For multi-hop swaps (e.g., Token A → Token B → Token C), fees compound:

- Pool 1 takes 0.3% of the input amount
- Pool 2 takes 0.3% of the remaining amount after Pool 1's fee
- Total fee = 1 - (1 - 0.003) × (1 - 0.003) ≈ 0.599%

The `feeBreakdown` array in the response shows the fee for each pool individually.

## Implementation Details

### poolFeeExtractor.ts

- `extractPoolAddresses()`: Regex-based extraction of addresses from calldata
- `getPoolFeeTier()`: RPC call to pool contract using viem
- `calculateTotalFees()`: Fee calculation with compounding for multi-hop routes
- `formatFeePercentage()`: Converts fee tier integer to human-readable percentage

### Chain Configuration

Currently configured for Katana chain (Ronin):
- RPC: `https://api.roninchain.com/rpc`
- Router: `0xac4c6e212a361c968f1725b4d055b47e63f80b75`

## Error Handling

- If pool addresses cannot be extracted, `poolFees` will be an empty array
- If fee tier query fails for a pool, that pool is skipped
- If no valid pool fees are found, `fees` will be `null` in the execute response
- All errors are logged with `[Pool Fee]` prefix for debugging

## Future Improvements

1. **Cache pool fee tiers**: Reduce RPC calls by caching fee tiers (they rarely change)
2. **Route visualization**: Add visualization to show exact swap path
3. **Gas estimation**: Include gas cost estimates in fee calculations
4. **Multi-chain support**: Extend to other chains beyond Katana
