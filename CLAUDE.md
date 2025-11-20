# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AggTrade Backend is a Node.js/TypeScript API for aggregating and serving DeFi trading data, focused on SushiSwap pools across Ethereum and Katana (Ronin) chains. It provides OHLC (candlestick) data, user portfolio tracking, token pricing, and swap analytics by querying multiple subgraphs and external APIs.

## Development Commands

### Running the Application
```bash
# Development (using Bun)
bun run index.ts

# Production build
npm run build
npm start
```

### Database Operations
The project uses dual databases:
- **MongoDB**: User mappings, portfolio history (via Mongoose)
- **MySQL**: Swap data, referrals, tokens (via Sequelize)

MySQL connection configured via `src/config/config.json` with environment-specific settings. Host can be overridden with `DEVELOPMENT_DB_HOST` or `PRODUCTION_DB_HOST` env variables.

Run migrations manually:
```bash
# Note: Migration files use .cjs extension (CommonJS) due to "type": "module" in package.json
npx sequelize-cli db:migrate
```

### Key Environment Variables
Required in `.env`:
- `MONGO_URI`: MongoDB connection string
- `MORALIS_API`: Moralis API key for blockchain data
- `REDIS_URL`: Redis connection for caching
- `PORT`: Server port (default: 5000)
- Database host overrides: `DEVELOPMENT_DB_HOST`, `PRODUCTION_DB_HOST`

## Architecture

### Core Entry Points
1. **src/index.ts**: Bootstrap - initializes Sequelize, MongoDB, Moralis, and Express app
2. **src/app.ts**: Express app factory with middleware and route registration
3. **src/router.ts**: Main API router (mounted at `/api`)
4. **src/routes/index.ts**: Additional route groups (`/platform`, `/user`)

### Route Organization
- **Legacy routes** (src/router.ts): Extensive `/api/*` routes for tokens, OHLC, admin operations
- **Platform routes** (src/routes/platform.ts): `/platform/chart/katana`, `/platform/pools/katana`
- **User routes** (src/routes/user.ts): `/user/equity-trend/:userAddress`, `/user/balance/katana/:userAddress`, referrals, TVL
- **1inch proxy routes**: Mounted directly in app.ts at `/proxy/1inch/*` with rate limiting

### OHLC Data Architecture
The system provides multiple implementations for fetching candlestick data:

**1inch Data**: Pool-based implementation using 1inch price API
- Controllers: `controllers/oneInchOHLCController.ts`
- Routes: `/api/ohlc/1inch`

**SushiSwap Ethereum**: Multiple strategies available
- **Pool-based**: Uses SushiSwap pool data (controllers/sushiswapOHLCController.ts)
- **Token-based**: Uses TokenHourData/TokenDayData from subgraph (controllers/ethereumTokenOHLCController.ts)
- **Swap-based**: Real-time swap event processing (controllers/ethereumSushiswapOHLCController.ts)
- Routes: `/api/ohlc/ethereum/*`, defaults to token-based at `/api/ohlc/ethereum`

**Katana (Ronin)**: Three implementations with different accuracy/coverage tradeoffs
- **Pool-based**: Original implementation using pool snapshots (controllers/katanaSushiswapOHLCController.ts)
- **Token-based**: Uses Katana TokenHourData (controllers/katanaTokenOHLCController.ts)
- **Swap-based**: Real-time swap processing with MySQL persistence (controllers/swapOHLC/katanaSushiswapSwapController.ts)
- **SqrtPrice-based**: Most accurate, uses sqrtPriceX96 from pool ticks (controllers/sqrtOHLC/katanaSushiswapSqrtPriceController.ts)
- Routes: `/api/ohlc/katana/*`, defaults to token-based at `/api/ohlc/katana`

All OHLC endpoints support:
- Redis caching with DELETE endpoints to clear cache
- Batch operations via POST `/batch` endpoints
- Multiple timeframes (1m, 5m, 15m, 1h, 4h, 1d)

### Data Layer

**MongoDB Models** (src/mongoModels.ts):
- Simple Mapping schema for user/dydx address pairs

**Sequelize Models** (src/models/):
- User, ReferralCode, Referral: Referral system with associations
- KatanaSwap: Swap events from Katana chain (migrated from MongoDB)
- Token: Token metadata and status
- BalanceHistory: User portfolio tracking over time
- UserActivityLog: Comprehensive activity logging for all user interactions

Associations defined in `src/models/index.ts` handle User ↔ ReferralCode and User ↔ Referral relationships.

### User Activity Tracking

**UserActivityLog Model** (src/models/UserActivityLog.ts):
- Comprehensive activity logging for all user interactions across platforms
- Tracks: swaps, deposits, withdrawals, staking actions with USD volume
- Supports: leaderboards, referral analytics, platform statistics
- Optimized indexes for time-series queries and leaderboard calculations

**Activity Routes** (src/routes/activity.ts):
- POST `/api/activity` - Create activity log
- POST `/api/activity/bulk` - Bulk create activities
- GET `/api/activity/user/:userId` - User activity feed
- GET `/api/activity/wallet/:walletAddress/volume` - Volume by wallet
- GET `/api/activity/leaderboard/:actionCategory` - Leaderboards
- GET `/api/activity/platform/:platform/stats` - Platform analytics
- GET `/api/activity/token/:tokenAddress/stats` - Token statistics
- GET `/api/activity/tx/:txHash` - Get activity by transaction hash
- PATCH `/api/activity/tx/:txHash/status` - Update activity status
- DELETE `/api/activity/tx/:txHash` - Delete activity by tx hash

### Wallet Signature Authentication

**Purpose**: Verify users connecting through frontend vs direct API access

**User Model** (src/models/User.ts):
- `signature` field stores one-time wallet signature for authentication
- Uses ethers.js `verifyMessage()` for cryptographic verification

**Authentication Endpoints** (src/controllers/user/wallet.ts):
- GET `/user/signature?wallet={address}` - Check if signature exists (returns `{ exists: boolean }`)
- POST `/user/signature` - Store signature (body: `{ wallet, signature, message, timestamp }`)

**Flow**: User signs message on first connect → Signature verified and stored → Future requests can verify user authenticity

### Services Layer (src/services/)

**apiService.ts**: Primary data fetching service
- SushiSwap subgraph queries (pools, swaps, sqrtPrice data)
- Sushi API price fetching
- Bottleneck rate limiting for API calls
- GraphQL query builders for different data types

**fetchManager.ts**: Coordinates multi-source data fetching with error handling
**memoryManager.ts**: Manages data size and Redis memory constraints
**priceCalculator.ts**: Token price calculations from swap/pool data
**sushiswap.ts**: SushiSwap-specific utilities
**referral.ts**: Referral system business logic
**user.ts**: User portfolio and equity calculations

### Utilities (src/utils/)

**Katana utilities** (src/utils/katana/*): Extensive toolkit for Katana chain data
- `candleGeneration.ts`: OHLC candle creation from swap data
- `candleOperations.ts`: MySQL candle CRUD operations
- `redisCandleOperations.ts`: Redis caching for candles
- `swapProcessing.ts`: Raw swap data normalization
- `priceCalculations.ts`: Price derivation from sqrtPriceX96 and pool ratios
- `poolSelection.ts`: TVL-based pool selection for pricing
- `mysqlOperations.ts`: MySQL batch operations for swaps
- `redisOperations.ts`: Redis swap caching
- `graphqlQueries.ts`: Subgraph query templates
- `timeRangeHelpers.ts`: Time range calculations for data fetching
- `constants.ts`: Configuration constants (cache TTLs, batch sizes, rate limits)

**Database utilities** (src/utils/db/sequelize.ts): Sequelize configuration with environment-based setup

**Other utilities**:
- `sushiswap.ts`, `sushiPriceUtils.ts`: SushiSwap price calculations
- `logger.ts`: Structured logging with KatanaLogger

### Cron Jobs (src/cron-jobs/)

**equityTrend.ts**: Scheduled user portfolio snapshots
**migrateKatanaSwapsToMySQL.ts**: Migrates MongoDB swap data to MySQL (can be triggered via `/api/admin/trigger-migration`)
**updateProactiveCandlesJob.ts**: Proactively updates candles for whitelisted tokens every 5 minutes
**redis/redisKeyScanner.ts**: Redis key management and cleanup

### Redis Caching Strategy

Redis is used extensively for:
- OHLC data caching (various TTLs per data type)
- Swap event caching
- Candle data with 1-year TTL for historical data
- Update locks to prevent concurrent fetches
- Cache keys follow patterns: `sqrt_price_katana_{token}`, `candle_{token}_{interval}`, etc.

Memory management is critical due to Redis Upstash free tier limits (see memoryManager.ts).

### Admin Routes

**Token management**:
- DELETE `/api/admin/delete-token/:tokenAddress`: Remove token data
- GET `/api/admin/fill-katana-gaps/:tokenAddress`: Backfill missing swap data

**Data migration**:
- GET `/api/admin/trigger-migration`: Manually trigger Katana swap MongoDB→MySQL migration

### Key Implementation Patterns

1. **Multi-strategy OHLC**: When implementing new OHLC endpoints, follow the pattern of having pool/token/swap/sqrtPrice variants with clear tradeoffs documented

2. **Subgraph pagination**: The Graph has a 5000 skip limit. Use batch fetching with `first` and `skip` parameters, handle MAX_SKIP gracefully

3. **Rate limiting**: External APIs use Bottleneck for rate limiting. Check `apiService.ts` for configuration patterns

4. **Cache invalidation**: All cached endpoints should have corresponding DELETE routes for manual cache clearing

5. **Historical data appending**: Use incremental time ranges (`getIncrementalTimeRange`) to fetch only new data and merge with existing cached data

6. **Pool selection**: For token pricing, select pools by TVL (highest liquidity = most accurate pricing)

7. **Price calculations**: sqrtPriceX96 is the most accurate price source. Convert using: `(sqrtPriceX96 / 2^96)^2` adjusted for decimals

8. **Error handling**: Services return null/empty arrays on errors, controllers return proper HTTP status codes

## Important Notes

- This project was created with Bun but uses npm scripts for build/start
- The codebase uses both MongoDB and MySQL - understand which model lives where
- NewRelic APM is integrated (imported in index.ts)
- Moralis API is required for blockchain data access
- Token addresses should be normalized to lowercase
- When adding new OHLC implementations, update both the controller and add appropriate routes in router.ts