import { BotWallet } from './types'
import { pollOrderStatus, getFullyFilledOrders } from './orderStatusPoller'
import { processFilledOrders } from './counterOrderManager'
import { placeGrid } from './gridManager'
import { KatanaLogger } from '../../utils/logger'

const PREFIX = '[WalletMonitor]'

const POLL_INTERVAL_MS = 2.5 * 60 * 1000 // 2.5 minutes (balanced between 2-3 min)

/**
 * Start monitoring loop for a single wallet
 */
export async function startWalletMonitor(
  wallet: BotWallet,
  executionId: string
): Promise<void> {
  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Starting wallet monitor for ${wallet.address}`)

  try {
    // 1. Place initial grid (if not already placed)
    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Placing initial grid...`)
    const gridResult = await placeGrid(wallet, executionId)

    if (gridResult.success) {
      KatanaLogger.info(PREFIX, 
        `[Wallet ${wallet.index}] ✅ Grid placed: ${gridResult.buyOrders} BUY + ${gridResult.sellOrders} SELL = ${gridResult.totalOrders} total`
      )
    } else if (gridResult.totalOrders === 0) {
      KatanaLogger.error(PREFIX, 
        `[Wallet ${wallet.index}] ❌ Grid placement failed: ${gridResult.errors.join(', ')}`
      )
      // Don't start monitoring if grid couldn't be placed
      return
    } else {
      KatanaLogger.warn(PREFIX, 
        `[Wallet ${wallet.index}] ⚠️ Grid placement partial: ${gridResult.totalOrders} orders placed with errors`
      )
    }

    // 2. Start monitoring loop
    KatanaLogger.info(PREFIX, 
      `[Wallet ${wallet.index}] Starting monitoring loop (polling every ${POLL_INTERVAL_MS / 1000}s)`
    )

    // Run immediately once, then on interval
    await monitoringCycle(wallet, executionId)

    setInterval(async () => {
      try {
        await monitoringCycle(wallet, executionId)
      } catch (error) {
        KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] Monitoring cycle error`, error)
        // Don't crash the interval - keep monitoring
      }
    }, POLL_INTERVAL_MS)
  } catch (error) {
    KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] Failed to start wallet monitor`, error)
    throw error
  }
}

/**
 * Single monitoring cycle: poll status, process fills, place counter-orders
 */
async function monitoringCycle(wallet: BotWallet, executionId: string): Promise<void> {
  const cycleStart = Date.now()
  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] === Monitoring Cycle Start ===`)

  try {
    // 1. Poll order status from blockchain
    const statusUpdates = await pollOrderStatus(wallet, executionId)

    if (statusUpdates.length === 0) {
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] No status changes detected`)
      return
    }

    KatanaLogger.info(PREFIX, 
      `[Wallet ${wallet.index}] Status updates detected: ${statusUpdates.length}`
    )

    // 2. Filter for fully filled orders (100% complete)
    const filledOrders = getFullyFilledOrders(statusUpdates)

    if (filledOrders.length === 0) {
      KatanaLogger.info(PREFIX, 
        `[Wallet ${wallet.index}] Status changes detected but no 100% fills (only progress updates or expirations)`
      )
      return
    }

    KatanaLogger.info(PREFIX, 
      `[Wallet ${wallet.index}] 🎯 Fully filled orders: ${filledOrders.length}`
    )

    // 3. Process filled orders and place counter-orders
    await processFilledOrders(filledOrders, wallet, executionId)

    const cycleEnd = Date.now()
    const cycleDuration = ((cycleEnd - cycleStart) / 1000).toFixed(2)

    KatanaLogger.info(PREFIX, 
      `[Wallet ${wallet.index}] === Monitoring Cycle Complete (${cycleDuration}s) ===`
    )
  } catch (error) {
    KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] Monitoring cycle failed`, error)
    // Don't throw - let the interval continue
  }
}

/**
 * Get monitoring interval in milliseconds
 */
export function getMonitoringInterval(): number {
  return POLL_INTERVAL_MS
}
