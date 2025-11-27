# Limit Order Bot - Quick Setup Guide

## Overview

Your limit order bot is configured to:
- **Wallet 1**: Buy ETH with $25 USDC at **1% below market price**
- **Wallet 2**: Sell ETH for USDC worth $25 at **1% above market price**

Both orders split into **5 chunks** executed every **10 minutes**, expiring in **24 hours**.

## Prerequisites

✅ You've already added `WALLET_1` and `WALLET_2` to your `.env` file

Make sure your `.env` looks like this:

```bash
# Bot Wallets
WALLET_1=0x1234567890abcdef...  # Your first wallet private key
WALLET_2=0xabcdef1234567890...  # Your second wallet private key

# Other required variables
KATANA_RPC_URL=https://rpc.katana.network
MONGO_URI=mongodb://...
# ... other config
```

## Running the Bot

### Option 1: Run Once Immediately

```bash
npm run bot:limit-order
```

or with Bun:

```bash
bun run bot:limit-order
```

This will:
1. Check current ETH price
2. Calculate 1% below (buy) and 1% above (sell) prices
3. Create limit orders for both wallets
4. Exit after completion

### Option 2: Run as Cron Job (Auto-scheduled)

Add this to your `src/index.ts`:

```typescript
import { initializeCronJobs } from './cron-jobs/index'

async function bootstrap() {
  // ... existing code ...

  // Start cron jobs
  initializeCronJobs() // <-- Add this line
}
```

This will run the bot **every hour** automatically when your server starts.

### Option 3: Custom Schedule

Edit `src/cron-jobs/startLimitOrderBot.ts` and change the cron pattern:

```typescript
// Current: Every hour
const cronPattern = '0 * * * *'

// Examples:
// Every 30 minutes: '*/30 * * * *'
// Every day at 9 AM: '0 9 * * *'
// Every 6 hours: '0 */6 * * *'
```

## What Happens When You Run It

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                      LIMIT ORDER BOT STARTED                                 ║
╚══════════════════════════════════════════════════════════════════════════════╝

[Price] Current ETH price: $2000

[Order Calculation]
  Current ETH Price: $2000
  Buy Price (1% below): $1980.00
  Sell Price (1% above): $2020.00
  ETH Amount: 0.012500 ETH
  USDC Amount: 25.00 USDC

================================================================================
WALLET 1: BUY ETH WITH USDC (1% below market)
================================================================================

[Buy Order Parameters]
  From: 25.00 USDC
  To: ~0.012626 ETH
  Limit Price: $1980.00 per ETH
  Chunks: 5
  Fill Delay: 10 minutes
  Expires: 24 hours

[Setup] Initializing provider and wallets...
[Bot Wallet Manager] Loaded wallet 1: 0xYourWallet1Address
[Bot Wallet Manager] Loaded wallet 2: 0xYourWallet2Address
[Bot Wallet Manager] Loaded 2 bot wallets

[Tracking] Starting execution tracking for 2 wallets...

================================================================================
[Limit Order Bot] Wallet 1 (0xYourWallet1Address)
================================================================================

[Trade] USDC → ETH
[Amount] 25.00 USDC
[Limit Price] 1 USDC = 0.000505 ETH

[Calculations] Computing trade amounts...
  Source amount: 25000000 wei (25.00 USDC)
  Expected output: 12626262626262 wei (0.012626 ETH)
  Min output (0.1% slippage): 12613636363636 wei (0.012613 ETH)
  Chunk amount: 5000000 wei (5.00 USDC)
  Total chunks: 5
  Deadline: 2025-11-29T12:00:00.000Z (24h from now)

[Balance] Checking wallet balance...
  Balance: 100.00 USDC

[API] Calling backend to prepare limit order...
  TWAP Contract: 0xTwapContractAddress
  Transaction data: 1234 bytes

[Approval] Checking USDC approval...
  ✓ Approval granted: 0xApprovalTxHash

[Transaction] Signing and sending limit order...
  ✓ Transaction sent: 0xLimitOrderTxHash
  ⏳ Waiting for confirmation...

================================================================================
✅ LIMIT ORDER CREATED SUCCESSFULLY
================================================================================
  Block: 12345678
  Gas used: 150000
  Tx hash: 0xLimitOrderTxHash
================================================================================

[Tracking] Order logged to tracking API

... (same process for Wallet 2 selling ETH) ...

╔══════════════════════════════════════════════════════════════════════════════╗
║                        ALL ORDERS COMPLETED                                  ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

## Monitoring Orders

### Check Execution Status

```bash
GET /tracking/bot/executions
```

Returns:
```json
{
  "executions": [
    {
      "execution_id": "exec_1234567890_123",
      "strategy_name": "manual_limit_order",
      "total_wallets": 2,
      "completed_wallets": 2,
      "failed_wallets": 0,
      "total_volume_usd": 50,
      "status": "completed",
      "start_time": "2025-11-28T12:00:00.000Z",
      "end_time": "2025-11-28T12:01:30.000Z"
    }
  ]
}
```

### Check Limit Orders

```bash
GET /tracking/bot/limit-orders/{execution_id}
```

Returns:
```json
{
  "execution_id": "exec_1234567890_123",
  "orders": [
    {
      "wallet_index": 1,
      "wallet_address": "0x...",
      "order_id": "0xTxHash1",
      "tx_hash": "0xTxHash1",
      "src_token_symbol": "USDC",
      "dst_token_symbol": "ETH",
      "src_amount": "25000000",
      "status": "pending",
      "progress": 0,
      "placed_at": "2025-11-28T12:00:00.000Z"
    },
    {
      "wallet_index": 2,
      "wallet_address": "0x...",
      "order_id": "0xTxHash2",
      "tx_hash": "0xTxHash2",
      "src_token_symbol": "ETH",
      "dst_token_symbol": "USDC",
      "src_amount": "12500000000000000",
      "status": "pending",
      "progress": 0,
      "placed_at": "2025-11-28T12:00:30.000Z"
    }
  ],
  "summary": {
    "total": 2,
    "pending": 2,
    "partial": 0,
    "filled": 0,
    "canceled": 0,
    "expired": 0,
    "total_volume_usd": 0
  }
}
```

## Important Notes

### ⚠️ Update Price Fetching

Currently using mock price of $2000. Update in `src/cron-jobs/startLimitOrderBot.ts:18`:

```typescript
async function getCurrentETHPrice(): Promise<number> {
  // TODO: Replace with your actual price API
  const response = await fetch('https://your-price-api.com/eth')
  const data = await response.json()
  return data.price
}
```

### ⚠️ Check Wallet Balances

Make sure:
- **Wallet 1** has at least **25 USDC** + gas (RON)
- **Wallet 2** has at least **0.0125 ETH** + gas (RON)

### ⚠️ Gas Fees

Each wallet needs RON for gas fees on Katana:
- Approval transaction (if needed): ~50,000 gas
- Limit order transaction: ~150,000 gas

Make sure each wallet has at least **0.01 RON** for gas.

## Customization

### Change Order Amount

Edit `src/cron-jobs/startLimitOrderBot.ts`:

```typescript
// Change from $25 to $50
const params = await calculateOrderParams(50) // <-- Change here
```

### Change Price Offset

```typescript
// Current: 1% below/above
const buyPrice = currentPrice * 0.99  // 1% below
const sellPrice = currentPrice * 1.01 // 1% above

// Example: 2% below/above
const buyPrice = currentPrice * 0.98  // 2% below
const sellPrice = currentPrice * 1.02 // 2% above
```

### Change Chunks & Fill Delay

```typescript
// Current settings
chunks: 5,              // Split into 5 chunks
fillDelayMinutes: 10,   // Execute every 10 minutes

// Example: More frequent execution
chunks: 10,             // Split into 10 chunks
fillDelayMinutes: 5,    // Execute every 5 minutes
```

### Change Expiry Time

```typescript
// Current: 24 hours
expiryHours: 24

// Example: 48 hours
expiryHours: 48
```

## Troubleshooting

### "No bot wallets configured"
- Make sure `WALLET_1` and `WALLET_2` are in your `.env` file
- Restart your application after adding them

### "Insufficient balance"
- Check wallet balances on Katana blockchain
- Make sure you have enough tokens + RON for gas

### "Transaction failed"
- Check you have RON for gas fees
- Verify RPC URL is correct: `https://rpc.katana.network`
- Check token addresses are correct

### Orders not executing
- Orders execute when market price reaches your limit price
- Check order status via tracking API
- Use SushiSwap dashboard to monitor TWAP orders

## Security

🔒 **Never commit your `.env` file to git!**

Make sure `.env` is in your `.gitignore`:

```
.env
.env.local
.env.*.local
```

## Files Created

```
src/
├── cron-jobs/
│   ├── limitOrderBot.ts           # Main bot logic
│   ├── startLimitOrderBot.ts      # Your configuration (buy/sell)
│   ├── index.ts                   # Cron jobs orchestrator
│   ├── utils/
│   │   ├── botWalletManager.ts    # Wallet loading & management
│   │   └── botHelpers.ts          # Helper functions
│   └── examples/
│       └── limitOrderBotExample.ts # Example configurations
└── scripts/
    └── runLimitOrderBot.ts        # CLI runner

LIMIT_ORDER_BOT_SETUP.md           # This file
```

## Support

For issues:
1. Check logs for error messages
2. Verify wallet balances and gas
3. Check tracking API for order status
4. Review transaction hashes on Katana explorer

Happy trading! 🚀