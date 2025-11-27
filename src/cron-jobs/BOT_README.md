# Limit Order Bot

Automated limit order bot for Katana (Ronin chain) using TWAP (Time-Weighted Average Price) orders via Orbs protocol.

## Overview

This bot creates limit orders using the **exact same flow** as your frontend application. It:
- Uses wallet private keys from environment variables
- Integrates with your backend transaction and tracking APIs
- Supports ETH and USDC trading pairs on Katana
- Logs all activities to your tracking database
- Handles token approvals automatically
- Implements proper error handling and retry logic

## Files Structure

```
src/cron-jobs/
├── limitOrderBot.ts              # Main bot implementation
├── utils/
│   ├── botWalletManager.ts       # Wallet loading and management
│   └── botHelpers.ts             # Amount calculations and utilities
├── examples/
│   └── limitOrderBotExample.ts   # Usage examples
└── BOT_README.md                 # This file
```

## Setup

### 1. Environment Variables

Add your wallet private keys to `.env`:

```bash
# Bot Wallets
WALLET_1=0x1234567890abcdef...  # First wallet private key
WALLET_2=0xabcdef1234567890...  # Second wallet private key
WALLET_3=0x...                  # Add as many as needed

# Network Configuration
KATANA_RPC_URL=https://api.roninchain.com/rpc
BACKEND_URL=http://localhost:5000  # Or your production URL
```

**⚠️ SECURITY WARNING**: Never commit private keys to git! Keep them in `.env` and add `.env` to `.gitignore`.

### 2. Install Dependencies

The bot uses these packages (already in your package.json):
- `ethers` - For blockchain interactions
- `axios` - For API calls
- `node-cron` - For scheduled execution

## Usage

### Manual Execution

```typescript
import { triggerLimitOrderBotManually, type LimitOrderParams } from './cron-jobs/limitOrderBot'

const params: LimitOrderParams = {
  fromToken: 'ETH',           // Token to sell
  toToken: 'USDC',            // Token to buy
  fromAmount: '1.0',          // Amount to sell (human-readable)
  limitPrice: 2100,           // Limit price (1 ETH = 2100 USDC)
  chunks: 10,                 // Number of chunks to split order
  fillDelayMinutes: 30,       // Minutes between each chunk
  expiryHours: 24            // Hours until order expires
}

await triggerLimitOrderBotManually(params)
```

### Running Examples

```bash
# Run example 1 (Simple ETH → USDC)
EXAMPLE=1 bun run src/cron-jobs/examples/limitOrderBotExample.ts

# Run example 2 (USDC → ETH)
EXAMPLE=2 bun run src/cron-jobs/examples/limitOrderBotExample.ts

# Run example 3 (Small test order - recommended for first test)
EXAMPLE=3 bun run src/cron-jobs/examples/limitOrderBotExample.ts
```

### Scheduled Execution (Cron)

To enable automatic scheduled execution, edit `limitOrderBot.ts`:

```typescript
export function startLimitOrderBotCron(): void {
  // Run every day at 9 AM UTC
  const cronPattern = '0 9 * * *'

  cron.schedule(cronPattern, async () => {
    const params: LimitOrderParams = {
      fromToken: 'ETH',
      toToken: 'USDC',
      fromAmount: '0.1',
      limitPrice: 2100,
      chunks: 5,
      fillDelayMinutes: 30,
      expiryHours: 24
    }

    await executeLimitOrderBot(params, 'scheduled_limit_order')
  })
}
```

## Parameters Explained

### `LimitOrderParams`

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `fromToken` | `'ETH' \| 'USDC'` | Token to sell | `'ETH'` |
| `toToken` | `'ETH' \| 'USDC'` | Token to buy | `'USDC'` |
| `fromAmount` | `string` | Amount to sell (human-readable, not wei) | `'1.5'` |
| `limitPrice` | `number` | Price in toToken per fromToken | `2100` |
| `chunks` | `number` | Number of chunks to split order | `10` |
| `fillDelayMinutes` | `number` | Minutes between each chunk execution | `30` |
| `expiryHours` | `number` | Hours until order expires | `24` |

### Understanding Limit Price

**For ETH → USDC:**
- `limitPrice: 2100` means "sell ETH when price is 2100 USDC per ETH or better"
- If you set `fromAmount: '1.0'`, you'll receive ~2100 USDC (minus fees)

**For USDC → ETH:**
- `limitPrice: 0.0005` means "buy ETH at price of 0.0005 ETH per USDC"
- This is equivalent to buying ETH at $2000 per ETH (1 / 0.0005 = 2000)
- If you set `fromAmount: '2000'`, you'll receive ~1 ETH (minus fees)

### Understanding Chunks

Chunks split your order into smaller parts executed over time (TWAP - Time-Weighted Average Price):

- **`chunks: 10`** with **`fromAmount: '1.0'`** ETH = 10 orders of 0.1 ETH each
- **`fillDelayMinutes: 30`** means one chunk executes every 30 minutes
- Total execution time = `(chunks - 1) × fillDelayMinutes` = `9 × 30 = 270 minutes (4.5 hours)`

**Benefits:**
- Reduces price impact
- Averages entry/exit price over time
- Protects against sudden price movements

## How It Works

The bot follows the **exact same flow** as your frontend:

### 1. **Calculate Amounts** (like `derivedstate-twap-provider.tsx`)
```typescript
srcAmountWei = toWei(fromAmount, fromToken.decimals)
expectedOutputWei = calculateOutputAmount(fromAmount, limitPrice, ...)
dstMinAmountWei = calculateMinAmountOut(expectedOutputWei, 0.1) // 0.1% slippage
srcChunkAmountWei = calculateChunkAmount(srcAmountWei, chunks)
deadline = calculateDeadline(expiryHours)
```

### 2. **Call Backend API** (like `useTwapTrade` hook)
```typescript
POST /transaction/twap/limit-order/prepare
{
  srcToken, dstToken, srcAmount, dstMinAmount,
  srcChunkAmount, deadline, fillDelay
}
→ Returns: { to: twapContract, data: encodedTx, value: nativeValue }
```

### 3. **Check/Approve Token** (like `ApprovalButton`)
```typescript
if (fromToken !== ETH) {
  currentAllowance = await token.allowance(wallet, twapContract)
  if (currentAllowance < srcAmount) {
    await token.approve(twapContract, MaxUint256)
  }
}
```

### 4. **Sign and Send Transaction** (like `LimitTradeReviewDialog`)
```typescript
const tx = await wallet.sendTransaction({
  to: twapContract,
  data: encodedTx,
  value: nativeValue,
  chainId: 747474
})
await tx.wait()
```

### 5. **Track Activity**
```typescript
// Start execution tracking
POST /tracking/bot/execution/start

// Start wallet tracking
PATCH /tracking/bot/execution/:id/wallet/:index/start

// Log limit order
POST /tracking/bot/limit-order/placed

// Complete wallet tracking
PATCH /tracking/bot/execution/:id/wallet/:index/complete
```

## Tracking & Monitoring

All bot activities are logged to your database via the tracking API:

### Check Execution Status
```bash
GET /tracking/bot/execution/:executionId
```

### View All Executions
```bash
GET /tracking/bot/executions?limit=50
```

### View Limit Orders
```bash
GET /tracking/bot/limit-orders/:executionId
```

### Update Order Status (when filled)
```bash
PATCH /tracking/bot/limit-order/:orderId/filled
{
  "filled_src_amount": "1000000000000000000",
  "filled_dst_amount": "2100000000",
  "progress": 100,
  "usd_volume": 2100,
  "status": "filled"
}
```

## Example Use Cases

### 1. **DCA (Dollar Cost Averaging)**
Buy ETH gradually with fixed USDC amounts:
```typescript
{
  fromToken: 'USDC',
  toToken: 'ETH',
  fromAmount: '10000',      // $10k USDC
  limitPrice: 0.0005,       // At $2000/ETH
  chunks: 20,               // $500 chunks
  fillDelayMinutes: 60,     // Every hour
  expiryHours: 24          // Complete in 1 day
}
```

### 2. **Take Profit**
Sell ETH gradually when price reaches target:
```typescript
{
  fromToken: 'ETH',
  toToken: 'USDC',
  fromAmount: '5.0',        // 5 ETH
  limitPrice: 2200,         // Sell at $2200
  chunks: 10,               // 0.5 ETH chunks
  fillDelayMinutes: 120,    // Every 2 hours
  expiryHours: 168         // 1 week to execute
}
```

### 3. **Buy the Dip**
Buy ETH if price drops to specific level:
```typescript
{
  fromToken: 'USDC',
  toToken: 'ETH',
  fromAmount: '5000',       // $5k USDC
  limitPrice: 0.000556,     // Buy at $1800/ETH
  chunks: 5,                // $1k chunks
  fillDelayMinutes: 30,     // Every 30 min
  expiryHours: 48          // 2 days
}
```

## Price Calculation Helper

To calculate `limitPrice` for USDC → ETH orders:

```typescript
// If you want to buy ETH at $2000 per ETH:
limitPrice = 1 / 2000 = 0.0005

// If you want to buy ETH at $1800 per ETH:
limitPrice = 1 / 1800 = 0.000556

// General formula:
limitPrice = 1 / desiredETHPriceInUSDC
```

## Testing Checklist

Before running with real funds:

- [ ] Set up wallet private keys in `.env`
- [ ] Verify `KATANA_RPC_URL` is correct
- [ ] Verify `BACKEND_URL` points to your backend
- [ ] Test with **small amounts** first (Example 3)
- [ ] Check wallet has sufficient balance
- [ ] Check wallet has sufficient RON for gas fees
- [ ] Verify backend transaction API is working
- [ ] Verify tracking API is recording activities
- [ ] Monitor first execution in database

## Troubleshooting

### Error: "No bot wallets configured"
**Solution:** Add `WALLET_1=0x...` to your `.env` file

### Error: "Insufficient balance"
**Solution:** Fund the wallet with the required token amount

### Error: "Failed to prepare limit order transaction"
**Solution:**
- Check backend is running and accessible
- Verify `BACKEND_URL` is correct
- Check backend logs for errors

### Error: "Transaction failed"
**Solution:**
- Check wallet has enough RON for gas
- Verify token addresses are correct
- Check Katana RPC is responding

### Orders not executing
**Solution:**
- Orders execute when market price reaches limit price
- Check order status in your database
- Use dashboard to monitor TWAP order progress

## Security Best Practices

1. **Never commit private keys** - Use `.env` and `.gitignore`
2. **Use dedicated bot wallets** - Don't use your main wallets
3. **Start with small amounts** - Test thoroughly before scaling
4. **Monitor regularly** - Check bot execution logs
5. **Set reasonable limits** - Use `expiryHours` to prevent stale orders
6. **Secure your server** - If running cron, ensure server is secure

## Adding More Tokens

To add support for more tokens (e.g., WBTC, LBTC), edit `limitOrderBot.ts`:

```typescript
const TOKENS = {
  ETH: { address: '0xeeee...', decimals: 18, symbol: 'ETH' },
  USDC: { address: '0x203A...', decimals: 6, symbol: 'USDC' },
  WBTC: { address: '0x...', decimals: 8, symbol: 'WBTC' },  // Add here
  // Add more tokens...
} as const

// Update type
type TokenSymbol = 'ETH' | 'USDC' | 'WBTC'
```

## Support

For issues or questions:
1. Check backend logs: `src/controllers/transaction/twap/index.ts`
2. Check tracking logs: `src/controllers/tracking/botLimitOrder.ts`
3. Review execution history: `GET /tracking/bot/executions`
4. Check order status: `GET /tracking/bot/limit-orders/:executionId`

## License

Same as parent project.