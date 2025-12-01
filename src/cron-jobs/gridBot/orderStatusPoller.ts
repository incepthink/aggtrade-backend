import { BotWallet, OrderStatusUpdate } from './types'
import {TwapService, type TwapOrder} from '../../services/twap'
import { getPendingOrders, syncOrderStatus } from './databaseSync'
import { KatanaLogger } from '../../utils/logger'
import { sleep } from '../utils/botHelpers'

const PREFIX = '[OrderStatusPoller]'

/**
 * Poll blockchain for order status updates with retry
 */
export async function pollOrderStatus(
  wallet: BotWallet,
  executionId: string,
  maxRetries: number = 3
): Promise<OrderStatusUpdate[]> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await _pollOrderStatusInternal(wallet, executionId)
    } catch (error) {
      if (attempt === maxRetries) {
        KatanaLogger.error(PREFIX, 
          `[Wallet ${wallet.index}] All ${maxRetries} poll attempts exhausted`,
          error
        )
        return [] // Return empty array, will retry next cycle
      }

      // Exponential backoff
      const backoffMs = 1000 * Math.pow(2, attempt)
      KatanaLogger.warn(PREFIX, 
        `[Wallet ${wallet.index}] Poll attempt ${attempt} failed, retrying in ${backoffMs}ms...`
      )
      await sleep(backoffMs)
    }
  }

  return []
}

/**
 * Internal polling logic
 */
async function _pollOrderStatusInternal(
  wallet: BotWallet,
  executionId: string
): Promise<OrderStatusUpdate[]> {
  const updates: OrderStatusUpdate[] = []

  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Polling order status for ${wallet.address}`)

  // 1. Fetch all orders from blockchain
  const blockchainOrders = await TwapService.fetchLimitOrders(wallet.address)

  KatanaLogger.info(PREFIX, 
    `[Wallet ${wallet.index}] Blockchain orders: ${blockchainOrders.OPEN.length} OPEN, ` +
    `${blockchainOrders.COMPLETED.length} COMPLETED, ${blockchainOrders.EXPIRED.length} EXPIRED, ` +
    `${blockchainOrders.CANCELED.length} CANCELED`
  )

  // 2. Fetch pending/partial orders from database
  const dbOrders = await getPendingOrders(wallet.address, executionId)

  if (dbOrders.length === 0) {
    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] No pending orders in database`)
    return updates
  }

  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Database pending orders: ${dbOrders.length}`)

  // 3. Match and detect changes
  for (const dbOrder of dbOrders) {
    try {
      // Find blockchain order by blockchain_order_id (preferred) or tx_hash (fallback)
      let blockchainOrder: TwapOrder | undefined

      if (dbOrder.blockchain_order_id) {
        blockchainOrder = blockchainOrders.ALL.find(
          (o: TwapOrder) => o.id === dbOrder.blockchain_order_id
        )
      }

      // Fallback to tx_hash matching
      if (!blockchainOrder) {
        blockchainOrder = blockchainOrders.ALL.find(
          (o: TwapOrder) => o.txHash === dbOrder.tx_hash
        )

        if (blockchainOrder) {
          KatanaLogger.warn(PREFIX, 
            `[Wallet ${wallet.index}] Matched order ${dbOrder.order_id} by tx_hash (blockchain_order_id missing)`
          )
        }
      }

      if (!blockchainOrder) {
        KatanaLogger.warn(PREFIX, 
          `[Wallet ${wallet.index}] Could not find blockchain order for ${dbOrder.order_id}`
        )
        continue
      }

      // 4. Detect status changes
      const newStatus = mapBlockchainStatus(blockchainOrder.status, blockchainOrder.progress)

      if (newStatus !== dbOrder.status) {
        KatanaLogger.info(PREFIX, 
          `[Wallet ${wallet.index}] Status change detected: ${dbOrder.order_id} ` +
          `${dbOrder.status} -> ${newStatus} (${blockchainOrder.progress}%)`
        )

        // Sync to database
        await syncOrderStatus(dbOrder, blockchainOrder, newStatus)

        // Add to updates list
        updates.push({
          dbOrderId: dbOrder.id,
          blockchainOrderId: blockchainOrder.id,
          oldStatus: dbOrder.status,
          newStatus,
          progress: blockchainOrder.progress,
          filledSrcAmount: blockchainOrder.filledSrcAmount,
          filledDstAmount: blockchainOrder.filledDstAmount
        })
      } else if (blockchainOrder.progress !== dbOrder.progress) {
        // Progress changed but status same (partial fill progress update)
        KatanaLogger.info(PREFIX, 
          `[Wallet ${wallet.index}] Progress update: ${dbOrder.order_id} ` +
          `${dbOrder.progress}% -> ${blockchainOrder.progress}%`
        )

        await syncOrderStatus(dbOrder, blockchainOrder, dbOrder.status)
      }
    } catch (error) {
      KatanaLogger.error(PREFIX, 
        `[Wallet ${wallet.index}] Failed to process order ${dbOrder.order_id}`,
        error
      )
    }
  }

  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Poll complete: ${updates.length} status changes detected`)

  return updates
}

/**
 * Map blockchain order status to database status
 */
function mapBlockchainStatus(blockchainStatus: string, progress: number): 'pending' | 'partial' | 'filled' | 'canceled' | 'expired' {
  switch (blockchainStatus) {
    case 'Open':
      if (progress === 100) return 'filled'
      return progress > 0 && progress < 100 ? 'partial' : 'pending'
    case 'Completed':
      return 'filled'
    case 'Canceled':
      return 'canceled'
    case 'Expired':
      return 'expired'
    default:
      return 'pending'
  }
}

/**
 * Check if order is fully filled (100% complete)
 */
export function isOrderFullyFilled(update: OrderStatusUpdate): boolean {
  return update.newStatus === 'filled' && update.progress === 100
}

/**
 * Filter updates for fully filled orders only
 */
export function getFullyFilledOrders(updates: OrderStatusUpdate[]): OrderStatusUpdate[] {
  return updates.filter(isOrderFullyFilled)
}
