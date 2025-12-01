# Morpho Blue Withdraw API

## Overview

The Morpho Blue Withdraw API endpoint prepares blockchain transactions for withdrawing assets from Morpho Blue vaults on Katana network. This endpoint uses the Morpho Blue SDK and Bundler SDK to create optimized, bundled transactions that the frontend can sign and execute.

## Endpoint

```
POST /api/transaction/morpho/withdraw/prepare
```

## Supported Networks

- **Katana** (Chain ID: 747474)
- RPC: https://rpc.katana.network

## Request Format

### Headers
```
Content-Type: application/json
```

### Request Body

```typescript
{
  vaultAddress: string,     // Morpho vault address (0x...)
  assetAddress: string,     // Underlying asset address (0x...)
  userAddress: string,      // User's wallet address (0x...)
  amount: string,           // Token amount to withdraw (human-readable, e.g., "100.5")
  chainId: number,          // Must be 747474 for Katana
  decimals: number          // Asset token decimals (e.g., 18 for most tokens)
}
```

### Example Request

```json
{
  "vaultAddress": "0x1234567890abcdef1234567890abcdef12345678",
  "assetAddress": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  "userAddress": "0x9876543210fedcba9876543210fedcba98765432",
  "amount": "150.75",
  "chainId": 747474,
  "decimals": 18
}
```

## Response Format

### Success Response (200 OK)

```typescript
{
  message: string,
  data: {
    transactions: Array<{
      to: string,        // Contract address to send transaction to
      data: string,      // Encoded transaction data (hex string)
      value: string      // Native token value to send (usually "0")
    }>,
    needsApproval: boolean  // Always false for withdrawals
  }
}
```

### Example Success Response

```json
{
  "message": "Withdraw transaction prepared",
  "data": {
    "transactions": [
      {
        "to": "0x1234567890abcdef1234567890abcdef12345678",
        "data": "0x69328dec...",
        "value": "0"
      }
    ],
    "needsApproval": false
  }
}
```

### Error Response (400 Bad Request)

```json
{
  "message": "Failed to prepare withdraw transaction",
  "error": "Detailed error message"
}
```

### Error Response (500 Internal Server Error)

```json
{
  "message": "Failed to prepare withdraw transaction",
  "error": "Detailed error message"
}
```

## Validation Rules

### Required Fields
All fields in the request body are required:
- `vaultAddress`
- `assetAddress`
- `userAddress`
- `amount`
- `chainId`
- `decimals`

### Address Validation
All address fields must be valid Ethereum addresses:
- Must start with `0x`
- Must be exactly 42 characters long (0x + 40 hex characters)
- Must contain only valid hexadecimal characters

### Chain ID Validation
- Must be exactly `747474` (Katana network)
- Other chain IDs are not supported

### Amount Validation
- Must be a valid numeric string
- Must be greater than 0
- Can contain decimals (e.g., "100.5", "0.01")
- Should not be negative or zero

### Decimals Validation
- Must be an integer
- Must be between 0 and 77 (inclusive)
- Typically 18 for most ERC20 tokens

## Usage Flow

### Frontend Integration

1. **Prepare the withdraw transaction**:
```typescript
const response = await fetch('/api/transaction/morpho/withdraw/prepare', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    vaultAddress: '0x...',
    assetAddress: '0x...',
    userAddress: wallet.address,
    amount: '100.5',
    chainId: 747474,
    decimals: 18
  })
})

const { data } = await response.json()
```

2. **Execute transactions sequentially**:
```typescript
for (const tx of data.transactions) {
  const hash = await walletClient.sendTransaction({
    to: tx.to as `0x${string}`,
    data: tx.data as `0x${string}`,
    value: BigInt(tx.value),
    account: userAddress
  })

  // Wait for confirmation before sending next transaction
  await publicClient.waitForTransactionReceipt({ hash })
}
```

### Complete Example with Error Handling

```typescript
import { parseUnits } from 'viem'

async function withdrawFromMorpho(
  vaultAddress: string,
  assetAddress: string,
  amount: string,
  decimals: number
) {
  try {
    // 1. Prepare transaction
    const response = await fetch('/api/transaction/morpho/withdraw/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vaultAddress,
        assetAddress,
        userAddress: wallet.address,
        amount,
        chainId: 747474,
        decimals
      })
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to prepare transaction')
    }

    const { data } = await response.json()

    // 2. Execute all transactions in sequence
    const hashes: string[] = []

    for (let i = 0; i < data.transactions.length; i++) {
      const tx = data.transactions[i]

      console.log(`Sending transaction ${i + 1}/${data.transactions.length}...`)

      const hash = await walletClient.sendTransaction({
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: BigInt(tx.value),
        account: wallet.address
      })

      hashes.push(hash)

      // Wait for confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: hash as `0x${string}`
      })

      if (receipt.status !== 'success') {
        throw new Error(`Transaction ${i + 1} failed`)
      }

      console.log(`Transaction ${i + 1} confirmed:`, hash)
    }

    console.log('Withdrawal complete!')
    return hashes

  } catch (error) {
    console.error('Withdrawal failed:', error)
    throw error
  }
}
```

## Implementation Details

### Bundler SDK Integration

The endpoint uses the Morpho Bundler SDK to create optimized transaction bundles:

1. **SimulationState**: Initializes the current blockchain state (block number, timestamp)
2. **populateBundle**: Creates bundled operations from the withdraw request
3. **finalizeBundle**: Optimizes and finalizes the bundle for the user
4. **encodeBundle**: Encodes the bundle into executable transactions

### Transaction Bundle

The response may contain multiple transactions that need to be executed in sequence:
- **Approval transactions** (if needed - though not for withdrawals)
- **Main transaction**: The actual withdraw operation
- **Wrapper transactions**: Any additional setup required by the bundler

All transactions must be executed in the order they appear in the response array.

### No Approval Required

Unlike deposits, withdrawals from Morpho vaults do NOT require prior token approval because:
- You're withdrawing from the vault (not depositing into it)
- The vault shares are already owned by your address
- The vault contract has permission to burn your shares

Therefore, `needsApproval` will always be `false` in the response.

## Error Cases

### Common Errors

1. **Missing required fields**
   - Status: 400
   - Error: "Missing required fields: ..."

2. **Invalid chain ID**
   - Status: 400
   - Error: "Only Katana (chainId: 747474) is supported"

3. **Invalid address format**
   - Status: 400
   - Error: "Invalid vault/asset/user address format"

4. **Invalid amount**
   - Status: 400
   - Error: "Amount must be greater than 0"

5. **Invalid decimals**
   - Status: 400
   - Error: "Invalid decimals value"

6. **RPC connection failure**
   - Status: 500
   - Error: "Failed to prepare withdraw transaction" with connection details

7. **Bundle creation failure**
   - Status: 500
   - Error: Detailed error from Morpho SDK

## Testing

Run the test script to verify the endpoint:

```bash
# Make sure the server is running
bun run index.ts

# In another terminal, run the test
bun run test-morpho-endpoint.ts
```

Update the test script with real vault and asset addresses for actual testing.

## Dependencies

- `@morpho-org/blue-sdk`: Core Morpho Blue SDK
- `@morpho-org/blue-sdk-viem`: Viem integration for Morpho Blue
- `@morpho-org/bundler-sdk-viem`: Bundler SDK for optimized transactions
- `@morpho-org/simulation-sdk`: Simulation utilities
- `@morpho-org/morpho-ts`: TypeScript types
- `viem`: Ethereum library for encoding and parsing

## Notes

- This endpoint only supports Katana network (chain ID 747474)
- The `amount` parameter should be in human-readable format (not wei)
- All transactions must be executed in the order returned
- Each transaction should wait for confirmation before executing the next one
- The bundler may optimize operations, resulting in multiple transactions

## Related Endpoints

- `POST /api/transaction/yearn/deposit/prepare` - Similar pattern for Yearn deposits
- `POST /api/transaction/yearn/withdraw/prepare` - Similar pattern for Yearn withdrawals
- `POST /api/transaction/twap/limit-order/prepare` - TWAP limit orders
- `POST /api/transaction/classic-swap/execute` - SushiSwap classic swaps
