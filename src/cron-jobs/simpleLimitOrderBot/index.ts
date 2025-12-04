/**
 * =============================================================================
 * SIMPLE LIMIT ORDER BOT - CRON JOB
 * =============================================================================
 *
 * This bot runs every 4 hours and does the following:
 * 1. Loads all wallets from BotWallet table
 * 2. For each wallet:
 *    - If no initial orders: Place 5 buy + 5 sell order pairs
 *    - If has orders: Check status and place counter-orders for filled ones
 *
 * Key Features:
 * - Simple 2-table design (BotWallet + BotOrdersSimple)
 * - Atomic buy-sell pairs (both constructed before sending to blockchain)
 * - Tracks placed_initial_orders to know when grid is complete
 *
 * =============================================================================
 */

import { ethers } from 'ethers'
import BotWallet from '../../models/BotWallet'
import BotOrdersSimple from '../../models/BotOrdersSimple'
import { KatanaLogger } from '../../utils/logger'
import { placeInitialOrders } from './placeInitialOrders'
import { checkCounterOrders } from './checkCounterOrders'
import { updateWalletBalances, TOKEN_COLUMN_MAPPING } from '../utils/botBalanceUpdater'

const PREFIX = '[SimpleLimitOrderBot]'

// Bot configuration
const RPC_URL = 'https://rpc.katana.network' // Katana blockchain RPC
const CRON_INTERVAL_HOURS = 4 // Run every 4 hours

// Test mode configuration
export const TEST_MODE_CONFIG = {
  enabled: process.env.BOT_TEST_MODE === 'true', // Enable via BOT_TEST_MODE=true in .env
  intervalSeconds: 10, // Run every 10 seconds in test mode (instead of 4 hours)
  simulatedOrders: new Map<string, any[]>() // In-memory store for simulated orders
}

/**
 * Wallet structure with ethers signer
 */
interface WalletWithSigner {
  address: string
  index: number
  signer: ethers.Wallet
  tradingPool: string
}

/**
 * Load wallet private key from environment and create signer
 *
 * Environment variables should be named: WALLET_1, WALLET_2, etc.
 */
function loadWalletWithSigner(
  walletIndex: number,
  provider: ethers.Provider
): WalletWithSigner | null {
  const envKey = `WALLET_${walletIndex}`
  const privateKey = process.env[envKey]

  if (!privateKey) {
    KatanaLogger.warn(PREFIX, `${envKey} not found in environment`)
    return null
  }

  try {
    const wallet = new ethers.Wallet(privateKey, provider)

    return {
      address: wallet.address,
      index: walletIndex,
      signer: wallet,
      tradingPool: '' // Will be populated from database
    }
  } catch (error) {
    KatanaLogger.error(PREFIX, `Failed to load ${envKey}`, error)
    return null
  }
}

/**
 * Process a single wallet:
 * - Check if initial orders are complete
 * - If not: Place initial order pairs
 * - If yes: Check existing orders and place counter-orders
 */
async function processWallet(
  wallet: WalletWithSigner,
  botWalletRecord: any
): Promise<void> {
  KatanaLogger.info(PREFIX, `\n${'='.repeat(70)}`)
  KatanaLogger.info(PREFIX, `Processing Wallet ${wallet.index}: ${wallet.address}`)
  KatanaLogger.info(PREFIX, `${'='.repeat(70)}`)

  try {
    // Step 0: Update wallet balances at the start of processing
    KatanaLogger.info(PREFIX, 'Syncing wallet balances...')
    await updateWalletBalances(wallet.signer.provider!, wallet.address, TOKEN_COLUMN_MAPPING)

    // Step 1: Check if initial orders are complete
    const placedInitialOrders = botWalletRecord.placed_initial_orders
    KatanaLogger.info(PREFIX, `Initial orders placed: ${placedInitialOrders}/5`)

    if (placedInitialOrders < 5) {
      // Step 2a: Place remaining initial order pairs
      KatanaLogger.info(PREFIX, 'Placing initial order pairs...')
      await placeInitialOrders(wallet, botWalletRecord)

    } else {
      // Step 2b: Check existing orders and place counter-orders
      KatanaLogger.info(PREFIX, 'Initial orders complete. Checking order status...')
      await checkCounterOrders(wallet, botWalletRecord)
    }

    KatanaLogger.info(PREFIX, ` Wallet ${wallet.index} processed successfully`)

  } catch (error) {
    KatanaLogger.error(PREFIX, `L Failed to process wallet ${wallet.index}`, error)
    // Continue with next wallet even if this one fails
  }
}

/**
 * Main cron job function - processes all wallets sequentially
 */
export async function runSimpleLimitOrderBot(): Promise<void> {
  const startTime = Date.now()

  KatanaLogger.info(PREFIX, '\n\n')
  KatanaLogger.info(PREFIX, 'TPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPW')
  KatanaLogger.info(PREFIX, `Q          SIMPLE LIMIT ORDER BOT - STARTING CYCLE ${TEST_MODE_CONFIG.enabled ? '[TEST MODE]' : ''}             Q`)
  KatanaLogger.info(PREFIX, 'ZPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP]')
  KatanaLogger.info(PREFIX, `Started at: ${new Date().toISOString()}`)
  if (TEST_MODE_CONFIG.enabled) {
    KatanaLogger.info(PREFIX, '⚠️  TEST MODE ENABLED - Orders will be simulated, not placed on blockchain')
  }

  try {
    // Step 1: Initialize blockchain provider
    const provider = new ethers.JsonRpcProvider(RPC_URL)
    KatanaLogger.info(PREFIX, `Connected to RPC: ${RPC_URL}`)

    // Step 2: Load all bot wallets from database
    KatanaLogger.info(PREFIX, 'Loading bot wallets from database...')
    const botWallets = await BotWallet.getAllWallets()

    if (botWallets.length === 0) {
      KatanaLogger.warn(PREFIX, 'No bot wallets found in database!')
      return
    }

    KatanaLogger.info(PREFIX, `Found ${botWallets.length} bot wallets`)

    // Step 3: Process each wallet sequentially
    for (const botWalletRecord of botWallets) {
      // Load wallet private key and create signer
      const wallet = loadWalletWithSigner(botWalletRecord.wallet_index, provider)

      if (!wallet) {
        KatanaLogger.error(
          PREFIX,
          `Skipping wallet ${botWalletRecord.wallet_index} - private key not found`
        )
        continue
      }

      // Verify wallet address matches database
      if (wallet.address.toLowerCase() !== botWalletRecord.wallet_address.toLowerCase()) {
        KatanaLogger.error(
          PREFIX,
          `Wallet address mismatch! Database: ${botWalletRecord.wallet_address}, ` +
          `Environment: ${wallet.address}`
        )
        continue
      }

      // Add trading pool info from database
      wallet.tradingPool = botWalletRecord.trading_pool

      // Process this wallet
      await processWallet(wallet, botWalletRecord)

      // Small delay between wallets to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000)) // 2 second delay
    }

    // Step 4: Summary
    const endTime = Date.now()
    const durationSeconds = ((endTime - startTime) / 1000).toFixed(2)

    KatanaLogger.info(PREFIX, '\n')
    KatanaLogger.info(PREFIX, 'TPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPW')
    KatanaLogger.info(PREFIX, 'Q          SIMPLE LIMIT ORDER BOT - CYCLE COMPLETE              Q')
    KatanaLogger.info(PREFIX, 'ZPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP]')
    KatanaLogger.info(PREFIX, `Completed at: ${new Date().toISOString()}`)
    KatanaLogger.info(PREFIX, `Duration: ${durationSeconds} seconds`)
    KatanaLogger.info(PREFIX, `Processed ${botWallets.length} wallets`)
    KatanaLogger.info(PREFIX, `Next run in ${CRON_INTERVAL_HOURS} hours\n\n`)

  } catch (error) {
    KatanaLogger.error(PREFIX, 'Bot cycle failed', error)
    throw error
  }
}

/**
 * Start the cron job with 4-hour interval (or 10 seconds in test mode)
 * Can be called from main cron-jobs/index.ts
 */
export function startSimpleLimitOrderBotCron(): void {
  if (TEST_MODE_CONFIG.enabled) {
    KatanaLogger.info(PREFIX, '⚠️  Starting Simple Limit Order Bot in TEST MODE')
    KatanaLogger.info(PREFIX, `⚠️  Test mode interval: Every ${TEST_MODE_CONFIG.intervalSeconds} seconds (back-to-back execution)`)
    KatanaLogger.info(PREFIX, '⚠️  Orders will be SIMULATED, not placed on blockchain')
  } else {
    KatanaLogger.info(PREFIX, 'Starting Simple Limit Order Bot cron job')
    KatanaLogger.info(PREFIX, `Interval: Every ${CRON_INTERVAL_HOURS} hours`)
  }

  // Run immediately on startup
  runSimpleLimitOrderBot().catch((error) => {
    KatanaLogger.error(PREFIX, 'Initial run failed', error)
  })

  // Then run at configured interval
  const intervalMs = TEST_MODE_CONFIG.enabled
    ? TEST_MODE_CONFIG.intervalSeconds * 1000
    : CRON_INTERVAL_HOURS * 60 * 60 * 1000

  setInterval(() => {
    runSimpleLimitOrderBot().catch((error) => {
      KatanaLogger.error(PREFIX, 'Scheduled run failed', error)
    })
  }, intervalMs)

  KatanaLogger.info(PREFIX, 'Cron job started successfully')
}

startSimpleLimitOrderBotCron()
