# Bot Monitoring Frontend - API Changes

## Summary of Changes

The backend bot tracking API has been updated with the following key changes:

### 1. Changed: `starting_token` → `tokens` (array)
- **Old**: Single `starting_token` field (string)
- **New**: `tokens` array (string[]) to track multiple tokens used during execution

### 2. Changed: Wallet record creation is now lazy
- **Old**: All wallet records created upfront in `/bot/execution/start`
- **New**: Wallet records created on-demand when wallet starts execution

### 3. Changed: Volume/swap counts now provided by bot
- **Old**: Backend calculated from `sushiswap_activity` table
- **New**: Bot must provide `swaps_completed` and `total_volume_usd` when completing wallet

---

## Updated API Endpoints

### 1. POST `/tracking/bot/execution/start`

**CHANGED**: No longer requires `wallets` array. Only creates execution record.

**Request Body:**
```json
{
  "execution_id": "uuid-here",
  "strategy_name": "4-token-rotation",
  "total_wallets": 100
}
```

**Response:**
```json
{
  "message": "Execution started successfully",
  "execution": {
    "id": 1,
    "execution_id": "uuid-here",
    "strategy_name": "4-token-rotation",
    "total_wallets": 100,
    "completed_wallets": 0,
    "failed_wallets": 0,
    "total_volume_usd": 0,
    "start_time": "2025-11-23T10:00:00.000Z",
    "status": "running"
  }
}
```

**Key Change**: No wallet records created at this stage.

---

### 2. PATCH `/tracking/bot/execution/:execution_id/wallet/:wallet_index/start`

**CHANGED**: No longer requires `starting_token`. Creates wallet record on first call.

**Request Body:**
```json
{
  "wallet_address": "0xWalletAddress"
}
```

**Response:**
```json
{
  "message": "Wallet execution created and started",
  "walletExecution": {
    "id": 5,
    "execution_id": "uuid-here",
    "wallet_index": 0,
    "wallet_address": "0xWalletAddress",
    "tokens": [],
    "swaps_completed": 0,
    "total_volume_usd": 0,
    "status": "running",
    "start_time": "2025-11-23T10:01:00.000Z"
  }
}
```

**Key Changes**:
- Only requires `wallet_address` now (no `starting_token`)
- `tokens` field is now an empty array `[]`
- This endpoint creates the database record for this wallet

---

### 3. PATCH `/tracking/bot/execution/:execution_id/wallet/:wallet_index/complete`

**CHANGED**: Bot must now provide swap counts, volume, and optionally tokens array.

**Request Body:**
```json
{
  "status": "completed",
  "swaps_completed": 12,
  "total_volume_usd": 36000.50,
  "wallet_address": "0xWalletAddress",
  "tokens": ["ETH", "USDC", "WBTC", "LBTC"],
  "error_message": null
}
```

**Response:**
```json
{
  "message": "Wallet execution completed",
  "walletExecution": {
    "id": 5,
    "execution_id": "uuid-here",
    "wallet_index": 0,
    "wallet_address": "0xWalletAddress",
    "tokens": ["ETH", "USDC", "WBTC", "LBTC"],
    "swaps_completed": 12,
    "total_volume_usd": 36000.50,
    "status": "completed",
    "end_time": "2025-11-23T10:30:00.000Z"
  }
}
```

**Key Changes**:
- **REQUIRED**: `swaps_completed` (number) - Bot must count and provide
- **REQUIRED**: `total_volume_usd` (number) - Bot must calculate and provide
- **OPTIONAL**: `wallet_address` (string) - Can update if needed
- **OPTIONAL**: `tokens` (string[]) - Array of token symbols used (e.g., `["ETH", "USDC", "WBTC"]`)
- Backend no longer queries `sushiswap_activity` for these stats

---

## Frontend Implementation Changes

### Change 1: Remove wallet data from execution start

**Old Code:**
```typescript
await POST('/tracking/bot/execution/start', {
  execution_id: executionId,
  strategy_name: '4-token-rotation',
  total_wallets: wallets.length,
  wallets: wallets.map((w, i) => ({
    address: w.address,
    starting_token: w.startToken
  }))
})
```

**New Code:**
```typescript
await POST('/tracking/bot/execution/start', {
  execution_id: executionId,
  strategy_name: '4-token-rotation',
  total_wallets: wallets.length
})
```

---

### Change 2: Simplify wallet start request

**Old Code:**
```typescript
await PATCH(`/tracking/bot/execution/${executionId}/wallet/${walletIndex}/start`, {
  wallet_address: wallet.address,
  starting_token: wallet.startToken
})
```

**New Code:**
```typescript
await PATCH(`/tracking/bot/execution/${executionId}/wallet/${walletIndex}/start`, {
  wallet_address: wallet.address
})
```

---

### Change 3: Track stats locally and send on completion

**Old Code:**
```typescript
// Just mark complete, backend calculated stats
await PATCH(`/tracking/bot/execution/${executionId}/wallet/${walletIndex}/complete`, {
  status: 'completed',
  error_message: null
})
```

**New Code:**
```typescript
// Bot tracks stats and sends them
const swapsCompleted = localSwapCounter // Your counter
const totalVolume = localVolumeSum // Your sum
const tokensUsed = uniqueTokenSymbols // Your unique tokens set

await PATCH(`/tracking/bot/execution/${executionId}/wallet/${walletIndex}/complete`, {
  status: 'completed',
  swaps_completed: swapsCompleted,
  total_volume_usd: totalVolume,
  tokens: tokensUsed, // e.g., ["ETH", "USDC", "WBTC", "LBTC"]
  error_message: null
})
```

---

## Complete Updated Flow

```typescript
// 1. Start execution (no wallet data)
const executionId = generateUUID()
await POST('/tracking/bot/execution/start', {
  execution_id: executionId,
  strategy_name: '4-token-rotation',
  total_wallets: 100
})

// 2. For each wallet
for (let i = 0; i < wallets.length; i++) {
  const wallet = wallets[i]

  // Track locally
  let swapCount = 0
  let volumeSum = 0
  const tokensUsed = new Set<string>()

  // Start wallet (creates DB record)
  await PATCH(`/tracking/bot/execution/${executionId}/wallet/${i}/start`, {
    wallet_address: wallet.address
  })

  try {
    // Execute swaps
    for (const swap of swapSequence) {
      const result = await executeSwap(wallet, swap)

      // Track locally
      swapCount++
      volumeSum += result.usdVolume
      tokensUsed.add(swap.tokenFrom.symbol)
      tokensUsed.add(swap.tokenTo.symbol)

      // Portfolio snapshot
      await POST('/tracking/bot/portfolio/snapshot', {
        execution_id: executionId,
        wallet_address: wallet.address,
        total_capital_usd: result.totalCapital,
        eth_balance: result.balances.eth,
        usdc_balance: result.balances.usdc,
        wbtc_balance: result.balances.wbtc,
        lbtc_balance: result.balances.lbtc
      })
    }

    // Complete wallet with stats
    await PATCH(`/tracking/bot/execution/${executionId}/wallet/${i}/complete`, {
      status: 'completed',
      swaps_completed: swapCount,
      total_volume_usd: volumeSum,
      tokens: Array.from(tokensUsed),
      error_message: null
    })

  } catch (error) {
    // Mark as failed
    await PATCH(`/tracking/bot/execution/${executionId}/wallet/${i}/complete`, {
      status: 'failed',
      swaps_completed: swapCount,
      total_volume_usd: volumeSum,
      tokens: Array.from(tokensUsed),
      error_message: error.message
    })
  }
}
```

---

## Data Model Changes

### BotWalletExecution Model

**Old Schema:**
```typescript
{
  id: number
  execution_id: string
  wallet_index: number
  wallet_address: string
  starting_token: string      // REMOVED
  swaps_completed: number
  total_volume_usd: number
  status: string
  error_message: string | null
  start_time: Date | null
  end_time: Date | null
}
```

**New Schema:**
```typescript
{
  id: number
  execution_id: string
  wallet_index: number
  wallet_address: string
  tokens: string[]            // ADDED - array of token symbols
  swaps_completed: number
  total_volume_usd: number
  status: string
  error_message: string | null
  start_time: Date | null
  end_time: Date | null
}
```

---

## Frontend Display Changes

### Displaying tokens

**Old:**
```tsx
<div>Starting Token: {wallet.starting_token}</div>
```

**New:**
```tsx
<div>Tokens Used: {wallet.tokens.join(', ')}</div>
```

Example: `"Tokens Used: ETH, USDC, WBTC, LBTC"`

---

## Key Takeaways

1. **Lazy Creation**: Wallet records only created when wallet starts (not upfront)
2. **No Auto-Calculation**: Bot must track and send `swaps_completed` and `total_volume_usd`
3. **Tokens Array**: Track all unique token symbols used, send as array on completion
4. **Simpler Start**: Only need `wallet_address` when starting wallet execution
5. **Local Tracking**: Bot must maintain counters locally during execution

---

## Validation Checklist

Before deploying, ensure your bot:

- ✅ Tracks swap count locally (increment on each swap)
- ✅ Tracks volume sum locally (add USD volume on each swap)
- ✅ Tracks unique token symbols used (Set of symbols)
- ✅ Sends these values in `/complete` endpoint
- ✅ Only sends `wallet_address` in `/start` endpoint
- ✅ Converts tokens Set to Array before sending: `Array.from(tokensSet)`
- ✅ Handles both success and failure cases (always send stats even on failure)

---

## Testing Example

```typescript
// Example wallet completion call
await fetch('/tracking/bot/execution/abc-123/wallet/0/complete', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    status: 'completed',
    swaps_completed: 12,
    total_volume_usd: 36547.89,
    tokens: ['ETH', 'USDC', 'WBTC', 'LBTC'],
    wallet_address: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    error_message: null
  })
})
```

Expected response: 200 OK with updated wallet execution data.
