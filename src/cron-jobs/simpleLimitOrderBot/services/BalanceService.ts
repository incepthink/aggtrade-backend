/**
 * Balance Service
 * Handles all wallet balance operations
 */

import { ethers } from 'ethers'
import { getTokenBalance } from '../../utils/botWalletManager'
import { updateWalletBalances, TOKEN_COLUMN_MAPPING } from '../../utils/botBalanceUpdater'
import { fromWei } from '../../utils/botHelpers'
import { KatanaLogger } from '../../../utils/logger'

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
    walletAddress: string
  ): Promise<void> {
    KatanaLogger.info(PREFIX, `Syncing balances for ${walletAddress.slice(0, 8)}...`)
    await updateWalletBalances(provider, walletAddress, TOKEN_COLUMN_MAPPING)
    KatanaLogger.info(PREFIX, 'Balances synced successfully')
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
      KatanaLogger.warn(
        PREFIX,
        `Calculated order size $${orderSizeUsd.toFixed(2)} below minimum $${minOrderSizeUsd}`
      )
      orderSizeUsd = minOrderSizeUsd
    }

    // Convert back to token amount
    const orderSize = (orderSizeUsd / tokenPrice).toFixed(18)

    KatanaLogger.info(
      PREFIX,
      `Order sizing: balance=$${balanceUsd.toFixed(2)}, size=$${orderSizeUsd.toFixed(2)}`
    )

    return { orderSize, orderSizeUsd }
  }
}
