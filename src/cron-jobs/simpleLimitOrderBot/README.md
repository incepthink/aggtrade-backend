# Simple Limit Order Bot

A sophisticated grid trading bot that runs every 4 hours to manage limit orders across multiple wallets with automatic balance tracking and counter-order execution.

## 📋 Overview

This bot uses a **2-table design** for simplicity:
- `BotWallet` - Wallet management and balance tracking
- `BotOrdersSimple` - Order tracking

## 🔄 How It Works

### Every 4 Hours:
1. Load all wallets from `BotWallet` table
2. For each wallet:
   - **Sync wallet balances** from blockchain to database
   - **If `placed_initial_orders < 5`**: Place remaining buy-sell order pairs
   - **If `placed_initial_orders = 5`**: Check order status and place counter-orders

### Initial Order Placement

**Atomic Pair Guarantee:**
- Each sell order MUST have a corresponding buy order
- Both orders are constructed and validated BEFORE sending to blockchain
- If either fails validation, neither is placed
- Only after BOTH succeed is `placed_initial_orders` incremented

**Grid Strategy:**
- 5 buy orders at: -1%, -1.5%, -2%, -2.5%, -3% below market
- 5 sell orders at: +1%, +1.5%, +2%, +2.5%, +3% above market

**Dynamic Order Sizing:**
- Order size = (wallet token balance / 5) in USD value
- Minimum order size: $6 USD (enforced to meet exchange minimums)
- Example: $40 USDC balance → 5 buy orders of $8 USDC each
- Example: $25 ETH balance → 5 sell orders of $5 ETH each → adjusted to $6 minimum

### Order Status Checking & Counter Orders

**Status Polling:**
- Fetches all pending/partial orders from database
- Polls blockchain via TWAP SDK for current status
- Updates order status: pending → partial → filled/expired/canceled
- Tracks progress percentage (0-100%)

**Counter Order Logic:**
When a grid order is filled:
1. **Record Activity**: Add to `SushiswapActivity` table (treated as normal user trade)
2. **Calculate Profit Price**:
   - If parent was BUY → Place SELL at +1% from execution price
   - If parent was SELL → Place BUY at -1% from execution price
3. **Size Matching**: Counter order uses the filled amount from parent
4. **Duplicate Prevention**: Checks if counter order already exists before placing

**Balance Tracking:**
- Balances synced from blockchain at start of each wallet processing
- Balances updated after each order placement
- Balances updated after counter-order placement
- Stored in `BotWallet` table columns: `usdc`, `eth`, `sushi`

## 🗂️ File Structure

```
simpleLimitOrderBot/
├── index.ts                  # Main cron job + wallet processing
├── placeInitialOrders.ts     # Initial grid order placement
├── checkCounterOrders.ts     # Order status checking + counter-order placement
└── README.md                 # This file
```

## 📦 Dependencies

**Services:**
- `TwapService` (src/services/twap): TWAP SDK for limit orders
- `getCurrentTokenPrice` (src/cron-jobs/gridBot/priceManager): Token price fetching
- `getToken` (src/cron-jobs/gridBot/tokenPairs.config): Token configuration

**Utils:**
- `botHelpers`: toWei, fromWei, calculateOutputAmount, calculateMinAmountOut, calculateDeadline
- `botWalletManager`: getTokenBalance, ensureTokenApproval
- `botBalanceUpdater`: updateWalletBalances, TOKEN_COLUMN_MAPPING

**Models:**
- `BotWallet`: Wallet management
- `BotOrdersSimple`: Order tracking
- `SushiswapActivity`: Trade activity logging
- `User`: User management

## 🚀 Usage

### 1. Setup Environment Variables

Add wallet private keys to your `.env` file:

```bash
# Wallet private keys
WALLET_1=0x...
WALLET_2=0x...
# ... up to WALLET_100

# Test mode (optional)
BOT_TEST_MODE=false  # Set to 'true' to enable test mode
```

### 2. Add Wallets to Database

```sql
INSERT INTO bot_wallets (wallet_address, wallet_index, trading_pool, usdc, eth, sushi, placed_initial_orders)
VALUES
('0xYourWalletAddress', 1, 'ETH/USDC', '0', '0', '0', 0);
```

### 3. Start the Bot

In your main `cron-jobs/index.ts`:

```typescript
import { startSimpleLimitOrderBotCron } from './simpleLimitOrderBot'

// Start the bot
startSimpleLimitOrderBotCron()
```

Or run manually:

```typescript
import { runSimpleLimitOrderBot } from './simpleLimitOrderBot'

// Run once
await runSimpleLimitOrderBot()
```

## 📊 Database Schema

### BotWallet
- `wallet_address` - Wallet address
- `wallet_index` - Index (1-100)
- `trading_pool` - Trading pair (e.g., "ETH/USDC")
- `usdc` - USDC balance
- `eth` - ETH balance
- `sushi` - SUSHI balance
- `placed_initial_orders` - Number of pairs placed (0-5)

### BotOrdersSimple
- `wallet_address` - Owner wallet
- `blockchain_order_id` - Blockchain order ID
- `order_type` - 'grid_buy', 'grid_sell', 'counter_buy', 'counter_sell'
- `parent_order_id` - Parent order (for counter-orders)
- `from_token` - Token being sold
- `to_token` - Token being bought
- `from_amount` - Amount selling
- `to_amount` - Amount expecting
- `status` - 'pending', 'partial', 'filled', 'expired', 'canceled'
- `progress` - Fill percentage (0-100)
- `placed_at` - Order creation time
- `filled_at` - Order completion time
- `last_checked_at` - Last status check
- `usd_value` - Approximate USD value

## 🔧 Configuration

### Initial Order Configuration (placeInitialOrders.ts)

```typescript
const GRID_CONFIG = {
  BUY_OFFSETS: [-1, -1.5, -2, -2.5, -3],  // % below market
  SELL_OFFSETS: [1, 1.5, 2, 2.5, 3],       // % above market
  MIN_ORDER_SIZE_USD: 6,                    // Minimum $6 per order
  EXPIRY_HOURS: 168                         // 1 week (168 hours)
}
```

### Counter Order Configuration (checkCounterOrders.ts)

```typescript
const COUNTER_ORDER_CONFIG = {
  PROFIT_MARGIN_PERCENT: 1, // ±1% from execution price
  MIN_ORDER_SIZE_USD: 6,     // Minimum $6 per order
  EXPIRY_HOURS: 168,         // 1 week
  CHAIN_ID: 747474           // Katana chain ID
}
```

### Cron Job Configuration (index.ts)

```typescript
const CRON_INTERVAL_HOURS = 4  // Run every 4 hours
const RPC_URL = 'https://rpc.katana.network' // Katana blockchain RPC

// Test mode configuration
const TEST_MODE_CONFIG = {
  enabled: process.env.BOT_TEST_MODE === 'true',
  intervalSeconds: 10, // Run every 10 seconds in test mode
  simulatedOrders: new Map<string, any[]>() // In-memory order store
}
```

## 🧪 Test Mode

Test mode allows you to run the bot without placing real orders on the blockchain. This is useful for:
- Testing bot logic and flow
- Verifying database operations
- Debugging issues without spending gas
- Rapid iteration (runs every 10 seconds instead of 4 hours)

### How to Enable Test Mode

Set the environment variable in your `.env` file:

```bash
BOT_TEST_MODE=true
```

### Test Mode Behavior

**Execution Timing:**
- **Production**: Runs every 4 hours
- **Test Mode**: Runs every 10 seconds (back-to-back execution)

**Order Placement:**
- **Production**: Orders are sent to blockchain via TWAP SDK
- **Test Mode**: Orders are simulated (not sent to blockchain)
  - Generates test order IDs with `TEST_` prefix
  - Generates test transaction hashes with `0xTEST` prefix
  - Saves orders to database with simulated IDs
  - Updates wallet balances (if balance tracking is enabled)

**Order Status Checking:**
- **Production**: Polls blockchain via TWAP SDK for real order status
- **Test Mode**: Simulates order fills with 30% probability per cycle
  - Each pending order has 30% chance to be marked as "filled"
  - Simulates filled amounts matching the original order
  - Triggers counter-order placement flow

**Counter Order Placement:**
- **Production**: Places real counter-orders on blockchain
- **Test Mode**: Simulates counter-orders with `TEST_COUNTER_` prefix
  - Calculates correct profit margins (±1%)
  - Saves to database
  - Does not interact with blockchain

**What Still Happens in Test Mode:**
- ✅ Database operations (orders saved to `bot_orders_simple`)
- ✅ Balance tracking (synced from blockchain)
- ✅ Activity logging (added to `sushiswap_activities`)
- ✅ Price fetching (real market prices)
- ✅ Logging and monitoring
- ❌ Blockchain transactions (orders are NOT placed)
- ❌ Token approvals (skipped)
- ❌ Gas costs (zero cost)

### Test Mode Logging

All test mode actions are clearly marked with `[TEST MODE]` prefix:

```
[SimpleLimitOrderBot] ⚠️  Starting Simple Limit Order Bot in TEST MODE
[SimpleLimitOrderBot] ⚠️  Test mode interval: Every 10 seconds (back-to-back execution)
[PlaceInitialOrders] [TEST MODE] Simulating grid_buy execution...
[PlaceInitialOrders] [TEST MODE] Simulated transaction: 0xTEST1a2b3c4d5e
[PlaceInitialOrders] [TEST MODE] Simulated order ID: TEST_1234567890_abc123
[CheckCounterOrders] [Wallet 1] [TEST MODE] Simulating order status updates...
[CheckCounterOrders] [Wallet 1] [TEST MODE] Simulated fill: grid_buy order 123
[CheckCounterOrders] [Wallet 1] [TEST MODE] Simulating counter-order placement...
```

### Testing Workflow

1. **Start bot in test mode:**
   ```bash
   BOT_TEST_MODE=true bun run index.ts
   ```

2. **Watch rapid cycles (every 10 seconds):**
   - Initial orders placed (simulated)
   - Order status checked (30% fill probability)
   - Counter orders placed when fills detected

3. **Verify database operations:**
   ```sql
   -- Check simulated orders
   SELECT * FROM bot_orders_simple
   WHERE blockchain_order_id LIKE 'TEST_%'
   ORDER BY placed_at DESC;

   -- Check counter-order chains
   SELECT parent.id, parent.order_type, child.order_type
   FROM bot_orders_simple parent
   LEFT JOIN bot_orders_simple child ON child.parent_order_id = parent.id
   WHERE parent.blockchain_order_id LIKE 'TEST_%';
   ```

4. **Switch to production when ready:**
   ```bash
   BOT_TEST_MODE=false bun run index.ts
   ```

### Cleaning Up Test Data

After testing, you may want to remove test orders:

```sql
-- Remove all test orders
DELETE FROM bot_orders_simple
WHERE blockchain_order_id LIKE 'TEST_%';

-- Reset wallet counters if needed
UPDATE bot_wallets
SET placed_initial_orders = 0
WHERE wallet_address = '0x...';
```

## 📝 Logging

All actions are logged with the `KatanaLogger`:

**Initial Order Placement:**
```
[SimpleLimitOrderBot] Starting cycle...
[PlaceInitialOrders] Placing pair 1/5...
[PlaceInitialOrders] [0/4] Fetching wallet balances...
[PlaceInitialOrders] Wallet balances: 40.0 USDC, 0.015 WRON
[PlaceInitialOrders] [1/4] Constructing BUY order...
[PlaceInitialOrders] ✅ Order constructed successfully
[PlaceInitialOrders] [2/4] Constructing SELL order...
[PlaceInitialOrders] ✅ Order constructed successfully
[PlaceInitialOrders] [3/4] Executing BUY order...
[PlaceInitialOrders] Transaction sent: 0x...
[PlaceInitialOrders] [4/4] Executing SELL order...
[PlaceInitialOrders] ✅ Pair 1/5 placed successfully!
```

**Counter Order Processing:**
```
[CheckCounterOrders] [Wallet 1] Polling order status...
[CheckCounterOrders] [Wallet 1] Found 10 active orders
[CheckCounterOrders] [Wallet 1] Status change detected: grid_buy pending(0%) -> filled(100%)
[CheckCounterOrders] [Wallet 1] Order 123 is filled! Processing...
[CheckCounterOrders] [Wallet 1] Adding order 123 to SushiswapActivity...
[CheckCounterOrders] [Wallet 1] Execution price: $2450.123456 per WRON
[CheckCounterOrders] [Wallet 1] Counter-order target price: $2474.624691 (+1%)
[CheckCounterOrders] [Wallet 1] Placing counter_sell: 0.008 WRON → USDC @ limitPrice=2474.62
[CheckCounterOrders] [Wallet 1] ✅ Counter-order placed successfully for parent order 123
```

## 🐛 Debugging

### Check wallet status:
```sql
SELECT wallet_index, wallet_address, placed_initial_orders, trading_pool, usdc, eth, sushi
FROM bot_wallets
ORDER BY wallet_index;
```

### Check orders for a wallet:
```sql
SELECT id, order_type, from_token, to_token, from_amount, to_amount,
       status, progress, usd_value, parent_order_id, placed_at, filled_at
FROM bot_orders_simple
WHERE wallet_address = '0x...'
ORDER BY placed_at DESC;
```

### Find counter-order chains:
```sql
-- View parent → child relationships
SELECT
  parent.id as parent_id,
  parent.order_type as parent_type,
  parent.status as parent_status,
  child.id as counter_id,
  child.order_type as counter_type,
  child.status as counter_status
FROM bot_orders_simple parent
LEFT JOIN bot_orders_simple child ON child.parent_order_id = parent.id
WHERE parent.parent_order_id IS NULL
ORDER BY parent.placed_at DESC;
```

### Find orders needing attention:
```sql
-- Pending orders
SELECT * FROM bot_orders_simple WHERE status = 'pending';

-- Orders not checked recently
SELECT * FROM bot_orders_simple
WHERE status IN ('pending', 'partial')
AND (last_checked_at < NOW() - INTERVAL 5 HOUR OR last_checked_at IS NULL);

-- Filled orders without counter orders
SELECT parent.*
FROM bot_orders_simple parent
LEFT JOIN bot_orders_simple child ON child.parent_order_id = parent.id
WHERE parent.status = 'filled'
  AND parent.parent_order_id IS NULL  -- is a grid order, not a counter order
  AND child.id IS NULL;  -- no counter order exists
```

### Check SushiswapActivity integration:
```sql
-- View bot trades recorded as user activity
SELECT * FROM sushiswap_activities
WHERE metadata->>'$.bot_order_id' IS NOT NULL
ORDER BY timestamp DESC;
```

## 🎯 Features Status

1. ✅ Initial order placement (DONE)
2. ✅ Order status checking (DONE)
3. ✅ Counter-order placement (DONE)
4. ✅ Balance updates (DONE)
5. ✅ SushiswapActivity integration (DONE)
6. ✅ Atomic pair placement with validation (DONE)
7. ✅ Dynamic order sizing based on wallet balance (DONE)
8. ✅ Duplicate counter-order prevention (DONE)

## 🔐 Security Notes

- Private keys are loaded from environment variables only
- Never log private keys
- Wallet address is validated against database before processing
- All transactions require explicit approval

## 📞 Support

Check logs for detailed execution information. Each wallet is processed independently,
so one failing wallet won't affect others.
