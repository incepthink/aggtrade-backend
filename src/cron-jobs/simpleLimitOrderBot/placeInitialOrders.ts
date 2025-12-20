/**
 * Initial Order Placement Module
 * Places initial grid orders (5 buy-sell pairs)
 */

import { getToken } from '../gridBot/tokenPairs.config'
import { getCurrentTokenPrice } from '../gridBot/priceManager'
import { KatanaLogger } from '../../utils/logger'
import { getGridConfigForPair, STRATEGY_RESTART_CONFIG } from './config'
import { WalletService, type WalletWithSigner } from './services/WalletService'
import { BalanceService } from './services/BalanceService'
import { OrderConstructionService } from './services/OrderConstructionService'
import { OrderExecutionService } from './services/OrderExecutionService'
import BotOrdersSimple from '../../models/BotOrdersSimple'
import { TwapService } from '../../services/twap'
import { Op } from 'sequelize'

const PREFIX = '[PlaceInitialOrders]'

/**
 * Verify no blockchain duplicates exist
 */
async function verifyNoBlockchainDuplicates(
  wallet: WalletWithSigner,
  pairIndex: number
): Promise<boolean> {
  try {
    KatanaLogger.info(PREFIX, `Safety check for pair ${pairIndex + 1}...`)

    // Build query conditions
    const whereConditions: any = {
      wallet_address: wallet.address.toLowerCase(),
      order_type: ['grid_buy', 'grid_sell']
    }

    // If this wallet needs to restart strategy, only count orders after cutoff
    if (STRATEGY_RESTART_CONFIG.shouldFilterOldOrders(wallet.index)) {
      whereConditions.placed_at = {
        [Op.gte]: STRATEGY_RESTART_CONFIG.cutoffDate
      }
    }

    const dbOrders = await BotOrdersSimple.findAll({
      where: whereConditions
    })

    const expectedOrderCount = pairIndex * 2
    const actualDbOrderCount = dbOrders.length

    KatanaLogger.info(PREFIX, `DB orders: ${actualDbOrderCount}, Expected: ${expectedOrderCount}`)

    if (actualDbOrderCount > expectedOrderCount) {
      KatanaLogger.error(PREFIX, `Duplicate detected! ${actualDbOrderCount} > ${expectedOrderCount}`)
      return false
    }

    if (true) {
      KatanaLogger.info(PREFIX, `Safety check passed`)
      return true
    }

    KatanaLogger.error(PREFIX, `Safety check failed: count mismatch`)
    return false

  } catch (error) {
    KatanaLogger.error(PREFIX, 'Blockchain verification failed', error)
    return false
  }
}

/**
 * Place a single buy-sell order pair
 */
async function placeOrderPair(
  wallet: WalletWithSigner,
  baseToken: any,
  targetToken: any,
  pairIndex: number,
  currentPrice: number,
  baseTokenPrice: number,
  pairConfig: ReturnType<typeof getGridConfigForPair>
): Promise<boolean> {
  const buyOffset = pairConfig.BUY_OFFSETS[pairIndex]
  const sellOffset = pairConfig.SELL_OFFSETS[pairIndex]

  KatanaLogger.info(PREFIX, `\nPair ${pairIndex + 1}: BUY ${buyOffset}%, SELL ${sellOffset}%`)

  try {
    // Construct order pair (balance already synced at wallet level)
    KatanaLogger.info(PREFIX, 'Constructing order pair...')
    const buyPrice = currentPrice * (1 + buyOffset / 100)
    const sellPrice = currentPrice * (1 + sellOffset / 100)

    const { buyOrder, sellOrder } = await OrderConstructionService.constructOrderPair(
      wallet.signer.provider!,
      wallet.address,
      baseToken,
      targetToken,
      buyOffset,
      sellOffset,
      currentPrice,
      baseTokenPrice,
      pairConfig.EXPIRY_HOURS,
      pairConfig.MIN_ORDER_SIZE_USD
    )

    KatanaLogger.info(PREFIX, 'Both orders constructed successfully')

    // Execute buy order
    KatanaLogger.info(PREFIX, 'Executing BUY order...')
    await OrderExecutionService.executeOrder(wallet.signer, buyOrder, wallet.index)
    KatanaLogger.info(PREFIX, '✅ BUY order placed')

    // Small delay between buy and sell orders
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Execute sell order
    KatanaLogger.info(PREFIX, 'Executing SELL order...')
    await OrderExecutionService.executeOrder(wallet.signer, sellOrder, wallet.index)
    KatanaLogger.info(PREFIX, '✅ SELL order placed')

    KatanaLogger.info(PREFIX, `✅ Pair ${pairIndex + 1} completed successfully`)
    return true

  } catch (error) {
    KatanaLogger.error(PREFIX, `Pair ${pairIndex + 1} failed`, error)
    return false
  }
}

/**
 * Place initial orders for a wallet
 */
export async function placeInitialOrders(
  wallet: WalletWithSigner,
  botWalletRecord: any
): Promise<void> {
  KatanaLogger.info(PREFIX, `\nStarting initial order placement for wallet ${wallet.index}`)

  try {
    // Parse trading pool
    const { token1: baseTokenSymbol, token2: targetTokenSymbol } =
      WalletService.parseTradingPool(botWalletRecord.trading_pool)

    const baseToken = getToken(baseTokenSymbol)
    const targetToken = getToken(targetTokenSymbol)

    // Get pair-specific configuration
    const pairConfig = getGridConfigForPair(botWalletRecord.trading_pool)

    KatanaLogger.info(PREFIX, `Trading pool: ${targetToken.symbol}/${baseToken.symbol}`)
    KatanaLogger.info(PREFIX, `Using config: BUY ${pairConfig.BUY_OFFSETS[0]}% to ${pairConfig.BUY_OFFSETS[pairConfig.BUY_OFFSETS.length - 1]}%, SELL ${pairConfig.SELL_OFFSETS[0]}% to ${pairConfig.SELL_OFFSETS[pairConfig.SELL_OFFSETS.length - 1]}%`)

    // Get current prices
    const currentPrice = await getCurrentTokenPrice(targetToken.symbol)
    const baseTokenPrice = await getCurrentTokenPrice(baseToken.symbol)

    KatanaLogger.info(PREFIX, `${targetToken.symbol}: $${currentPrice}`)
    KatanaLogger.info(PREFIX, `${baseToken.symbol}: $${baseTokenPrice}`)

    // Get balances to determine how many pairs we can afford
    const { balanceHuman: baseBalance } = await BalanceService.getBalance(
      wallet.signer.provider!,
      baseToken.address,
      wallet.address,
      baseToken.isNative,
      baseToken.decimals
    )

    const { balanceHuman: targetBalance } = await BalanceService.getBalance(
      wallet.signer.provider!,
      targetToken.address,
      wallet.address,
      targetToken.isNative,
      targetToken.decimals
    )

    // Calculate max pairs affordable for each side
    const baseSizing = BalanceService.calculateDynamicOrderSize(
      baseBalance,
      baseTokenPrice,
      pairConfig.MIN_ORDER_SIZE_USD,
      pairConfig.BUY_OFFSETS.length
    )

    const targetSizing = BalanceService.calculateDynamicOrderSize(
      targetBalance,
      currentPrice,
      pairConfig.MIN_ORDER_SIZE_USD,
      pairConfig.SELL_OFFSETS.length
    )

    // Total pairs = minimum of both sides (need both buy and sell for each pair)
    const totalPairs = Math.min(baseSizing.maxPairsAffordable, targetSizing.maxPairsAffordable)

    KatanaLogger.info(PREFIX, `Base balance: ${baseBalance} ${baseToken.symbol} ($${baseSizing.totalValueUsd.toFixed(2)})`)
    KatanaLogger.info(PREFIX, `Target balance: ${targetBalance} ${targetToken.symbol} ($${targetSizing.totalValueUsd.toFixed(2)})`)
    KatanaLogger.info(PREFIX, `Max pairs: ${baseSizing.maxPairsAffordable} buy, ${targetSizing.maxPairsAffordable} sell → ${totalPairs} total`)

    // If insufficient balance, exit early
    if (totalPairs === 0) {
      KatanaLogger.warn(PREFIX, `⚠️  Insufficient balance for any pairs (min $${pairConfig.MIN_ORDER_SIZE_USD} per order)`)
      return
    }

    // Place remaining pairs
    const startFrom = botWalletRecord.placed_initial_orders

    KatanaLogger.info(PREFIX, `Starting from pair ${startFrom + 1}/${totalPairs}`)

    let successfulPairs = 0
    let failedPairs = 0
    let skippedPairs: number[] = []
    const skipReasons: string[] = []

    for (let i = startFrom; i < totalPairs; i++) {
      KatanaLogger.info(PREFIX, `\n${'='.repeat(60)}`)
      KatanaLogger.info(PREFIX, `Attempting pair ${i + 1}/${totalPairs}...`)
      KatanaLogger.info(PREFIX, `${'='.repeat(60)}`)

      // Safety check
      const isSafe = await verifyNoBlockchainDuplicates(wallet, i)
      if (!isSafe) {
        const reason = `Safety check failed - duplicate orders detected`
        KatanaLogger.warn(PREFIX, `⚠️  Pair ${i + 1}/${totalPairs} SKIPPED: ${reason}`)
        skippedPairs.push(i + 1)
        skipReasons.push(`Pair ${i + 1}: ${reason}`)
        failedPairs++
        continue // Skip this pair and continue with the rest
      }

      // Acquire lock
      const canPlacePair = await WalletService.incrementPlacedOrdersCounter(wallet.address, i, wallet.index)

      if (!canPlacePair) {
        KatanaLogger.warn(PREFIX, `Pair ${i + 1} already placed by another process`)
        continue
      }

      KatanaLogger.info(PREFIX, `Lock acquired for pair ${i + 1}`)

      // Place orders
      const success = await placeOrderPair(
        wallet,
        baseToken,
        targetToken,
        i,
        currentPrice,
        baseTokenPrice,
        pairConfig
      )

      if (!success) {
        KatanaLogger.error(PREFIX, `Pair ${i + 1} failed after counter increment!`)
        KatanaLogger.error(PREFIX, `Decrementing counter back from ${i + 1} to ${i}`)

        await WalletService.decrementPlacedOrdersCounter(wallet.address, i + 1)
        failedPairs++
        break
      }

      successfulPairs++
      KatanaLogger.info(PREFIX, `Pair ${i + 1}/${totalPairs} completed`)

      if (i < totalPairs - 1) {
        await new Promise(resolve => setTimeout(resolve, 3000))
      }
    }

    // Summary
    KatanaLogger.info(PREFIX, `\n${'='.repeat(60)}`)
    KatanaLogger.info(PREFIX, `Initial order placement summary for wallet ${wallet.index}:`)
    KatanaLogger.info(PREFIX, `  ✅ Successful pairs: ${successfulPairs}`)
    KatanaLogger.info(PREFIX, `  ❌ Failed pairs: ${failedPairs}`)
    if (skippedPairs.length > 0) {
      KatanaLogger.warn(PREFIX, `  ⏭️  Skipped pairs: ${skippedPairs.join(', ')}`)
      for (const skipReason of skipReasons) {
        KatanaLogger.warn(PREFIX, `     - ${skipReason}`)
      }
    }

    // Error if all pairs were skipped or failed
    if (successfulPairs === 0 && (failedPairs > 0 || skippedPairs.length > 0)) {
      KatanaLogger.error(PREFIX, `🚨 ALL PAIRS FAILED OR SKIPPED! No orders placed for wallet ${wallet.index}`)
    }

    // Sync balances after all order placements to get accurate final state
    if (successfulPairs > 0) {
      KatanaLogger.info(PREFIX, 'Syncing balances after order placements...')
      await BalanceService.syncBalances(wallet.signer.provider!, wallet.address)
    }

    // Check completion
    const finalCount = await WalletService.getWalletRecord(wallet.address)
    if (finalCount && finalCount.placed_initial_orders === totalPairs) {
      KatanaLogger.info(PREFIX, `\n🎉 All ${totalPairs} pairs placed successfully!`)
    } else if (finalCount && finalCount.placed_initial_orders > startFrom) {
      KatanaLogger.info(PREFIX, `\n✅ Placed ${finalCount.placed_initial_orders - startFrom} additional pair(s)`)
      KatanaLogger.info(PREFIX, `📊 Total placed: ${finalCount.placed_initial_orders}/${totalPairs}`)
    }
    KatanaLogger.info(PREFIX, `${'='.repeat(60)}`)

  } catch (error) {
    KatanaLogger.error(PREFIX, `Initial order placement failed for wallet ${wallet.index}`, error)
    throw error
  }
}
