import { constructSDK, TimeUnit } from '@orbs-network/twap-sdk'
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

    console.log('[TWAP Service] Preparing limit order:', params)

    // Use token addresses exactly as provided by frontend
    const srcTokenAddress = srcToken
    const dstTokenAddress = dstToken

    const isNativeToken = srcToken.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  const txValue = isNativeToken ? srcAmount : '0'

    // Convert fill delay to SDK format
    const sdkFillDelay = this.convertFillDelayToSDK(fillDelay)

    console.log('[TWAP Service] Normalized tokens:', {
      original_src: srcToken,
      original_dst: dstToken,
      normalized_src: srcTokenAddress,
      normalized_dst: dstTokenAddress
    })
    // console.log('[TWAP Service] SDK fill delay:', sdkFillDelay)

    const fillDelayInSeconds = this.convertFillDelayToSeconds(fillDelay)
    console.log('[TWAP Service] Fill delay in seconds:', sdkFillDelay)

    // Call SDK to generate order parameters
    const sdkParams = this.sdk.getAskParams({
      srcTokenAddress,
      destTokenAddress: dstTokenAddress,
      srcAmount: srcAmount,
      destTokenMinAmount: dstMinAmount,
      srcChunkAmount: srcChunkAmount,
      deadline: deadline,
      fillDelay: sdkFillDelay,
    })

    console.log('[TWAP Service] SDK generated params:', sdkParams)
    console.log('[TWAP Service] SDK params breakdown:', {
      exchange: sdkParams[0],
      srcToken: sdkParams[1],
      dstToken: sdkParams[2],
      srcAmount: sdkParams[3],
      srcBidAmount: sdkParams[4],
      dstMinAmount: sdkParams[5],
      deadline: sdkParams[6],
      bidDelay: sdkParams[7],
      fillDelay: sdkParams[8],
      data: sdkParams[9]
    })

    // Encode transaction data - map SDK params array to ABI tuple structure
    // SDK returns: [exchange, srcToken, dstToken, srcAmount, srcBidAmount, dstMinAmount, deadline, bidDelay, fillDelay, data]
    // Note: data field might be empty string, need to convert to 0x for bytes type
    const dataField = sdkParams[9] === '' ? '0x' : sdkParams[9]

    const encodedData = encodeFunctionData({
      abi: twapABI,
      functionName: 'ask',
      args: [[
        sdkParams[0],  // exchange (address)
        sdkParams[1],  // srcToken (address)
        sdkParams[2],  // dstToken (address)
        sdkParams[3],  // srcAmount (uint256)
        sdkParams[4],  // srcBidAmount (uint256)
        sdkParams[5],  // dstMinAmount (uint256)
        sdkParams[6],  // deadline (uint32)
        sdkParams[7],  // bidDelay (uint32)
        sdkParams[8],  // fillDelay (uint32)
        dataField      // data (bytes)
      ]]
    })

    const transaction: LimitOrderTransaction = {
      to: TWAP_CONTRACT_ADDRESS,
      data: encodedData,
      value: txValue
    }

    console.log('[TWAP Service] Transaction prepared:', transaction)

    return transaction
  }
}