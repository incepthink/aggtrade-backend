/**
 * Simple Limit Order Bot - Cron Job
 *
 * Runs every 4 hours to manage limit orders:
 * 1. Load all wallets from BotWallet table
 * 2. For each wallet:
 *    - If no initial orders: Place 5 buy + 5 sell order pairs
 *    - If has orders: Check status and place counter-orders for filled ones
 */

import { ethers } from 'ethers'
import { KatanaLogger } from '../../utils/logger'
import { placeInitialOrders } from './placeInitialOrders'
import { checkCounterOrders } from './checkCounterOrders'
import { BOT_CONFIG, TEST_MODE_CONFIG } from './config'
import { WalletService } from './services/WalletService'
import { BalanceService } from './services/BalanceService'
import { TOKEN_COLUMN_MAPPING } from '../utils/botBalanceUpdater'

const PREFIX = '[SimpleLimitOrderBot]'

// Global lock to prevent concurrent bot runs
let isRunning = false

/**
 * Process a single wallet
 */
async function processWallet(
  wallet: any,
  botWalletRecord: any
): Promise<void> {
  KatanaLogger.info(PREFIX, `\n${'='.repeat(70)}`)
  KatanaLogger.info(PREFIX, `Processing Wallet ${wallet.index}: ${wallet.address}`)
  KatanaLogger.info(PREFIX, `${'='.repeat(70)}`)

  try {
    // Sync wallet balances
    KatanaLogger.info(PREFIX, 'Syncing wallet balances...')
    await BalanceService.syncBalances(wallet.signer.provider!, wallet.address)

    // Check if initial orders are complete
    const placedInitialOrders = botWalletRecord.placed_initial_orders
    KatanaLogger.info(PREFIX, `Initial orders placed: ${placedInitialOrders}/5`)

    if (placedInitialOrders < 5) {
      // Place remaining initial order pairs
      KatanaLogger.info(PREFIX, 'Placing initial order pairs...')
      await placeInitialOrders(wallet, botWalletRecord)

      // After attempting to place initial orders, refresh the record
      const updatedRecord = await WalletService.getWalletRecord(wallet.address)
      if (updatedRecord) {
        botWalletRecord.placed_initial_orders = updatedRecord.placed_initial_orders
      }
    }

    // Always check for counter-orders if we have any placed pairs
    // This ensures that even if not all 5 pairs are complete,
    // we can still place counter orders for filled orders from complete pairs
    if (botWalletRecord.placed_initial_orders > 0) {
      KatanaLogger.info(PREFIX, 'Checking order status and placing counter-orders...')
      await checkCounterOrders(wallet, botWalletRecord)
    }

    KatanaLogger.info(PREFIX, `Wallet ${wallet.index} processed successfully`)

  } catch (error) {
    KatanaLogger.error(PREFIX, `Failed to process wallet ${wallet.index}`, error)
    // Continue with next wallet even if this one fails
  }
}

/**
 * Main cron job function - processes all wallets sequentially
 */
export async function runSimpleLimitOrderBot(): Promise<void> {
  // Prevent concurrent runs with immediate check and set
  if (isRunning) {
    KatanaLogger.warn(PREFIX, 'Bot already running. Skipping to prevent race conditions.')
    return
  }

  // Set lock immediately to prevent any race conditions
  isRunning = true

  const startTime = Date.now()

  KatanaLogger.info(PREFIX, '\n\n')
  KatanaLogger.info(PREFIX, 'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP')
  KatanaLogger.info(PREFIX, `Q   SIMPLE LIMIT ORDER BOT - STARTING CYCLE ${TEST_MODE_CONFIG.enabled ? '[TEST MODE]' : ''}   Q`)
  KatanaLogger.info(PREFIX, 'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP')
  KatanaLogger.info(PREFIX, `Started at: ${new Date().toISOString()}`)
  if (TEST_MODE_CONFIG.enabled) {
    KatanaLogger.info(PREFIX, 'TEST MODE: Orders will be simulated, not placed on blockchain')
  }

  try {
    // Initialize blockchain provider
    const provider = new ethers.JsonRpcProvider(BOT_CONFIG.RPC_URL)
    KatanaLogger.info(PREFIX, `Connected to RPC: ${BOT_CONFIG.RPC_URL}`)

    // Load all bot wallets from database
    KatanaLogger.info(PREFIX, 'Loading bot wallets from database...')
    const botWallets = await WalletService.getAllWalletRecords()

    if (botWallets.length === 0) {
      KatanaLogger.warn(PREFIX, 'No bot wallets found in database!')
      return
    }

    KatanaLogger.info(PREFIX, `Found ${botWallets.length} bot wallets`)

    // Process each wallet sequentially
    for (const botWalletRecord of botWallets) {
      // Load wallet private key and create signer
      const wallet = WalletService.loadWalletWithSigner(botWalletRecord.wallet_index, provider)

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
          `Wallet address mismatch! DB: ${botWalletRecord.wallet_address}, Env: ${wallet.address}`
        )
        continue
      }

      // Add trading pool info from database
      wallet.tradingPool = botWalletRecord.trading_pool

      // Process this wallet
      await processWallet(wallet, botWalletRecord)

      // Small delay between wallets to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000))
    }

    // Summary
    const endTime = Date.now()
    const durationSeconds = ((endTime - startTime) / 1000).toFixed(2)

    KatanaLogger.info(PREFIX, '\n')
    KatanaLogger.info(PREFIX, 'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP')
    KatanaLogger.info(PREFIX, 'Q   SIMPLE LIMIT ORDER BOT - CYCLE COMPLETE   Q')
    KatanaLogger.info(PREFIX, 'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP')
    KatanaLogger.info(PREFIX, `Completed at: ${new Date().toISOString()}`)
    KatanaLogger.info(PREFIX, `Duration: ${durationSeconds} seconds`)
    KatanaLogger.info(PREFIX, `Processed ${botWallets.length} wallets`)
    KatanaLogger.info(PREFIX, `Next run in ${BOT_CONFIG.CRON_INTERVAL_HOURS} hours\n\n`)

  } catch (error) {
    KatanaLogger.error(PREFIX, 'Bot cycle failed', error)
    throw error
  } finally {
    // Always release the lock
    isRunning = false
    KatanaLogger.info(PREFIX, 'Bot lock released. Ready for next cycle.')
  }
}

/**
 * Start the cron job with 4-hour interval (or 10 seconds in test mode)
 * Uses setTimeout instead of setInterval to ensure runs don't overlap
 */
export function startSimpleLimitOrderBotCron(): void {
  if (TEST_MODE_CONFIG.enabled) {
    KatanaLogger.info(PREFIX, 'Starting Simple Limit Order Bot in TEST MODE')
    KatanaLogger.info(PREFIX, `Test mode interval: Every ${TEST_MODE_CONFIG.intervalSeconds} seconds`)
    KatanaLogger.info(PREFIX, 'Orders will be SIMULATED, not placed on blockchain')
  } else {
    KatanaLogger.info(PREFIX, 'Starting Simple Limit Order Bot cron job')
    KatanaLogger.info(PREFIX, `Interval: Every ${BOT_CONFIG.CRON_INTERVAL_HOURS} hours`)
  }

  const intervalMs = TEST_MODE_CONFIG.enabled
    ? TEST_MODE_CONFIG.intervalSeconds * 1000
    : BOT_CONFIG.CRON_INTERVAL_HOURS * 60 * 60 * 1000

  // Recursive function to schedule next run after current one completes
  const scheduleNextRun = async () => {
    try {
      await runSimpleLimitOrderBot()
    } catch (error) {
      KatanaLogger.error(PREFIX, 'Bot run failed', error)
    } finally {
      // Schedule next run only after this one completes
      setTimeout(scheduleNextRun, intervalMs)
    }
  }

  // Start the first run
  KatanaLogger.info(PREFIX, 'Cron job started successfully')
  scheduleNextRun()
}

startSimpleLimitOrderBotCron()
