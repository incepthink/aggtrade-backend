import { ethers } from 'ethers'

/**
 * Bot wallet with signer instance
 */
export interface BotWallet {
  index: number // 1, 2, 3... 10
  address: string
  privateKey: string
  signer: ethers.Wallet
}

/**
 * Token configuration
 */
export interface TokenConfig {
  address: string
  symbol: string
  decimals: number
  isNative: boolean
}

/**
 * Grid bot configuration
 */
export interface GridConfig {
  BUY_OFFSETS: number[] // [-1, -2, -3]
  SELL_OFFSETS: number[] // [1, 2, 3]
  ORDER_SIZE_PERCENT: number // 20% of balance
  MIN_ORDER_VALUE_USD: number // $6 minimum
  EXPIRY_HOURS: number // 24 hours
  FILL_DELAY_MINUTES: number // 3 minutes
}

/**
 * Order placement parameters
 */
export interface OrderParams {
  wallet: BotWallet
  executionId: string
  fromToken: TokenConfig
  toToken: TokenConfig
  amount: string // Human-readable amount
  limitPrice: number // Price in USD (for ETH/USDC)
  orderType: 'grid_buy' | 'grid_sell' | 'counter_buy' | 'counter_sell'
  parentOrderId?: string | null
  gridOffset?: number | null
}

/**
 * Order status update from blockchain
 */
export interface OrderStatusUpdate {
  dbOrderId: number
  blockchainOrderId: number
  oldStatus: string
  newStatus: string
  progress: number
  filledSrcAmount: string
  filledDstAmount: string
  executionPrice?: string
}

/**
 * Wallet execution state
 */
export interface WalletExecutionState {
  wallet: BotWallet
  executionId: string
  gridPlaced: boolean
  activeOrders: number
  filledOrders: number
  lastPollTime: Date | null
}

/**
 * TWAP order from SDK (enhanced)
 */
export interface TwapOrder {
  id: number
  maker: string
  srcTokenAddress: string
  dstTokenAddress: string
  srcAmount: string
  srcAmountPerChunk: string
  dstMinAmountPerChunk: string
  filledSrcAmount: string
  filledDstAmount: string
  chunks: number
  createdAt: number
  deadline: number
  fillDelay: number
  txHash: string
  status: 'Open' | 'Completed' | 'Canceled' | 'Expired'
  fillDelayMs: number
  progress: number
}

/**
 * Grouped TWAP orders by status
 */
export interface GroupedTwapOrders {
  ALL: TwapOrder[]
  OPEN: TwapOrder[]
  COMPLETED: TwapOrder[]
  CANCELED: TwapOrder[]
  EXPIRED: TwapOrder[]
}

/**
 * Counter-order trigger event
 */
export interface CounterOrderTrigger {
  parentOrder: any // BotLimitOrder instance
  filledSrcAmount: string
  filledDstAmount: string
  executionPrice: string
  wallet: BotWallet
  executionId: string
}

/**
 * Balance info
 */
export interface BalanceInfo {
  token: TokenConfig
  balance: string // Human-readable
  balanceWei: bigint
  valueUSD: number
}

/**
 * Grid placement result
 */
export interface GridPlacementResult {
  success: boolean
  buyOrders: number
  sellOrders: number
  totalOrders: number
  errors: string[]
}

/**
 * Monitoring stats
 */
export interface MonitoringStats {
  walletAddress: string
  totalOrders: number
  pendingOrders: number
  filledOrders: number
  expiredOrders: number
  lastPolled: Date
  errors: number
}
