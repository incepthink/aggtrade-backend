/**
 * Initial Order Placement Module
 * Places initial grid orders (5 buy-sell pairs)
 */

import { getToken } from '../gridBot/tokenPairs.config'
import { getCurrentTokenPrice } from '../gridBot/priceManager'
import { KatanaLogger } from '../../utils/logger'
import { getGridConfigForPair, TEST_MODE_CONFIG } from './config'
import { WalletService, type WalletWithSigner } from './services/WalletService'
import { BalanceService } from './services/BalanceService'
import { OrderConstructionService } from './services/OrderConstructionService'
import { OrderExecutionService } from './services/OrderExecutionService'
import BotOrdersSimple from '../../models/BotOrdersSimple'
import { TwapService } from '../../services/twap'

const PREFIX = '[PlaceInitialOrders]'

/**
 * Verify no blockchain duplicates exist
 */
async function verifyNoBlockchainDuplicates(
  wallet: WalletWithSigner,
  pairIndex: number
): Promise<boolean> {
  try {
    // Build query conditions - only count active orders that could cause duplicates
    // Exclude 'canceled', 'expired', and 'filled' as they're no longer blocking new orders
    const whereConditions: any = {
      wallet_address: wallet.address.toLowerCase(),
      order_type: ['grid_buy', 'grid_sell'],
      status: ['pending', 'partial']  // Only count orders still in play
    }

    const dbOrders = await BotOrdersSimple.findAll({
      where: whereConditions
    })

    const expectedOrderCount = pairIndex * 2
    const actualDbOrderCount = dbOrders.length

    if (actualDbOrderCount > expectedOrderCount) {
      KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] Duplicate detected: ${actualDbOrderCount} > ${expectedOrderCount}`)
      return false
    }

    return true

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

  try {
    // Construct order pair (balance already synced at wallet level)
    const buyPrice = currentPrice * (1 + buyOffset / 100)
    const sellPrice = currentPrice * (1 + sellOffset / 100)

    KatanaLogger.info(
      PREFIX,
      `[Wallet ${wallet.index}] Pair ${pairIndex + 1}: Buy @ $${buyPrice.toFixed(4)} (${buyOffset}%) | Sell @ $${sellPrice.toFixed(4)} (${sellOffset}%)`
    )

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

    // Log order details
    const buyOrderSizeUSD = parseFloat(buyOrder.fromAmount) * baseTokenPrice
    const sellOrderSizeUSD = parseFloat(sellOrder.fromAmount) * currentPrice

    KatanaLogger.info(
      PREFIX,
      `[Wallet ${wallet.index}] Pair ${pairIndex + 1} BUY: ${buyOrder.fromAmount} ${buyOrder.fromToken.symbol} ($${buyOrderSizeUSD.toFixed(2)}) → ${buyOrder.toToken.symbol}`
    )

    // Execute buy order
    await OrderExecutionService.executeOrder(wallet.signer, buyOrder, wallet.index)

    // Small delay between buy and sell orders
    await new Promise(resolve => setTimeout(resolve, 2000))

    KatanaLogger.info(
      PREFIX,
      `[Wallet ${wallet.index}] Pair ${pairIndex + 1} SELL: ${sellOrder.fromAmount} ${sellOrder.fromToken.symbol} ($${sellOrderSizeUSD.toFixed(2)}) → ${sellOrder.toToken.symbol}`
    )

    // Execute sell order
    await OrderExecutionService.executeOrder(wallet.signer, sellOrder, wallet.index)

    return true

  } catch (error) {
    KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] Pair ${pairIndex + 1} failed`, error)
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
  try {
    // Parse trading pool
    const { token1: baseTokenSymbol, token2: targetTokenSymbol } =
      WalletService.parseTradingPool(botWalletRecord.trading_pool)

    const baseToken = getToken(baseTokenSymbol)
    const targetToken = getToken(targetTokenSymbol)

    // Get pair-specific configuration
    const pairConfig = getGridConfigForPair(botWalletRecord.trading_pool)

    // Get current prices (silent mode)
    const currentPrice = await getCurrentTokenPrice(targetToken.symbol, true)
    const baseTokenPrice = await getCurrentTokenPrice(baseToken.symbol, true)

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

    // Convert string balances to numbers for calculations and logging
    const baseBalanceNum = parseFloat(baseBalance)
    const targetBalanceNum = parseFloat(targetBalance)

    // Log wallet balances
    const baseBalanceUSD = baseBalanceNum * baseTokenPrice
    const targetBalanceUSD = targetBalanceNum * currentPrice
    const totalBalanceUSD = baseBalanceUSD + targetBalanceUSD

    KatanaLogger.info(
      PREFIX,
      `[Wallet ${wallet.index}] Balances: ${baseBalanceNum.toFixed(4)} ${baseToken.symbol} ($${baseBalanceUSD.toFixed(2)}) | ${targetBalanceNum.toFixed(6)} ${targetToken.symbol} ($${targetBalanceUSD.toFixed(2)}) | Total: $${totalBalanceUSD.toFixed(2)}`
    )
    KatanaLogger.info(
      PREFIX,
      `[Wallet ${wallet.index}] Prices: ${baseToken.symbol} = $${baseTokenPrice.toFixed(2)} | ${targetToken.symbol} = $${currentPrice.toFixed(2)}`
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

    // Log affordability calculations
    KatanaLogger.info(
      PREFIX,
      `[Wallet ${wallet.index}] Affordability: ${baseToken.symbol} can afford ${baseSizing.maxPairsAffordable} pairs (order size: $${baseSizing.orderSizeUsd.toFixed(2)}) | ${targetToken.symbol} can afford ${targetSizing.maxPairsAffordable} pairs (order size: $${targetSizing.orderSizeUsd.toFixed(2)})`
    )

    // Total pairs = minimum of both sides (need both buy and sell for each pair)
    let totalPairs = Math.min(baseSizing.maxPairsAffordable, targetSizing.maxPairsAffordable)

    // Apply ORDER_PAIR_CAP if set
    if (TEST_MODE_CONFIG.orderPairCap !== null && TEST_MODE_CONFIG.orderPairCap > 0) {
      const originalPairs = totalPairs
      totalPairs = Math.min(totalPairs, TEST_MODE_CONFIG.orderPairCap)

      if (originalPairs > totalPairs) {
        KatanaLogger.info(
          PREFIX,
          `[Wallet ${wallet.index}] ORDER_PAIR_CAP applied: ${originalPairs} → ${totalPairs} pairs`
        )
      }
    }

    KatanaLogger.info(
      PREFIX,
      `[Wallet ${wallet.index}] Max pairs to place: ${totalPairs} (limited by ${baseSizing.maxPairsAffordable < targetSizing.maxPairsAffordable ? baseToken.symbol : targetToken.symbol})`
    )

    // If insufficient balance, exit early
    if (totalPairs === 0) {
      return
    }

    // Place remaining pairs
    const startFrom = botWalletRecord.placed_initial_orders

    if (startFrom > 0) {
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Resuming from pair ${startFrom + 1}/${totalPairs}`)
    } else if (totalPairs > 0) {
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Placing ${totalPairs} pair(s)`)
    }

    let successfulPairs = 0
    let failedPairs = 0
    let skippedPairs: number[] = []
    const skipReasons: string[] = []

    for (let i = startFrom; i < totalPairs; i++) {
      // Safety check
      const isSafe = await verifyNoBlockchainDuplicates(wallet, i)
      if (!isSafe) {
        const reason = `Safety check failed - duplicate orders detected`
        skippedPairs.push(i + 1)
        skipReasons.push(`Pair ${i + 1}: ${reason}`)
        failedPairs++
        continue // Skip this pair and continue with the rest
      }

      // Acquire lock
      const canPlacePair = await WalletService.incrementPlacedOrdersCounter(wallet.address, i, wallet.index)

      if (!canPlacePair) {
        continue
      }

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
        await WalletService.decrementPlacedOrdersCounter(wallet.address, i + 1)
        failedPairs++
        break
      }

      successfulPairs++

      if (i < totalPairs - 1) {
        await new Promise(resolve => setTimeout(resolve, 3000))
      }
    }

    // Summary
    if (successfulPairs > 0) {
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Placed ${successfulPairs} pair(s)`)
      await BalanceService.syncBalances(wallet.signer.provider!, wallet.address, wallet.index)
    }

    // Error if all pairs failed
    if (successfulPairs === 0 && (failedPairs > 0 || skippedPairs.length > 0)) {
      KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] All pairs failed or skipped`)
    }

  } catch (error) {
    KatanaLogger.error(PREFIX, `Initial order placement failed for wallet ${wallet.index}`, error)
    throw error
  }
}
