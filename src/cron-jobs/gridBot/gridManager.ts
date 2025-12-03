import { BotWallet, GridConfig, TokenConfig, GridPlacementResult } from './types'
import { getCurrentTokenPrice, calculateUSDValue } from './priceManager'
import { placeOrder } from './orderExecutor'
import { hasExistingGrid, hasExistingOrdersForToken } from './databaseSync'
import { getTokenBalance } from '../utils/botWalletManager'
import { fromWei, sleep } from '../utils/botHelpers'
import { KatanaLogger } from '../../utils/logger'
import { getToken, getBaseCurrencies, getTargetTokens } from './tokenPairs.config'

const PREFIX = '[GridManager]'

// Grid configuration
const GRID_CONFIG: GridConfig = {
  BUY_OFFSETS: [-1, -2, -3], // % below market
  SELL_OFFSETS: [1, 2, 3],    // % above market
  ORDER_SIZE_PERCENT: 20,     // 20% of balance
  MIN_ORDER_VALUE_USD: 6,     // $6 minimum
  EXPIRY_HOURS: 24,
  FILL_DELAY_MINUTES: 3,
  TESTING_MODE: process.env.GRID_BOT_TESTING_MODE === 'true' // Set to 'true' to simulate orders without blockchain
}

/**
 * Get wallet balances for all base currencies and select the one with highest USD value
 */
async function selectBaseCurrency(wallet: BotWallet): Promise<{ token: TokenConfig; balance: number; usdValue: number }> {
  const baseCurrencies = getBaseCurrencies()
  const balances: Array<{ token: TokenConfig; balance: number; usdValue: number }> = []

  for (const token of baseCurrencies) {
    const balanceWei = await getTokenBalance(
      wallet.signer.provider!,
      token.address,
      wallet.address,
      token.isNative
    )
    const balanceHuman = parseFloat(fromWei(balanceWei.toString(), token.decimals))
    const price = await getCurrentTokenPrice(token.symbol)
    const usdValue = balanceHuman * price

    balances.push({ token, balance: balanceHuman, usdValue })

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] ${token.symbol} balance: ${balanceHuman.toFixed(token.decimals)} ($${usdValue.toFixed(2)})`
    )
  }

  // Select base currency with highest USD value
  const selected = balances.reduce((max, curr) => curr.usdValue > max.usdValue ? curr : max)

  KatanaLogger.info(PREFIX,
    `[Wallet ${wallet.index}] Selected base currency: ${selected.token.symbol} with $${selected.usdValue.toFixed(2)}`
  )

  return selected
}

/**
 * Place the initial 6-order grid for a wallet
 * Now supports multiple tokens - places orders for each target token with dynamic base currency selection
 */
export async function placeGrid(wallet: BotWallet, executionId: string): Promise<GridPlacementResult> {
  KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Starting grid placement for ${wallet.address}`)

  const result: GridPlacementResult = {
    success: false,
    buyOrders: 0,
    sellOrders: 0,
    totalOrders: 0,
    errors: []
  }

  try {
    // 1. Check if grid already exists
    const gridExists = await hasExistingGrid(wallet.address, executionId)
    if (gridExists) {
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Grid already exists, skipping placement`)
      result.success = true
      return result
    }

    // 2. Select base currency (USDC or ETH) based on wallet balance
    const baseCurrency = await selectBaseCurrency(wallet)
    const baseToken = baseCurrency.token

    // 3. Get target tokens (excluding the base currency itself if it's in the list)
    const allTargetTokens = getTargetTokens().filter(token => token.symbol !== baseToken.symbol)

    if (allTargetTokens.length === 0) {
      const error = 'No target tokens available for trading'
      KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] ${error}`)
      result.errors.push(error)
      return result
    }

    // 4. Filter out tokens that already have active orders
    const tokensWithoutOrders: TokenConfig[] = []
    for (const token of allTargetTokens) {
      const hasOrders = await hasExistingOrdersForToken(wallet.address, executionId, token.symbol)
      if (!hasOrders) {
        tokensWithoutOrders.push(token)
      } else {
        KatanaLogger.info(PREFIX,
          `[Wallet ${wallet.index}] ${token.symbol} already has active orders, skipping`
        )
      }
    }

    if (tokensWithoutOrders.length === 0) {
      KatanaLogger.info(PREFIX,
        `[Wallet ${wallet.index}] All tokens already have active orders`
      )
      result.success = true
      return result
    }

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Found ${tokensWithoutOrders.length} tokens without active orders: ${tokensWithoutOrders.map(t => t.symbol).join(', ')}`
    )

    // 5. Calculate available USD for trading
    const availableForOrders = baseCurrency.balance * (GRID_CONFIG.ORDER_SIZE_PERCENT / 100) // 20% of balance
    const basePrice = await getCurrentTokenPrice(baseToken.symbol)
    const availableUSD = availableForOrders * basePrice

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Available for orders: ${availableForOrders.toFixed(baseToken.decimals)} ${baseToken.symbol} ($${availableUSD.toFixed(2)} USD)`
    )

    // 6. Calculate how many tokens we can afford and how many orders per token
    const numTokens = tokensWithoutOrders.length
    const usdPerToken = availableUSD / numTokens

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] USD per token: $${usdPerToken.toFixed(2)} (${numTokens} tokens)`
    )

    // Calculate how many orders we can place per token at $6 minimum
    let ordersPerToken = Math.floor(usdPerToken / GRID_CONFIG.MIN_ORDER_VALUE_USD)

    if (ordersPerToken === 0) {
      // Can't afford all tokens - filter to only affordable subset
      const maxAffordableTokens = Math.floor(availableUSD / GRID_CONFIG.MIN_ORDER_VALUE_USD)

      if (maxAffordableTokens === 0) {
        const error = `Insufficient balance: need at least $${GRID_CONFIG.MIN_ORDER_VALUE_USD} to place 1 order. Available: $${availableUSD.toFixed(2)}`
        KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] ${error}`)
        result.errors.push(error)
        return result
      }

      // Only trade the first N tokens we can afford
      const tokensToTrade = tokensWithoutOrders.slice(0, maxAffordableTokens)
      const skippedTokens = tokensWithoutOrders.slice(maxAffordableTokens)

      KatanaLogger.warn(PREFIX,
        `[Wallet ${wallet.index}] Can only afford ${maxAffordableTokens} of ${numTokens} tokens. ` +
        `Skipping: ${skippedTokens.map(t => t.symbol).join(', ')}`
      )

      // Recalculate with affordable tokens only
      ordersPerToken = Math.floor(availableUSD / maxAffordableTokens / GRID_CONFIG.MIN_ORDER_VALUE_USD)
      tokensWithoutOrders.length = maxAffordableTokens // Truncate array
    }

    // Cap at 3 orders per token max (BUY_OFFSETS.length)
    const actualOrdersPerToken = Math.min(ordersPerToken, GRID_CONFIG.BUY_OFFSETS.length)
    const finalNumTokens = tokensWithoutOrders.length

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Placing ${actualOrdersPerToken} orders per token for ${finalNumTokens} tokens ` +
      `($${(usdPerToken / actualOrdersPerToken).toFixed(2)} per order)`
    )

    // 7. For each target token, place BUY and SELL orders
    const basePerOrder = (availableForOrders / finalNumTokens) / actualOrdersPerToken

    for (const targetToken of tokensWithoutOrders) {
      KatanaLogger.info(PREFIX,
        `[Wallet ${wallet.index}] ========== Processing ${targetToken.symbol} ==========`
      )

      // Get target token balance for sell orders
      const targetBalanceWei = await getTokenBalance(
        wallet.signer.provider!,
        targetToken.address,
        wallet.address,
        targetToken.isNative
      )
      const targetBalanceHuman = parseFloat(fromWei(targetBalanceWei.toString(), targetToken.decimals))

      KatanaLogger.info(PREFIX,
        `[Wallet ${wallet.index}] ${targetToken.symbol} balance: ${targetBalanceHuman.toFixed(targetToken.decimals)}`
      )

      // Calculate target token amount per sell order
      const targetPerOrder = targetBalanceHuman * (GRID_CONFIG.ORDER_SIZE_PERCENT / 100) / actualOrdersPerToken

      // Get current price of target token in USD
      const targetPrice = await getCurrentTokenPrice(targetToken.symbol)
      KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Current ${targetToken.symbol} price: $${targetPrice}`)

      // Place paired orders for this target token (use actualOrdersPerToken, not pairCount)
      for (let i = 0; i < actualOrdersPerToken; i++) {
        const buyOffset = GRID_CONFIG.BUY_OFFSETS[i]
        const sellOffset = GRID_CONFIG.SELL_OFFSETS[i]

        try {
          // ============ STEP 1: Place BUY order (base → target) ============
          const targetPriceAtBuy = targetPrice * (1 + buyOffset / 100)

          // Calculate limit price based on token pair
          // For BUY (base → target): limitPrice = how much target per 1 base
          // Example: If buying ETH with USDC at $2970, limitPrice = 1/2970 ETH per USDC
          const buyLimitPrice = baseToken.symbol === 'USDC'
            ? 1 / targetPriceAtBuy  // USDC is in dollars, so direct conversion
            : targetPrice / basePrice // Non-USDC base needs price ratio

          const buyOrderType = 'grid_buy'

          KatanaLogger.info(PREFIX,
            `[Wallet ${wallet.index}] Pair ${i + 1}/${actualOrdersPerToken} - Placing BUY order: ${basePerOrder.toFixed(baseToken.decimals)} ${baseToken.symbol} → ${targetToken.symbol} @ $${targetPriceAtBuy.toFixed(2)} (${buyOffset}%)`
          )

          await placeOrder({
            wallet,
            executionId,
            fromToken: baseToken,
            toToken: targetToken,
            amount: basePerOrder.toFixed(baseToken.decimals),
            limitPrice: buyLimitPrice,
            orderType: buyOrderType,
            parentOrderId: null,
            gridOffset: buyOffset
          }, GRID_CONFIG.TESTING_MODE)

          KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] BUY order confirmed at ${buyOffset}%`)
          result.buyOrders++
          result.totalOrders++

          // Wait 1 second before placing corresponding SELL order
          await sleep(1000)

          // ============ STEP 2: Place corresponding SELL order (target → base) ============
          // Skip if insufficient target token balance
          if (targetBalanceHuman === 0 || targetPerOrder < 0.000001) {
            KatanaLogger.warn(PREFIX,
              `[Wallet ${wallet.index}] Insufficient ${targetToken.symbol} balance for SELL order, skipping`
            )
            await sleep(1000)
            continue
          }

          const targetPriceAtSell = targetPrice * (1 + sellOffset / 100)

          // For SELL (target → base): limitPrice = how much base per 1 target
          // Example: If selling ETH for USDC at $3000, limitPrice = 3000 USDC per ETH
          const sellLimitPrice = baseToken.symbol === 'USDC'
            ? targetPriceAtSell  // Selling for USDC at target price
            : basePrice / targetPrice // Non-USDC base needs price ratio

          const sellOrderType = 'grid_sell'

          KatanaLogger.info(PREFIX,
            `[Wallet ${wallet.index}] Pair ${i + 1}/${actualOrdersPerToken} - Placing SELL order: ${targetPerOrder.toFixed(targetToken.decimals)} ${targetToken.symbol} → ${baseToken.symbol} @ $${targetPriceAtSell.toFixed(2)} (${sellOffset}%)`
          )

          await placeOrder({
            wallet,
            executionId,
            fromToken: targetToken,
            toToken: baseToken,
            amount: targetPerOrder.toFixed(targetToken.decimals),
            limitPrice: sellLimitPrice,
            orderType: sellOrderType,
            parentOrderId: null,
            gridOffset: sellOffset
          }, GRID_CONFIG.TESTING_MODE)

          KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] SELL order confirmed at ${sellOffset}%`)
          result.sellOrders++
          result.totalOrders++

          KatanaLogger.info(PREFIX,
            `[Wallet ${wallet.index}] Pair ${i + 1}/${actualOrdersPerToken} for ${targetToken.symbol} successfully placed (BUY ${buyOffset}% + SELL ${sellOffset}%)`
          )

          // Wait 1 second between pairs to avoid rate limits
          await sleep(1000)

        } catch (error: any) {
          // If either order in the pair fails, log and continue
          const errorMsg = `Failed to place pair ${i + 1} for ${targetToken.symbol} (BUY ${buyOffset}% / SELL ${sellOffset}%): ${error.message}`
          KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] ${errorMsg}`)
          result.errors.push(errorMsg)

          KatanaLogger.warn(PREFIX,
            `[Wallet ${wallet.index}] Skipping pair ${i + 1} for ${targetToken.symbol}. Current state: ${result.buyOrders} BUY, ${result.sellOrders} SELL`
          )
        }
      }

      KatanaLogger.info(PREFIX,
        `[Wallet ${wallet.index}] ========== Finished ${targetToken.symbol} ==========`
      )
    }

    // 7. Determine success
    result.success = result.totalOrders > 0 && result.errors.length === 0

    KatanaLogger.info(PREFIX,
      `[Wallet ${wallet.index}] Grid placement complete: ${result.buyOrders} BUY + ${result.sellOrders} SELL = ${result.totalOrders} total`
    )

    if (result.errors.length > 0) {
      KatanaLogger.warn(PREFIX, `[Wallet ${wallet.index}] Errors encountered: ${result.errors.length}`)
    }

    return result
  } catch (error) {
    KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] Grid placement failed`, error)
    result.errors.push(error instanceof Error ? error.message : 'Unknown error')
    return result
  }
}

/**
 * Get grid configuration (for external use)
 */
export function getGridConfig(): GridConfig {
  return GRID_CONFIG
}

/**
 * Get token configurations (for external use)
 * @deprecated Use tokenPairs.config.ts exports instead
 */
export function getTokenConfigs(): { ETH: TokenConfig; USDC: TokenConfig } {
  return {
    ETH: getToken('ETH'),
    USDC: getToken('USDC')
  }
}
