# Grid Bot

Automated grid trading bot for ETH/USDC on Katana (Ronin chain).

## Overview

The grid bot places a series of buy and sell limit orders at different price levels (grid), and automatically places counter-orders when orders are filled to capture profits from price oscillations.

### Strategy

1. **Initial Grid Placement**: Places 3 buy orders below market price and 3 sell orders above market price
   - Buy orders: -1%, -2%, -3% from current price
   - Sell orders: +1%, +2%, +3% from current price
   - Each order uses 20% of available balance

2. **Monitoring**: Polls order status every 2-3 minutes to detect filled orders

3. **Counter-Order Placement**: When an order fills, automatically places a counter-order:
   - Buy order fills → Place sell order at +1% from execution price
   - Sell order fills → Place buy order at -1% from execution price

## Configuration

### Environment Variables

```bash
# Grid Bot Testing Mode (set to 'true' to enable simulation)
GRID_BOT_TESTING_MODE=true

# Bot Wallets (WALLET_1 through WALLET_10)
WALLET_1=<private_key>
WALLET_2=<private_key>
# ... up to WALLET_10
```

### Grid Configuration

Edit `gridManager.ts` to modify grid parameters:

```typescript
const GRID_CONFIG: GridConfig = {
  BUY_OFFSETS: [-1, -2, -3],    // % below market
  SELL_OFFSETS: [1, 2, 3],       // % above market
  ORDER_SIZE_PERCENT: 20,        // 20% of balance per order
  MIN_ORDER_VALUE_USD: 6,        // $6 minimum order value
  EXPIRY_HOURS: 24,              // Order expiry (24 hours)
  FILL_DELAY_MINUTES: 3,         // Fill delay between chunks
  TESTING_MODE: process.env.GRID_BOT_TESTING_MODE === 'true'
}
```

## Testing Mode

### What is Testing Mode?

Testing mode allows you to run the complete grid bot flow **without sending any transactions to the blockchain**. This is essential for:

- Testing bot logic and counter-order placement
- Verifying database operations
- Debugging order flows
- Development and QA

### How It Works

When `GRID_BOT_TESTING_MODE=true`:

1. **Order Placement** (`orderExecutor.ts`):
   - ✅ Validates balances (still checks actual wallet balances)
   - ✅ Calculates order amounts and prices
   - ❌ **Skips blockchain transactions** (no approval, no order submission)
   - ✅ Generates mock transaction hashes and order IDs
   - ✅ Saves orders to database with mock data
   - 📝 Logs: `[TEST MODE] Simulating order placement - NO BLOCKCHAIN TRANSACTION`

2. **Order Monitoring** (`orderStatusPoller.ts`):
   - ❌ **Skips blockchain polling** (doesn't query TWAP contract)
   - ✅ Fetches pending orders from database
   - ✅ **Auto-marks all pending orders as 100% filled**
   - ✅ Updates database with filled status
   - ✅ Returns filled orders to trigger counter-order flow
   - 📝 Logs: `[TEST MODE] Auto-marking N pending orders as filled`

3. **Counter-Order Placement** (`counterOrderManager.ts`):
   - ✅ Calculates execution prices from filled amounts
   - ✅ Determines counter-order direction and price (+1% or -1%)
   - ✅ Places counter-orders (also in test mode, no blockchain)
   - ✅ Full counter-order flow can be tested

### Enabling Testing Mode

**Option 1: Environment Variable**
```bash
# In .env file
GRID_BOT_TESTING_MODE=true
```

**Option 2: Temporary Override**
```bash
GRID_BOT_TESTING_MODE=true bun run index.ts
```

### Disabling Testing Mode (Production)

```bash
# In .env file
GRID_BOT_TESTING_MODE=false
# Or remove the line entirely (defaults to false)
```

### Testing Mode Logs

When testing mode is enabled, you'll see:

```
[GridBotOrchestrator] ╔══════════════════════════════════════════════════════╗
[GridBotOrchestrator] ║          🧪 TESTING MODE ENABLED 🧪                  ║
[GridBotOrchestrator] ║  Orders will NOT be sent to blockchain              ║
[GridBotOrchestrator] ║  All orders will be auto-marked as filled           ║
[GridBotOrchestrator] ║  Set GRID_BOT_TESTING_MODE=false to disable         ║
[GridBotOrchestrator] ╚══════════════════════════════════════════════════════╝

[OrderExecutor] [TEST MODE] Placing grid_buy order: 100 USDC → ETH @ $2970
[OrderExecutor] [TEST MODE] Simulating order placement - NO BLOCKCHAIN TRANSACTION
[OrderExecutor] [TEST MODE] Mock transaction: 0xtest1701234567abc123
[OrderExecutor] [TEST MODE] Mock block: 1234567
[OrderExecutor] [TEST MODE] Mock blockchain order ID: 54321

[OrderStatusPoller] [TEST MODE] [Wallet 1] Auto-marking 6 pending orders as filled
[OrderStatusPoller] [TEST MODE] [Wallet 1] Marking order order_1701234567_abc123 as filled (100%)
[OrderStatusPoller] [TEST MODE] [Wallet 1] Poll complete: 6 orders marked as filled

[CounterOrderManager] [Wallet 1] Processing 6 filled orders for counter-order placement
[CounterOrderManager] [Wallet 1] Execution price: $2970.00 per ETH
[CounterOrderManager] [Wallet 1] Counter-order price: $2999.70 (+1%)
[OrderExecutor] [TEST MODE] Placing counter_sell order: 0.5 ETH → USDC @ $2999.70
```

### Database Behavior in Testing Mode

**Orders are still saved to the database** with:
- Mock transaction hashes (prefixed with `0xtest`)
- Mock blockchain order IDs
- Real order amounts and prices
- Real status transitions (pending → filled)

This allows you to:
- Verify database schema and operations
- Test order lifecycle tracking
- Inspect order history
- Debug counter-order logic

### What Testing Mode Does NOT Test

- ❌ Actual token approvals
- ❌ Real blockchain transaction submission
- ❌ Gas estimation and fees
- ❌ TWAP contract interactions
- ❌ Network latency and RPC issues
- ❌ Actual token balance changes

### Best Practices

1. **Always test new logic in testing mode first** before production
2. **Check database records** after test runs to verify data integrity
3. **Monitor logs** to understand the full order flow
4. **Test edge cases** like insufficient balances, errors, etc.
5. **Remember to disable testing mode** before production deployment

## Architecture

### Core Components

- **gridBotOrchestrator.ts**: Initializes wallets and starts monitoring
- **gridManager.ts**: Places initial 6-order grid
- **orderExecutor.ts**: Executes limit orders via TWAP contract
- **orderStatusPoller.ts**: Polls blockchain for order status updates
- **counterOrderManager.ts**: Places counter-orders when orders fill
- **walletMonitor.ts**: Main monitoring loop for each wallet
- **databaseSync.ts**: Syncs order data to MySQL (BotLimitOrder + SushiActivity)

### Database Models

- **BotExecution**: Tracks overall bot execution
- **BotWalletExecution**: Tracks per-wallet execution
- **BotLimitOrder**: Stores limit order details
- **SushiActivity**: Records swap/order activity for analytics

## Running the Bot

```bash
# Development
bun run index.ts

# The bot will automatically start if wallets are configured
# Monitor logs for order placements and fills
```

## Safety Features

- Minimum order value: $6 USD
- Balance validation before each order
- Exponential backoff on errors
- Staggered wallet starts (10 seconds)
- Comprehensive error logging
- Graceful error handling (continues with other wallets)

## Monitoring

The bot logs extensively to help you monitor its operation:

- `[GridManager]` - Grid placement
- `[OrderExecutor]` - Order execution
- `[OrderStatusPoller]` - Status polling
- `[CounterOrderManager]` - Counter-order placement
- `[WalletMonitor]` - Wallet monitoring loop

## Troubleshooting

### No orders being placed
- Check wallet balances meet minimum ($6 per order)
- Verify wallets are funded with both ETH and USDC
- Check RPC connectivity
- Review logs for error messages

### Orders not filling (production mode)
- Verify orders are visible on Katana explorer
- Check order prices are realistic
- Ensure sufficient liquidity in pools
- Confirm orders haven't expired (24h default)

### Testing mode not working
- Verify `GRID_BOT_TESTING_MODE=true` in .env
- Check startup logs for testing mode banner
- Look for `[TEST MODE]` prefixes in logs
- Restart the application after .env changes

## Development

### Adding New Features

1. Test logic in testing mode first
2. Add comprehensive logging
3. Handle errors gracefully
4. Update database schemas if needed
5. Document configuration changes

### Modifying Grid Parameters

Edit `GRID_CONFIG` in `gridManager.ts`:
- Adjust buy/sell offsets for wider/tighter grids
- Change order size percentage
- Modify minimum order values
- Update expiry times

## License

Internal use only.
