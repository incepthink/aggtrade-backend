# Simple Limit Order Bot

A modular, scalable grid trading bot that manages limit orders across multiple wallets with automatic balance tracking and counter-order execution.

## Architecture Overview

The bot uses a **clean, modular service-based architecture** for easy debugging, testing, and scaling:

```
simpleLimitOrderBot/
├── index.ts                      # Main orchestrator
├── placeInitialOrders.ts         # Initial order placement flow
├── checkCounterOrders.ts         # Counter-order placement flow
├── config.ts                     # All configuration constants
├── services/                     # Modular service layer
│   ├── BalanceService.ts         # Balance operations
│   ├── OrderConstructionService.ts  # Order building & validation
│   ├── OrderExecutionService.ts  # Blockchain execution & DB persistence
│   ├── OrderStatusService.ts     # Order status polling
│   ├── CounterOrderService.ts    # Counter-order logic
│   └── WalletService.ts          # Wallet management
└── README.md                     # This file
```

## Service Layer

### BalanceService
**Purpose**: Manage wallet balances
**Responsibilities**:
- Fetch token balances from blockchain
- Sync balances to database
- Calculate order sizes based on available balance

### OrderConstructionService
**Purpose**: Build and validate orders before execution
**Responsibilities**:
- Construct individual orders
- Construct order pairs (buy + sell)
- Validate balances before execution
- Prepare blockchain transactions

### OrderExecutionService
**Purpose**: Execute orders on blockchain and persist to database
**Responsibilities**:
- Handle token approvals
- Send transactions to blockchain
- Fetch blockchain order IDs
- Save orders to database
- Support test mode simulation

### OrderStatusService
**Purpose**: Poll blockchain for order status updates
**Responsibilities**:
- Fetch pending orders from database
- Query blockchain via TWAP SDK
- Detect status changes (pending → filled)
- Update order status in database
- Simulate fills in test mode

### CounterOrderService
**Purpose**: Handle counter-order placement and activity tracking
**Responsibilities**:
- Calculate profit margins (±1%)
- Place counter-orders for filled orders
- Log activity to SushiswapActivity table
- Prevent duplicate counter-orders

### WalletService
**Purpose**: Manage wallet operations and database counters
**Responsibilities**:
- Load wallets from environment
- Parse trading pool strings
- Manage placed_initial_orders counter with database locking
- Handle concurrent access safely

## How It Works

### Every 4 Hours (or 10 seconds in test mode):

1. **Load Wallets**: Fetch all wallets from `BotWallet` table
2. **For Each Wallet**:
   - **Sync balances** from blockchain to database
   - **If `placed_initial_orders < 5`**: Place remaining buy-sell order pairs
   - **If `placed_initial_orders = 5`**: Check order status and place counter-orders

### Initial Order Placement Flow

```
placeInitialOrders.ts
  ↓
WalletService.parseTradingPool()
  ↓
BalanceService.syncBalances()
  ↓
OrderConstructionService.constructOrderPair()
  ├→ BalanceService.getBalance() (validate)
  ├→ Build BUY order
  └→ Build SELL order
  ↓
OrderExecutionService.executeOrder() (BUY)
  ├→ Approve tokens if needed
  ├→ Send transaction
  ├→ Fetch blockchain order ID
  └→ Save to database
  ↓
OrderExecutionService.executeOrder() (SELL)
  ↓
WalletService.incrementPlacedOrdersCounter()
```

**Key Features**:
- **Atomic Pair Guarantee**: Both orders constructed before execution
- **Database Locking**: Prevents concurrent duplicate placements
- **Safety Checks**: Verifies order counts before placement
- **Rollback on Failure**: Decrements counter if blockchain fails

### Counter-Order Placement Flow

```
checkCounterOrders.ts
  ↓
OrderStatusService.pollOrderStatus()
  ├→ Fetch pending orders from DB
  ├→ Query blockchain via TWAP SDK
  └→ Detect status changes
  ↓
OrderStatusService.updateOrderStatus()
  ↓
[If order filled]
  ↓
CounterOrderService.addToActivityLog()
  ├→ BalanceService.syncBalances()
  ├→ Create SushiswapActivity record
  └→ Track USD volume
  ↓
CounterOrderService.placeCounterOrder()
  ├→ Check for existing counter-order
  ├→ Calculate execution price
  ├→ Calculate counter price (±1%)
  ├→ OrderConstructionService.constructOrder()
  └→ OrderExecutionService.executeCounterOrder()
```

**Counter-Order Logic**:
- If parent was BUY → SELL at +1% profit
- If parent was SELL → BUY at -1% below
- Uses filled amount from parent order
- Prevents duplicates with DB check

## Configuration (config.ts)

```typescript
export const BOT_CONFIG = {
  RPC_URL: 'https://rpc.katana.network',
  CRON_INTERVAL_HOURS: 4,
  CHAIN_ID: 747474
}

export const GRID_CONFIG = {
  BUY_OFFSETS: [-1, -1.5, -2, -2.5, -3],   // % below market
  SELL_OFFSETS: [1, 1.5, 2, 2.5, 3],       // % above market
  MIN_ORDER_SIZE_USD: 6,
  EXPIRY_HOURS: 168
}

export const COUNTER_ORDER_CONFIG = {
  PROFIT_MARGIN_PERCENT: 1,
  MIN_ORDER_SIZE_USD: 6,
  EXPIRY_HOURS: 168
}

export const TEST_MODE_CONFIG = {
  enabled: process.env.BOT_TEST_MODE === 'true',
  intervalSeconds: 10,
  simulatedOrders: new Map<string, any[]>()
}
```

## Database Schema

### BotWallet
Stores wallet information and order placement progress:
- `wallet_address` - Wallet address
- `wallet_index` - Index (1-100) for env variable lookup
- `trading_pool` - Trading pair (e.g., "USDC/WETH")
- `usdc`, `eth`, `sushi` - Token balances
- `placed_initial_orders` - Progress counter (0-5)

### BotOrdersSimple
Tracks all orders (grid and counter):
- `wallet_address` - Owner wallet
- `blockchain_order_id` - Blockchain order ID
- `order_type` - 'grid_buy', 'grid_sell', 'counter_buy', 'counter_sell'
- `parent_order_id` - Links counter-orders to parent orders
- `from_token`, `to_token` - Token pair
- `from_amount`, `to_amount` - Trade amounts
- `status` - 'pending', 'partial', 'filled', 'expired', 'canceled'
- `progress` - Fill percentage (0-100)
- `placed_at`, `filled_at`, `last_checked_at` - Timestamps
- `usd_value` - Approximate USD value

## Usage

### 1. Setup Environment Variables

```bash
# Wallet private keys
WALLET_1=0x...
WALLET_2=0x...

# Test mode (optional)
BOT_TEST_MODE=false  # Set to 'true' for testing
```

### 2. Add Wallets to Database

```sql
INSERT INTO bot_wallets (wallet_address, wallet_index, trading_pool, placed_initial_orders)
VALUES ('0xYourWalletAddress', 1, 'USDC/WETH', 0);
```

### 3. Start the Bot

```typescript
import { startSimpleLimitOrderBotCron } from './simpleLimitOrderBot'

startSimpleLimitOrderBotCron()
```

## Test Mode

Enable test mode to simulate orders without blockchain interaction:

```bash
BOT_TEST_MODE=true
```

**Test Mode Behavior**:
- Runs every 10 seconds (vs 4 hours)
- Simulates blockchain transactions
- Generates test order IDs (`TEST_*` prefix)
- Simulates order fills (30% probability)
- All database operations still occur
- Zero gas costs

**What Still Works**:
- ✅ Database operations
- ✅ Balance tracking
- ✅ Activity logging
- ✅ Price fetching
- ❌ Blockchain transactions
- ❌ Token approvals
- ❌ Gas costs

## Debugging

### Check Wallet Status
```sql
SELECT wallet_index, wallet_address, placed_initial_orders, trading_pool
FROM bot_wallets
ORDER BY wallet_index;
```

### Check Orders for a Wallet
```sql
SELECT id, order_type, from_token, to_token, status, progress, usd_value
FROM bot_orders_simple
WHERE wallet_address = '0x...'
ORDER BY placed_at DESC;
```

### Find Counter-Order Chains
```sql
SELECT
  parent.id as parent_id,
  parent.order_type,
  parent.status,
  child.id as counter_id,
  child.order_type as counter_type,
  child.status as counter_status
FROM bot_orders_simple parent
LEFT JOIN bot_orders_simple child ON child.parent_order_id = parent.id
WHERE parent.parent_order_id IS NULL
ORDER BY parent.placed_at DESC;
```

## Advantages of Modular Architecture

### Easy to Understand
- Each service has a single responsibility
- Clear separation of concerns
- Self-documenting code structure

### Easy to Debug
- Isolated services can be tested independently
- Clear error boundaries
- Focused logging per service

### Easy to Scale
- Add new order strategies without touching core logic
- Swap implementations (e.g., different balance calculation)
- Test individual services in isolation

### Easy to Maintain
- Changes localized to specific services
- No massive files to navigate
- Clear dependencies between modules

## Service Dependencies

```
index.ts
  ├→ WalletService (wallet loading)
  ├→ BalanceService (balance syncing)
  ├→ placeInitialOrders.ts
  │   ├→ WalletService
  │   ├→ BalanceService
  │   ├→ OrderConstructionService
  │   │   └→ BalanceService
  │   └→ OrderExecutionService
  └→ checkCounterOrders.ts
      ├→ OrderStatusService
      └→ CounterOrderService
          ├→ BalanceService
          ├→ OrderConstructionService
          └→ OrderExecutionService
```

## Security

- Private keys loaded from environment only
- Never logged or exposed
- Wallet addresses validated against database
- All transactions explicitly constructed
- Database locking prevents race conditions

## Logging

All services use structured logging with clear prefixes:

```
[SimpleLimitOrderBot] Main orchestrator logs
[PlaceInitialOrders] Initial order placement logs
[CheckCounterOrders] Counter-order checking logs
[BalanceService] Balance operation logs
[OrderConstruction] Order building logs
[OrderExecution] Execution logs
[OrderStatus] Status polling logs
[CounterOrder] Counter-order logic logs
[WalletService] Wallet management logs
```

Logs are clean, without timestamps (removed per user request), making them easy to read and grep.

## Features

- ✅ Modular service-based architecture
- ✅ Single responsibility services
- ✅ Initial order placement with atomic pairs
- ✅ Order status checking via blockchain polling
- ✅ Counter-order placement with profit margins
- ✅ Balance tracking and syncing
- ✅ SushiswapActivity integration
- ✅ Database locking for concurrency safety
- ✅ Test mode for safe development
- ✅ Duplicate prevention at multiple layers
- ✅ Clean, readable logging
