/**
 * =============================================================================
 * BOT BALANCE UPDATER
 * =============================================================================
 *
 * This utility automatically updates BotWallet table balances for all tracked tokens.
 * It's designed to be scalable - add new token columns to BotWallet table and they
 * will automatically be tracked without code changes.
 *
 * Usage:
 * - Call updateWalletBalances() after fetching balances in the bot
 * - Call updateWalletBalances() before adding to SushiswapActivity table
 *
 * The function automatically:
 * 1. Fetches balances for all tokens in the BotWallet schema
 * 2. Updates the database with current balances
 * 3. Works with any number of tokens (scalable)
 *
 * =============================================================================
 */

import { ethers } from 'ethers'
import BotWallet from '../../models/BotWallet'
import { KatanaLogger } from '../../utils/logger'
import { getToken } from '../gridBot/tokenPairs.config'
import { getTokenBalance } from './botWalletManager'
import { fromWei } from './botHelpers'

const PREFIX = '[BotBalanceUpdater]'

/**
 * Token configuration for balance tracking
 */
interface TokenConfig {
  symbol: string
  address: string
  decimals: number
  isNative: boolean
}

/**
 * Get all token configurations from BotWallet model
 * This function extracts token columns from the model schema,
 * making it scalable - add new token columns and they're automatically tracked
 */
function getTrackedTokens(): TokenConfig[] {
  // Get all attributes from BotWallet model
  const attributes = BotWallet.getAttributes()
  const trackedTokens: TokenConfig[] = []

  // Token columns to track (excluding system columns)
  const tokenColumns = Object.keys(attributes).filter(key => {
    // Include columns that look like token symbols (lowercase, not system fields)
    return !['id', 'wallet_address', 'wallet_index', 'placed_initial_orders',
             'trading_pool', 'created_at', 'updated_at'].includes(key)
  })

  KatanaLogger.info(PREFIX, `Found ${tokenColumns.length} token columns: ${tokenColumns.join(', ')}`)

  // Convert column names to token configurations
  for (const column of tokenColumns) {
    try {
      const symbolUpperCase = column.toUpperCase()

      // Special handling for ETH (native token)
      if (symbolUpperCase === 'ETH') {
        trackedTokens.push({
          symbol: 'ETH', // Native token is ETH on Katana
          address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          decimals: 18,
          isNative: true
        })
        KatanaLogger.info(PREFIX, `Added native token: ${column} -> ETH`)
      } else {
        // Get token config from tokenPairs.config
        const tokenConfig = getToken(symbolUpperCase)
        trackedTokens.push({
          symbol: tokenConfig.symbol,
          address: tokenConfig.address,
          decimals: tokenConfig.decimals,
          isNative: tokenConfig.isNative || false
        })
        KatanaLogger.info(PREFIX, `Added token: ${column} -> ${tokenConfig.symbol}`)
      }
    } catch (error) {
      KatanaLogger.warn(PREFIX, `Could not get token config for column '${column}', skipping`)
    }
  }

  return trackedTokens
}

/**
 * Update all token balances for a wallet in the BotWallet table
 *
 * This function is SCALABLE - it automatically detects and updates balances
 * for all token columns in the BotWallet table.
 *
 * @param provider - Ethereum provider
 * @param walletAddress - Wallet address to update
 * @param tokenColumnMapping - Optional manual mapping of token symbols to column names
 *                             Format: { 'WRON': 'eth', 'USDC': 'usdc', etc. }
 */
export async function updateWalletBalances(
  provider: ethers.Provider,
  walletAddress: string,
  tokenColumnMapping?: Record<string, string>
): Promise<void> {
  try {
    KatanaLogger.info(PREFIX, `Updating balances for wallet ${walletAddress}`)

    // Step 1: Get all tracked tokens
    const trackedTokens = getTrackedTokens()

    if (trackedTokens.length === 0) {
      KatanaLogger.warn(PREFIX, 'No tokens configured for tracking')
      return
    }

    // Step 2: Fetch all token balances in parallel
    const balancePromises = trackedTokens.map(async (token) => {
      try {
        const balanceWei = await getTokenBalance(
          provider,
          token.address,
          walletAddress,
          token.isNative
        )

        const balanceHuman = fromWei(balanceWei.toString(), token.decimals)

        KatanaLogger.info(PREFIX, `${token.symbol}: ${balanceHuman}`)

        return {
          symbol: token.symbol,
          balance: balanceHuman
        }
      } catch (error) {
        KatanaLogger.error(PREFIX, `Failed to fetch balance for ${token.symbol}`, error)
        return null
      }
    })

    const balanceResults = await Promise.all(balancePromises)

    // Step 3: Build update object with column mappings
    const updates: Record<string, string> = {}

    for (const result of balanceResults) {
      if (!result) continue

      // Determine column name
      let columnName: string

      if (tokenColumnMapping && tokenColumnMapping[result.symbol]) {
        // Use manual mapping if provided
        columnName = tokenColumnMapping[result.symbol]
      } else {
        // Auto-map: ETH -> eth, USDC -> usdc, WETH -> weth, etc.
        columnName = result.symbol.toLowerCase()
      }

      updates[columnName] = result.balance
    }

    // Step 4: Update database
    if (Object.keys(updates).length > 0) {
      await BotWallet.updateMultipleBalances(walletAddress, updates)

      KatanaLogger.info(PREFIX, `✅ Updated ${Object.keys(updates).length} token balances for wallet ${walletAddress}`)
      KatanaLogger.info(PREFIX, `Balances: ${JSON.stringify(updates)}`)
    } else {
      KatanaLogger.warn(PREFIX, 'No balances to update')
    }

  } catch (error) {
    KatanaLogger.error(PREFIX, `Failed to update wallet balances for ${walletAddress}`, error)
    // Don't throw - balance updates should not break the bot
  }
}

/**
 * Update balances for a specific set of tokens (optimized version)
 * Use this when you only need to update specific tokens instead of all tokens
 *
 * @param provider - Ethereum provider
 * @param walletAddress - Wallet address to update
 * @param tokenSymbols - Array of token symbols to update (e.g., ['USDC', 'WRON'])
 */
export async function updateSpecificTokenBalances(
  provider: ethers.Provider,
  walletAddress: string,
  tokenSymbols: string[]
): Promise<void> {
  try {
    KatanaLogger.info(PREFIX, `Updating specific token balances for wallet ${walletAddress}: ${tokenSymbols.join(', ')}`)

    const updates: Record<string, string> = {}

    for (const symbol of tokenSymbols) {
      try {
        // Get token config
        const tokenConfig = getToken(symbol)

        // Fetch balance
        const balanceWei = await getTokenBalance(
          provider,
          tokenConfig.address,
          walletAddress,
          tokenConfig.isNative || false
        )

        const balanceHuman = fromWei(balanceWei.toString(), tokenConfig.decimals)

        // Determine column name (auto-map to lowercase)
        const columnName = symbol.toLowerCase()

        updates[columnName] = balanceHuman

        KatanaLogger.info(PREFIX, `${symbol}: ${balanceHuman}`)
      } catch (error) {
        KatanaLogger.error(PREFIX, `Failed to fetch balance for ${symbol}`, error)
      }
    }

    // Update database
    if (Object.keys(updates).length > 0) {
      await BotWallet.updateMultipleBalances(walletAddress, updates)
      KatanaLogger.info(PREFIX, `✅ Updated ${Object.keys(updates).length} token balances`)
    }

  } catch (error) {
    KatanaLogger.error(PREFIX, `Failed to update specific token balances for ${walletAddress}`, error)
  }
}

/**
 * Custom token column mapping for the BotWallet table
 * This makes the mapping explicit and easy to modify
 * Note: Mapping is optional since auto-mapping uses symbol.toLowerCase()
 */
export const TOKEN_COLUMN_MAPPING: Record<string, string> = {
  'ETH': 'eth',     // Native ETH on Katana -> eth column
  'USDC': 'usdc',   // USDC -> usdc column
  'WETH': 'weth',   // WETH -> weth column
  'SUSHI': 'sushi'  // SUSHI -> sushi column
}