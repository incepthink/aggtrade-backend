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
import { BOT_CONFIG, TEST_MODE_CONFIG, RATE_LIMIT_CONFIG } from './config'
import { WalletService } from './services/WalletService'
import { BalanceService } from './services/BalanceService'
import { RebalancingService } from './services/RebalancingService'
import { OrderCancellationService } from './services/OrderCancellationService'
import { TOKEN_COLUMN_MAPPING } from '../utils/botBalanceUpdater'
import { DatabaseLogger } from '../../utils/logging/DatabaseLogger'
import BotWallet from '../../models/BotWallet'

const PREFIX = '[SimpleLimitOrderBot]'

// Global lock to prevent concurrent bot runs
let isRunning = false

/**
 * Track last midnight reset to prevent multiple triggers
 */
let lastMidnightReset: string | null = null

/**
 * Track first run after startup to trigger initial reset/rebalance
 */
let isFirstRun = true

/**
 * Check if current time is midnight (00:00:00)
 * Returns true during the midnight hour (00:00 - 00:59)
 */
function isMidnightHour(): boolean {
  const now = new Date()
  return now.getHours() === 0
}

/**
 * Determine if midnight reset should trigger
 * Prevents multiple triggers on the same day
 * Supports test mode via FORCE_MIDNIGHT_RESET environment variable
 */
function shouldTriggerMidnightReset(): boolean {
  // TEST MODE: Force trigger if flag is set
  if (TEST_MODE_CONFIG.forceMidnightReset) {
    KatanaLogger.info(PREFIX, '[TEST MODE] Forcing midnight reset (FORCE_MIDNIGHT_RESET=true)')
    return true
  }

  // PRODUCTION: Check if midnight hour and not already triggered today
  const today = new Date().toISOString().split('T')[0] // YYYY-MM-DD

  if (isMidnightHour() && lastMidnightReset !== today) {
    lastMidnightReset = today
    return true
  }

  return false
}

/**
 * Rebalance all wallets to 50/50 allocation
 * Called during midnight reset
 */
async function rebalanceAllWallets(provider: ethers.Provider, botWallets: any[]): Promise<void> {
  KatanaLogger.info(PREFIX, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  KatanaLogger.info(PREFIX, '   MIDNIGHT RESET: REBALANCING WALLETS')
  KatanaLogger.info(PREFIX, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const results = {
    total: botWallets.length,
    rebalanced: 0,
    skipped: 0,
    failed: 0
  }

  for (let i = 0; i < botWallets.length; i++) {
    const botWalletRecord = botWallets[i]
    const walletNum = i + 1

    try {
      const wallet = WalletService.loadWalletWithSigner(botWalletRecord.wallet_index, provider)

      if (!wallet) {
        KatanaLogger.warn(PREFIX, `[${walletNum}/${botWallets.length}] Skipping wallet ${botWalletRecord.wallet_index} - no private key`)
        results.skipped++
        continue
      }

      wallet.tradingPool = botWalletRecord.trading_pool

      KatanaLogger.info(PREFIX, `[${walletNum}/${botWallets.length}] Rebalancing ${wallet.address.slice(0, 10)}... (${wallet.tradingPool})`)

      const result = await RebalancingService.executeRebalance(
        wallet,
        wallet.index,
        wallet.tradingPool
      )

      if (result.success) {
        if (result.swapAmount) {
          KatanaLogger.info(PREFIX, `[${walletNum}/${botWallets.length}] ✅ Rebalanced: Swapped ${result.swapAmount} ${result.fromToken} → ${result.toToken}`)
          results.rebalanced++
        } else {
          KatanaLogger.info(PREFIX, `[${walletNum}/${botWallets.length}] ✅ Already balanced`)
          results.skipped++
        }
      } else {
        KatanaLogger.error(PREFIX, `[${walletNum}/${botWallets.length}] ❌ Rebalance failed`)
        results.failed++
      }

      // Small delay between wallets
      if (i + 1 < botWallets.length) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }

    } catch (error: any) {
      KatanaLogger.error(PREFIX, `[${walletNum}/${botWallets.length}] ❌ Error during rebalance`, error)
      results.failed++
    }
  }

  KatanaLogger.info(PREFIX, '\nRebalancing Summary:')
  KatanaLogger.info(PREFIX, `  Total wallets: ${results.total}`)
  KatanaLogger.info(PREFIX, `  ✅ Rebalanced: ${results.rebalanced}`)
  KatanaLogger.info(PREFIX, `  ⏭️  Already balanced: ${results.skipped - results.failed}`)
  KatanaLogger.info(PREFIX, `  ❌ Failed: ${results.failed}`)
  KatanaLogger.info(PREFIX, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

/**
 * Reset strategy for all wallets
 * Called after midnight rebalancing to:
 * 1. Cancel all existing orders
 * 2. Reset placed_initial_orders counters
 * 3. Allow normal cycle to place fresh initial orders
 */
async function resetStrategyForAllWallets(botWallets: any[]): Promise<void> {
  KatanaLogger.info(PREFIX, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  KatanaLogger.info(PREFIX, '   MIDNIGHT RESET: STRATEGY RESET')
  KatanaLogger.info(PREFIX, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  // Step 1: Cancel all existing orders (database-level)
  KatanaLogger.info(PREFIX, 'Step 1: Canceling all active orders...')
  const cancellationResult = await OrderCancellationService.cancelAllOrders(botWallets)

  // Step 2: Reset placed_initial_orders counters to 0
  KatanaLogger.info(PREFIX, '\nStep 2: Resetting placed_initial_orders counters...')
  const resetResults = { success: 0, failed: 0 }

  for (let i = 0; i < botWallets.length; i++) {
    const wallet = botWallets[i]
    const walletNum = i + 1

    try {
      await BotWallet.update(
        { placed_initial_orders: 0 },
        { where: { wallet_address: wallet.wallet_address.toLowerCase() } }
      )
      resetResults.success++
      KatanaLogger.info(PREFIX, `[${walletNum}/${botWallets.length}] ✅ Reset counter for wallet ${wallet.wallet_index}`)

    } catch (error: any) {
      resetResults.failed++
      await DatabaseLogger.logError(
        wallet.wallet_index,
        wallet.wallet_address,
        'counter_reset_failed',
        error.message,
        'resetStrategyForAllWallets'
      )
      KatanaLogger.error(PREFIX, `[${walletNum}/${botWallets.length}] ❌ Failed to reset counter for wallet ${wallet.wallet_index}`, error)
      // Continue with next wallet
    }
  }

  // Step 3: Summary
  KatanaLogger.info(PREFIX, '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  KatanaLogger.info(PREFIX, '   RESET SUMMARY')
  KatanaLogger.info(PREFIX, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  KatanaLogger.info(PREFIX, `📋 Orders canceled: ${cancellationResult.canceledCount}/${cancellationResult.totalOrders}`)
  KatanaLogger.info(PREFIX, `🔄 Counters reset: ${resetResults.success}/${botWallets.length}`)
  if (resetResults.failed > 0) {
    KatanaLogger.info(PREFIX, `❌ Failed: ${resetResults.failed}`)
  }
  KatanaLogger.info(PREFIX, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

/**
 * Process a single wallet
 */
async function processWallet(
  wallet: any,
  botWalletRecord: any,
  walletNum: number,
  totalWallets: number,
  walletStartTime: number
): Promise<void> {
  KatanaLogger.info(PREFIX, `Processing Wallet ${walletNum}/${totalWallets}: ${wallet.address.slice(0, 10)}...`)

  try {
    // Sync wallet balances
    await BalanceService.syncBalances(wallet.signer.provider!, wallet.address, wallet.index)

    // Always attempt to place orders - placeInitialOrders will determine if balance allows more
    await placeInitialOrders(wallet, botWalletRecord)

    // After attempting to place initial orders, refresh the record
    const updatedRecord = await WalletService.getWalletRecord(wallet.address)
    if (updatedRecord) {
      botWalletRecord.placed_initial_orders = updatedRecord.placed_initial_orders
    }

    // Check for counter-orders if we have any placed pairs
    if (botWalletRecord.placed_initial_orders > 0) {
      await checkCounterOrders(wallet, botWalletRecord)
    }

    // Record successful cycle metrics
    const cycleTime = Date.now() - walletStartTime
    await DatabaseLogger.recordMetric(wallet.index, wallet.address, 'cycle_time', cycleTime)

  } catch (error: any) {
    // Log error to database
    await DatabaseLogger.logError(
      wallet.index,
      wallet.address,
      'wallet_processing_failed',
      error.message,
      'processWallet'
    )
    KatanaLogger.error(PREFIX, `[${walletNum}/${totalWallets}] Failed to process wallet ${wallet.index}`, error)
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
  if (TEST_MODE_CONFIG.testWalletIndex !== null) {
    KatanaLogger.info(PREFIX, `SINGLE WALLET TEST: Processing only wallet ${TEST_MODE_CONFIG.testWalletIndex}`)
  }
  if (TEST_MODE_CONFIG.singleWalletMode) {
    KatanaLogger.info(PREFIX, 'SINGLE WALLET MODE: Processing only the first wallet')
  }

  try {
    // Initialize blockchain provider
    const provider = new ethers.JsonRpcProvider(BOT_CONFIG.RPC_URL)
    KatanaLogger.info(PREFIX, `Connected to RPC: ${BOT_CONFIG.RPC_URL}`)

    // Load all bot wallets from database (or single wallet if TEST_WALLET_INDEX is set)
    KatanaLogger.info(PREFIX, 'Loading bot wallets from database...')
    let botWallets = await WalletService.getAllWalletRecords(TEST_MODE_CONFIG.testWalletIndex)

    if (botWallets.length === 0) {
      if (TEST_MODE_CONFIG.testWalletIndex !== null) {
        KatanaLogger.warn(PREFIX, `Wallet ${TEST_MODE_CONFIG.testWalletIndex} not found in database!`)
      } else {
        KatanaLogger.warn(PREFIX, 'No bot wallets found in database!')
      }
      return
    }

    // Apply single wallet mode if enabled (takes precedence over all wallets)
    if (TEST_MODE_CONFIG.singleWalletMode && TEST_MODE_CONFIG.testWalletIndex === null) {
      const originalCount = botWallets.length
      botWallets = [botWallets[0]]
      KatanaLogger.info(PREFIX, `Single wallet mode: Filtered ${originalCount} wallets down to first wallet (index ${botWallets[0].wallet_index})`)
    }

    if (TEST_MODE_CONFIG.testWalletIndex !== null) {
      KatanaLogger.info(PREFIX, `Found test wallet ${TEST_MODE_CONFIG.testWalletIndex}: ${botWallets[0].wallet_address}`)
    } else if (TEST_MODE_CONFIG.singleWalletMode) {
      KatanaLogger.info(PREFIX, `Single wallet mode active: ${botWallets[0].wallet_address}`)
    } else {
      KatanaLogger.info(PREFIX, `Found ${botWallets.length} bot wallets`)
    }

    // Check if we should trigger reset/rebalance (on first run OR at midnight)
    const shouldReset = isFirstRun || shouldTriggerMidnightReset()

    if (shouldReset) {
      // Log why we're resetting
      if (isFirstRun) {
        KatanaLogger.info(PREFIX, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        KatanaLogger.info(PREFIX, '   STARTUP RESET: First run after restart')
        KatanaLogger.info(PREFIX, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        isFirstRun = false  // Clear flag after first run
      }

      // Step 1: Rebalance all wallets to 50/50 allocation
      await rebalanceAllWallets(provider, botWallets)

      // Step 2: Reset strategy (cancel orders, reset counters)
      await resetStrategyForAllWallets(botWallets)

      // Step 3: Reload wallet records to get updated counters (placed_initial_orders = 0)
      KatanaLogger.info(PREFIX, 'Reloading wallet records after reset...')
      botWallets = await WalletService.getAllWalletRecords(TEST_MODE_CONFIG.testWalletIndex)

      // Reapply single wallet mode filter if it was enabled
      if (TEST_MODE_CONFIG.singleWalletMode && TEST_MODE_CONFIG.testWalletIndex === null) {
        botWallets = [botWallets[0]]
      }

      KatanaLogger.info(PREFIX, `Reloaded ${botWallets.length} wallet(s) with fresh counters`)

      // Normal cycle continues below - will place fresh initial orders
      KatanaLogger.info(PREFIX, 'Reset complete. Proceeding with normal cycle to place fresh initial orders...\n')
    }

    // Process wallets sequentially with delay between each
    const delayMs = RATE_LIMIT_CONFIG.BATCH_DELAY_MS
    const totalWallets = botWallets.length
    const results: any[] = []

    KatanaLogger.info(PREFIX, `Processing ${totalWallets} wallets sequentially`)
    KatanaLogger.info(PREFIX, `Delay between wallets: ${delayMs}ms`)

    // Process each wallet one at a time
    for (let i = 0; i < botWallets.length; i++) {
      const botWalletRecord = botWallets[i]
      const walletNum = i + 1
      const walletStartTime = Date.now()

      try {
        // Load wallet private key and create signer
        const wallet = WalletService.loadWalletWithSigner(botWalletRecord.wallet_index, provider)

        if (!wallet) {
          KatanaLogger.error(
            PREFIX,
            `[${walletNum}/${totalWallets}] Skipping wallet ${botWalletRecord.wallet_index} - private key not found`
          )
          results.push({ success: false, walletIndex: botWalletRecord.wallet_index, error: 'No private key' })
          continue
        }

        // Verify wallet address matches database
        if (wallet.address.toLowerCase() !== botWalletRecord.wallet_address.toLowerCase()) {
          KatanaLogger.error(
            PREFIX,
            `[${walletNum}/${totalWallets}] Wallet address mismatch! DB: ${botWalletRecord.wallet_address}, Env: ${wallet.address}`
          )
          results.push({ success: false, walletIndex: botWalletRecord.wallet_index, error: 'Address mismatch' })
          continue
        }

        // Add trading pool info from database
        wallet.tradingPool = botWalletRecord.trading_pool

        // Process this wallet
        await processWallet(wallet, botWalletRecord, walletNum, totalWallets, walletStartTime)

        const walletDuration = ((Date.now() - walletStartTime) / 1000).toFixed(2)
        KatanaLogger.info(PREFIX, `[${walletNum}/${totalWallets}] ✅ Completed in ${walletDuration}s`)

        results.push({ success: true, walletIndex: wallet.index, duration: walletDuration })

      } catch (error: any) {
        const walletDuration = ((Date.now() - walletStartTime) / 1000).toFixed(2)
        KatanaLogger.error(
          PREFIX,
          `[${walletNum}/${totalWallets}] ❌ Failed after ${walletDuration}s`,
          error
        )
        results.push({ success: false, walletIndex: botWalletRecord.wallet_index, error: error?.message })
      }

      // Add delay between wallets (except last wallet) to prevent RPC rate limiting
      if (i + 1 < botWallets.length) {
        KatanaLogger.info(PREFIX, `Waiting ${delayMs}ms before next wallet...`)
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }

    // Calculate statistics
    const successful = results.filter((r) => r.success).length
    const failed = results.filter((r) => !r.success).length
    const avgDuration = successful > 0
      ? (results.filter((r) => r.success && r.duration).reduce((sum, r) => sum + parseFloat(r.duration), 0) / successful).toFixed(2)
      : '0.00'

    KatanaLogger.info(PREFIX, `\nSequential processing complete:`)
    KatanaLogger.info(PREFIX, `  ✅ Successful: ${successful}/${totalWallets}`)
    KatanaLogger.info(PREFIX, `  ❌ Failed: ${failed}/${totalWallets}`)
    if (successful > 0) {
      KatanaLogger.info(PREFIX, `  ⏱️  Average duration per wallet: ${avgDuration}s`)
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
    const intervalStr = TEST_MODE_CONFIG.enabled
      ? `${TEST_MODE_CONFIG.intervalSeconds} seconds`
      : `${BOT_CONFIG.CRON_INTERVAL_MINUTES} minutes`
    KatanaLogger.info(PREFIX, `Next run in ${intervalStr}\n\n`)

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
 * Start the cron job with 5-minute interval (or 10 seconds in test mode)
 * Uses setTimeout instead of setInterval to ensure runs don't overlap
 */
export function startSimpleLimitOrderBotCron(): void {
  if (TEST_MODE_CONFIG.enabled) {
    KatanaLogger.info(PREFIX, 'Starting Simple Limit Order Bot in TEST MODE')
    KatanaLogger.info(PREFIX, `Test mode interval: Every ${TEST_MODE_CONFIG.intervalSeconds} seconds`)
    KatanaLogger.info(PREFIX, 'Orders will be SIMULATED, not placed on blockchain')
  } else {
    KatanaLogger.info(PREFIX, 'Starting Simple Limit Order Bot cron job')
    KatanaLogger.info(PREFIX, `Interval: Every ${BOT_CONFIG.CRON_INTERVAL_MINUTES} minutes`)
    KatanaLogger.info(PREFIX, `Processing: Sequential (one wallet at a time), ${RATE_LIMIT_CONFIG.BATCH_DELAY_MS}ms delay between wallets`)
  }

  if (TEST_MODE_CONFIG.testWalletIndex !== null) {
    KatanaLogger.info(PREFIX, `🔬 SINGLE WALLET TEST MODE: Only wallet ${TEST_MODE_CONFIG.testWalletIndex} will be processed`)
  }

  if (TEST_MODE_CONFIG.singleWalletMode) {
    KatanaLogger.info(PREFIX, '🎯 SINGLE WALLET MODE: Only the first wallet will be processed')
  }

  if (TEST_MODE_CONFIG.forceMidnightReset) {
    KatanaLogger.info(PREFIX, '⏰ FORCE MIDNIGHT RESET: Reset and rebalance will trigger on every cycle')
  }

  KatanaLogger.info(PREFIX, '🔄 STARTUP RESET: Reset and rebalance will trigger on first cycle')

  if (TEST_MODE_CONFIG.orderPairCap !== null) {
    KatanaLogger.info(PREFIX, `📊 ORDER_PAIR_CAP: Maximum ${TEST_MODE_CONFIG.orderPairCap} pair(s) per wallet`)
  }

  const intervalMs = TEST_MODE_CONFIG.enabled
    ? TEST_MODE_CONFIG.intervalSeconds * 1000
    : BOT_CONFIG.CRON_INTERVAL_MINUTES * 60 * 1000  // Use minutes instead of hours

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
