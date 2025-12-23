/**
 * Balance Service
 * Handles all wallet balance operations
 */

import { ethers } from 'ethers'
import { getTokenBalance } from '../../utils/botWalletManager'
import { updateWalletBalances, TOKEN_COLUMN_MAPPING } from '../../utils/botBalanceUpdater'
import { fromWei } from '../../utils/botHelpers'
import { KatanaLogger } from '../../../utils/logger'
import { DatabaseLogger } from '../../../utils/logging/DatabaseLogger'

const PREFIX = '[BalanceService]'

export interface TokenBalance {
  balance: bigint
  balanceHuman: string
}

export class BalanceService {
  /**
   * Get token balance for a wallet
   */
  static async getBalance(
    provider: ethers.Provider,
    tokenAddress: string,
    walletAddress: string,
    isNative: boolean,
    decimals: number
  ): Promise<TokenBalance> {
    const balance = await getTokenBalance(provider, tokenAddress, walletAddress, isNative)
    const balanceHuman = fromWei(balance.toString(), decimals)

    return { balance, balanceHuman }
  }

  /**
   * Sync wallet balances from blockchain to database
   */
  static async syncBalances(
    provider: ethers.Provider,
    walletAddress: string,
    walletIndex?: number
  ): Promise<void> {
    try {
      await updateWalletBalances(provider, walletAddress, TOKEN_COLUMN_MAPPING)
    } catch (error: any) {
      if (walletIndex !== undefined) {
        await DatabaseLogger.logError(
          walletIndex,
          walletAddress,
          'balance_sync_failed',
          error.message,
          'syncBalances'
        )
      }
      KatanaLogger.error(PREFIX, `Failed to sync balances for ${walletAddress.slice(0, 8)}`, error)
      throw error
    }
  }

  /**
   * Calculate order size based on balance
   * Divides balance by 5 and ensures minimum USD value
   */
  static calculateOrderSize(
    tokenBalance: string,
    tokenPrice: number,
    minOrderSizeUsd: number = 6
  ): { orderSize: string; orderSizeUsd: number } {
    const balance = parseFloat(tokenBalance)
    const balanceUsd = balance * tokenPrice

    // Divide by 5 to create 5 orders
    let orderSizeUsd = balanceUsd / 5

    // Ensure minimum order size
    if (orderSizeUsd < minOrderSizeUsd) {
      orderSizeUsd = minOrderSizeUsd
    }

    // Convert back to token amount
    const orderSize = (orderSizeUsd / tokenPrice).toFixed(18)

    return { orderSize, orderSizeUsd }
  }

  /**
   * Calculate dynamic order sizing based on available balance
   * @param tokenBalance - Available token balance (human-readable)
   * @param tokenPrice - Current token price in USD
   * @param minOrderSizeUsd - Minimum order size in USD
   * @param maxOffsets - Maximum pairs available from offset array
   * @returns Order sizing information including max pairs affordable
   */
  static calculateDynamicOrderSize(
    tokenBalance: string,
    tokenPrice: number,
    minOrderSizeUsd: number,
    maxOffsets: number
  ): {
    orderSize: string
    orderSizeUsd: number
    maxPairsAffordable: number
    totalValueUsd: number
  } {
    const balance = parseFloat(tokenBalance)
    // Round to 2 decimal places to avoid floating-point precision issues
    const balanceUsd = Math.round(balance * tokenPrice * 100) / 100

    // Calculate how many pairs we can afford
    const maxPairsAffordable = Math.floor(balanceUsd / minOrderSizeUsd)

    // Cap at available offsets
    const actualPairs = Math.min(maxPairsAffordable, maxOffsets)

    // If we can't afford even 1 pair, return zeros
    if (actualPairs < 1) {
      return {
        orderSize: '0',
        orderSizeUsd: 0,
        maxPairsAffordable: 0,
        totalValueUsd: balanceUsd
      }
    }

    // Calculate order size for this many pairs
    const orderSizeUsd = balanceUsd / actualPairs
    const orderSize = (orderSizeUsd / tokenPrice).toFixed(18)

    return { orderSize, orderSizeUsd, maxPairsAffordable: actualPairs, totalValueUsd: balanceUsd }
  }
}
