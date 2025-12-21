import { constructSDK, TimeUnit, type Order, OrderStatus } from '@orbs-network/twap-sdk'
import { encodeFunctionData, createPublicClient, http } from 'viem'
import { Address } from 'viem'
import { TWAP_CONFIG, TWAP_CONTRACT_ADDRESS, KATANA_CHAIN_ID } from '../config/twap'
import { twapABI } from '../abi/twap'
import { log } from 'console'

// Define Katana chain configuration
const katana = {
  id: KATANA_CHAIN_ID,
  name: 'Katana',
  network: 'katana',
  nativeCurrency: {
    decimals: 18,
    name: 'RON',
    symbol: 'RON',
  },
  rpcUrls: {
    default: {
      http: ['https://rpc.katana.network/'],
    },
    public: {
      http: ['https://rpc.katana.network/'],
    },
  },
} as const

// Create public client for Katana
export const publicClient = createPublicClient({
  chain: katana,
  transport: http('https://rpc.katana.network/')
})

// Map our time units to SDK TimeUnit enum
const SDK_TIME_UNIT_MAP = {
  Seconds: TimeUnit.Minutes, // Use Minutes as base, will adjust value
  Minutes: TimeUnit.Minutes,
  Hours: TimeUnit.Hours,
  Days: TimeUnit.Days,
} as const

type CustomTimeUnit = keyof typeof SDK_TIME_UNIT_MAP

export interface FillDelay {
  unit: CustomTimeUnit
  value: number
}

export interface PrepareLimitOrderParams {
  srcToken: Address
  dstToken: Address
  srcAmount: string
  dstMinAmount: string
  srcChunkAmount: string
  deadline: number
  fillDelay: FillDelay
}

export interface LimitOrderTransaction {
  to: Address
  data: `0x${string}`
  value: string
}

/**
 * Enhanced order type with status and fill delay
 * This matches the frontend's TwapOrder type
 */
export interface TwapOrder extends Order {
  status: OrderStatus
  fillDelayMs: number
  progress: number
}

/**
 * Grouped orders by status
 */
export interface GroupedOrders {
  ALL: TwapOrder[]
  OPEN: TwapOrder[]
  COMPLETED: TwapOrder[]
  CANCELED: TwapOrder[]
  EXPIRED: TwapOrder[]
}

/**
 * TWAP Service for SushiSwap Limit Orders on Katana
 */
export class TwapService {
  private static sdk = constructSDK({ config: TWAP_CONFIG })


  private static convertFillDelayToSeconds(fillDelay: FillDelay): number {
    switch (fillDelay.unit) {
      case 'Seconds':
        return fillDelay.value
      case 'Minutes':
        return fillDelay.value * 60
      case 'Hours':
        return fillDelay.value * 60 * 60
      case 'Days':
        return fillDelay.value * 60 * 60 * 24
      default:
        throw new Error(`Unsupported time unit: ${fillDelay.unit}`)
    }
  }

  /**
   * Convert fill delay to SDK TimeDuration format
   */
  private static convertFillDelayToSDK(fillDelay: FillDelay): { unit: TimeUnit; value: number } {
    // SDK TimeUnit enum values are in milliseconds, but we need to pass the right unit type
    switch (fillDelay.unit) {
      case 'Seconds':
        // Convert seconds to minutes (SDK doesn't support seconds, so use minutes)
        return {
          unit: TimeUnit.Minutes,
          value: fillDelay.value / 60
        }
      case 'Minutes':
        return {
          unit: TimeUnit.Minutes,
          value: fillDelay.value
        }
      case 'Hours':
        return {
          unit: TimeUnit.Hours,
          value: fillDelay.value
        }
      case 'Days':
        return {
          unit: TimeUnit.Days,
          value: fillDelay.value
        }
      default:
        throw new Error(`Unsupported time unit: ${fillDelay.unit}`)
    }
  }

  /**
   * Normalize token address for SDK
   * SDK expects zero address for native ETH/RON
   */
  private static normalizeTokenAddress(address: Address): Address {
    const ETH_PLACEHOLDER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    return address.toLowerCase() === ETH_PLACEHOLDER.toLowerCase()
      ? '0x0000000000000000000000000000000000000000'
      : address
  }

  /**
   * Prepare limit order transaction
   */
  static prepareLimitOrder(params: PrepareLimitOrderParams): LimitOrderTransaction {
    const {
      srcToken,
      dstToken,
      srcAmount,
      dstMinAmount,
      srcChunkAmount,
      deadline,
      fillDelay,
    } = params

    // Use token addresses exactly as provided by frontend
    const srcTokenAddress = srcToken
    const dstTokenAddress = dstToken

    const isNativeToken = srcToken.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  const txValue = isNativeToken ? srcAmount : '0'

    // Convert fill delay to SDK format
    const sdkFillDelay = this.convertFillDelayToSDK(fillDelay)

    // Call SDK to generate order parameters
    const sdkParams = this.sdk.getAskParams({
      srcTokenAddress,
      destTokenAddress: dstTokenAddress,
      srcAmount: srcAmount,
      destTokenMinAmount: dstMinAmount,
      srcChunkAmount: srcChunkAmount,
      deadline: deadline,
      fillDelay: sdkFillDelay,
    }) as any

    // Encode transaction data - map SDK params array to ABI tuple structure
    // SDK returns: [exchange, srcToken, dstToken, srcAmount, srcBidAmount, dstMinAmount, deadline, bidDelay, fillDelay, data]
    // Note: data field might be empty string, need to convert to 0x for bytes type
    const dataField = sdkParams[9] === '' ? '0x' : sdkParams[9]

    const encodedData = encodeFunctionData({
      abi: twapABI,
      functionName: 'ask',
      args: [{
        exchange: sdkParams[0] as `0x${string}`,
        srcToken: sdkParams[1] as `0x${string}`,
        dstToken: sdkParams[2] as `0x${string}`,
        srcAmount: BigInt(sdkParams[3]),
        srcBidAmount: BigInt(sdkParams[4]),
        dstMinAmount: BigInt(sdkParams[5]),
        deadline: Number(sdkParams[6]),
        bidDelay: Number(sdkParams[7]),
        fillDelay: Number(sdkParams[8]),
        data: dataField as `0x${string}`
      }]
    })

    const transaction: LimitOrderTransaction = {
      to: TWAP_CONTRACT_ADDRESS,
      data: encodedData,
      value: txValue
    }

    return transaction
  }

  /**
   * Calculate fill delay in milliseconds
   * This is the exact logic from @orbs-network/twap-sdk's getOrderFillDelayMillis
   */
  private static calculateFillDelayMs(order: Order): number {
    // fillDelay is in seconds from the contract
    return order.fillDelay * 1000
  }

  /**
   * Filter and sort orders by status
   */
  private static filterAndSortOrders(orders: TwapOrder[], status: OrderStatus): TwapOrder[] {
    return orders
      .filter((order) => order.status === status)
      .sort((a, b) => b.createdAt - a.createdAt) // Most recent first
  }

  /**
   * Fetch all limit orders for a wallet address
   * This mimics the EXACT flow from useTwapOrders hook in the frontend
   *
   * Steps:
   * 1. Call SDK's getOrders() method with wallet address
   * 2. Enhance orders with status and fill delay
   * 3. Group orders by status (ALL, OPEN, COMPLETED, CANCELED, EXPIRED)
   *
   * @param walletAddress - The wallet address to fetch orders for (0x...)
   * @param silent - If true, suppress logging
   * @returns Grouped orders by status
   */
  static async fetchLimitOrders(walletAddress: string, silent: boolean = false): Promise<GroupedOrders> {
    // Fetch orders from blockchain
    const rawOrders = await this.sdk.getOrders(walletAddress)

    // Enhance orders with metadata
    const orders: TwapOrder[] = rawOrders.map((order) => {
      const fillDelayMs = this.calculateFillDelayMs(order)
      const progress = order.status === OrderStatus.Completed ? 100 : order.progress

      return {
        ...order,
        status: order.status,
        fillDelayMs,
        progress,
      }
    })

    // Group orders by status
    const groupedOrders: GroupedOrders = {
      ALL: orders,
      OPEN: this.filterAndSortOrders(orders, OrderStatus.Open),
      COMPLETED: this.filterAndSortOrders(orders, OrderStatus.Completed),
      CANCELED: this.filterAndSortOrders(orders, OrderStatus.Canceled),
      EXPIRED: this.filterAndSortOrders(orders, OrderStatus.Expired),
    }

    return groupedOrders
  }

  /**
   * Fetch only open orders for a wallet
   * Useful for monitoring active trades
   */
  static async fetchOpenOrders(walletAddress: string): Promise<TwapOrder[]> {
    const groupedOrders = await this.fetchLimitOrders(walletAddress)
    return groupedOrders.OPEN
  }

  /**
   * Get specific order by ID
   */
  static async getOrderById(walletAddress: string, orderId: number): Promise<TwapOrder | undefined> {
    const groupedOrders = await this.fetchLimitOrders(walletAddress)
    return groupedOrders.ALL.find((order) => order.id === orderId)
  }
}