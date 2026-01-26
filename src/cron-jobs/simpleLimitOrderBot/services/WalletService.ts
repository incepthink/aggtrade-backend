/**
 * Wallet Service
 * Handles wallet management and database operations
 */

import { ethers } from 'ethers'
import BotWallet from '../../../models/BotWallet'
import { KatanaLogger } from '../../../utils/logger'
import sequelize from '../../../utils/db/sequelize'
import { Transaction } from 'sequelize'
import { MNEMONIC_CONFIG, getTradingPoolForWallet } from '../config'

const PREFIX = '[WalletService]'

export interface WalletWithSigner {
  address: string
  index: number
  signer: ethers.Wallet
  tradingPool: string
}

// Mnemonic holder (loaded from AWS Secrets Manager or env)
// SECURITY: Cleared after wallets are derived
let _mnemonic: string | null = null

export class WalletService {
  /**
   * Set the mnemonic (used when loading from AWS Secrets Manager)
   * SECURITY: Do not log the mnemonic
   */
  static setMnemonic(mnemonic: string): void {
    _mnemonic = mnemonic
  }

  /**
   * Clear the mnemonic from memory
   * SECURITY: Call this after wallets are derived
   */
  static clearMnemonic(): void {
    _mnemonic = null
  }

  /**
   * Get the current mnemonic (from memory or env)
   */
  static getMnemonic(): string | null {
    return _mnemonic || process.env.BOT_MNEMONIC || null
  }

  /**
   * Load wallet from mnemonic or env private key and create signer
   * SECURITY: No sensitive data is logged
   */
  static loadWalletWithSigner(
    walletIndex: number,
    provider: ethers.Provider
  ): WalletWithSigner | null {
    const mnemonic = this.getMnemonic()

    // Try mnemonic-based derivation first
    if (mnemonic) {
      try {
        const hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic)
        const derivedWallet = hdNode.deriveChild(walletIndex)
        const wallet = new ethers.Wallet(derivedWallet.privateKey, provider)
        const tradingPool = getTradingPoolForWallet(walletIndex)

        return {
          address: wallet.address,
          index: walletIndex,
          signer: wallet,
          tradingPool
        }
      } catch (error) {
        KatanaLogger.error(PREFIX, `Failed to derive wallet ${walletIndex}`)
        return null
      }
    }

    // Fallback to individual private key
    const envKey = `WALLET_${walletIndex}`
    const privateKey = process.env[envKey]

    if (!privateKey) {
      KatanaLogger.warn(PREFIX, `No key found for wallet ${walletIndex}`)
      return null
    }

    try {
      const wallet = new ethers.Wallet(privateKey, provider)

      return {
        address: wallet.address,
        index: walletIndex,
        signer: wallet,
        tradingPool: ''
      }
    } catch (error) {
      KatanaLogger.error(PREFIX, `Failed to load wallet ${walletIndex}`)
      return null
    }
  }

  /**
   * Load all wallets from mnemonic
   * Returns array of WalletWithSigner for each configured wallet
   * SECURITY: Mnemonic is never logged
   */
  static loadAllWalletsFromMnemonic(provider: ethers.Provider): WalletWithSigner[] {
    const mnemonic = this.getMnemonic()

    if (!mnemonic) {
      KatanaLogger.warn(PREFIX, 'No mnemonic available')
      return []
    }

    const wallets: WalletWithSigner[] = []
    const walletCount = MNEMONIC_CONFIG.WALLET_COUNT

    KatanaLogger.info(PREFIX, `Deriving ${walletCount} wallets...`)

    try {
      const hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic)

      for (let i = 0; i < walletCount; i++) {
        const derivedWallet = hdNode.deriveChild(i)
        const wallet = new ethers.Wallet(derivedWallet.privateKey, provider)
        const tradingPool = getTradingPoolForWallet(i)

        wallets.push({
          address: wallet.address,
          index: i,
          signer: wallet,
          tradingPool
        })

        KatanaLogger.info(PREFIX, `  Wallet ${i}: ${wallet.address.slice(0, 10)}... → ${tradingPool}`)
      }

      KatanaLogger.info(PREFIX, `Derived ${wallets.length} wallets`)
    } catch (error) {
      KatanaLogger.error(PREFIX, 'Failed to derive wallets')
    }

    return wallets
  }

  /**
   * Parse trading pool string (e.g., "USDC/WETH")
   */
  static parseTradingPool(tradingPool: string): { token1: string; token2: string } {
    const [token1, token2] = tradingPool.split('/')

    if (!token1 || !token2) {
      throw new Error(`Invalid trading pool format: ${tradingPool}. Expected format: TOKEN1/TOKEN2`)
    }

    return {
      token1: token1.trim(),
      token2: token2.trim()
    }
  }

  /**
   * Increment placed_initial_orders counter with database lock
   * Returns false if another process already placed this pair
   */
  static async incrementPlacedOrdersCounter(
    walletAddress: string,
    expectedValue: number,
    walletIndex?: number
  ): Promise<boolean> {
    const transaction = await sequelize.transaction({
      isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED
    })

    try {
      // Lock the row
      const wallet = await BotWallet.findOne({
        where: { wallet_address: walletAddress.toLowerCase() },
        lock: Transaction.LOCK.UPDATE,
        transaction
      })

      if (!wallet) {
        await transaction.rollback()
        throw new Error(`Wallet ${walletAddress} not found`)
      }

      // Check if another process already incremented
      if (wallet.placed_initial_orders > expectedValue) {
        await transaction.rollback()
        return false
      }

      // Verify expected value
      if (wallet.placed_initial_orders !== expectedValue) {
        await transaction.rollback()
        throw new Error(
          `Counter mismatch: expected ${expectedValue}, got ${wallet.placed_initial_orders}`
        )
      }

      // Increment counter
      wallet.placed_initial_orders = expectedValue + 1
      await wallet.save({ transaction })

      await transaction.commit()

      return true

    } catch (error) {
      // Only rollback if transaction hasn't been rolled back already
      if (!transaction.finished) {
        await transaction.rollback()
      }
      KatanaLogger.error(PREFIX, 'Failed to increment counter', error)
      throw error
    }
  }

  /**
   * Decrement placed_initial_orders counter (rollback)
   */
  static async decrementPlacedOrdersCounter(
    walletAddress: string,
    currentValue: number
  ): Promise<void> {
    await BotWallet.update(
      { placed_initial_orders: currentValue - 1 },
      { where: { wallet_address: walletAddress.toLowerCase() } }
    )
  }

  /**
   * Get wallet record from database
   */
  static async getWalletRecord(walletAddress: string): Promise<any> {
    return await BotWallet.findByAddress(walletAddress)
  }

  /**
   * Get all wallet records from database
   * If walletIndex is provided, only return that specific wallet
   */
  static async getAllWalletRecords(walletIndex?: number | null): Promise<any[]> {
    const allWallets = await BotWallet.getAllWallets()

    // Filter by wallet index if specified
    if (walletIndex !== null && walletIndex !== undefined) {
      return allWallets.filter((wallet: any) => wallet.wallet_index === walletIndex)
    }

    return allWallets
  }
}
