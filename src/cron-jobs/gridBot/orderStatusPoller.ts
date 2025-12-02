import { BotWallet, OrderStatusUpdate } from './types'
import {TwapService, type TwapOrder} from '../../services/twap'
import { OrderStatus } from '@orbs-network/twap-sdk'
import { getPendingOrders, syncOrderStatus } from './databaseSync'
import { KatanaLogger } from '../../utils/logger'
import { sleep } from '../utils/botHelpers'
import { getGridConfig } from './gridManager'

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
  const gridConfig = getGridConfig()

  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Polling order status for ${wallet.address}`)

  // 2. Fetch pending/partial orders from database
  const dbOrders = await getPendingOrders(wallet.address, executionId)

  if (dbOrders.length === 0) {
    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] No pending orders in database`)
    return updates
  }

  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Database pending orders: ${dbOrders.length}`)

  // ========== TESTING MODE: Auto-mark all pending orders as filled ==========
  if (gridConfig.TESTING_MODE) {
    KatanaLogger.warn(PREFIX, `[TEST MODE] [Wallet ${wallet.index}] Auto-marking ${dbOrders.length} pending orders as filled`)

    for (const dbOrder of dbOrders) {
      try {
        // Create mock filled order data
        const mockBlockchainOrder: TwapOrder = {
          id: dbOrder.blockchain_order_id || Math.floor(Math.random() * 100000),
          maker: wallet.address,
          srcTokenAddress: dbOrder.src_token_address,
          dstTokenAddress: dbOrder.dst_token_address,
          srcAmount: dbOrder.src_amount,
          srcAmountPerChunk: dbOrder.src_amount,
          dstMinAmountPerChunk: dbOrder.dst_min_amount,
          filledSrcAmount: dbOrder.src_amount, // 100% filled
          filledDstAmount: dbOrder.dst_min_amount, // Use minimum expected
          chunks: 1,
          createdAt: new Date(dbOrder.placed_at).getTime(),
          deadline: dbOrder.deadline,
          fillDelay: 180000, // 3 minutes in ms
          txHash: dbOrder.tx_hash,
          status: OrderStatus.Completed,
          fillDelayMs: 180000,
          progress: 100
        }

        const newStatus = 'filled'

        KatanaLogger.info(PREFIX,
          `[TEST MODE] [Wallet ${wallet.index}] Marking order ${dbOrder.order_id} as filled (100%)`
        )

        // Sync to database
        await syncOrderStatus(dbOrder, mockBlockchainOrder, newStatus)

        // Add to updates list
        updates.push({
          dbOrderId: dbOrder.id,
          blockchainOrderId: mockBlockchainOrder.id,
          oldStatus: dbOrder.status,
          newStatus,
          progress: 100,
          filledSrcAmount: mockBlockchainOrder.filledSrcAmount,
          filledDstAmount: mockBlockchainOrder.filledDstAmount
        })

        KatanaLogger.info(PREFIX,
          `[TEST MODE] [Wallet ${wallet.index}] Order ${dbOrder.order_id} successfully marked as filled`
        )
      } catch (error) {
        KatanaLogger.error(PREFIX,
          `[TEST MODE] [Wallet ${wallet.index}] Failed to mark order ${dbOrder.order_id} as filled`,
          error
        )
      }
    }

    KatanaLogger.info(PREFIX, `[TEST MODE] [Wallet ${wallet.index}] Poll complete: ${updates.length} orders marked as filled`)
    return updates
  }

  // ========== PRODUCTION MODE: Fetch from blockchain ==========

  // 1. Fetch all orders from blockchain
  const blockchainOrders = await TwapService.fetchLimitOrders(wallet.address)

  KatanaLogger.info(PREFIX,
    `[Wallet ${wallet.index}] Blockchain orders: ${blockchainOrders.OPEN.length} OPEN, ` +
    `${blockchainOrders.COMPLETED.length} COMPLETED, ${blockchainOrders.EXPIRED.length} EXPIRED, ` +
    `${blockchainOrders.CANCELED.length} CANCELED`
  )

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
