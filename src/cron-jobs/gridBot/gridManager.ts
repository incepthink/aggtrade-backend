import { BotWallet, GridConfig, TokenConfig, GridPlacementResult } from './types'
import { getCurrentETHPrice, calculateUSDValue } from './priceManager'
import { placeOrder } from './orderExecutor'
import { hasExistingGrid } from './databaseSync'
import { getTokenBalance } from '../utils/botWalletManager'
import { fromWei, sleep } from '../utils/botHelpers'
import { KatanaLogger } from '../../utils/logger'

const PREFIX = '[GridManager]'

// Token configurations
const ETH_TOKEN: TokenConfig = {
  address: '0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62',
  symbol: 'ETH',
  decimals: 18,
  isNative: false
}

const USDC_TOKEN: TokenConfig = {
  address: '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36',
  symbol: 'USDC',
  decimals: 6,
  isNative: false
}

// Grid configuration
const GRID_CONFIG: GridConfig = {
  BUY_OFFSETS: [-1, -2, -3], // % below market
  SELL_OFFSETS: [1, 2, 3],    // % above market
  ORDER_SIZE_PERCENT: 20,     // 20% of balance
  MIN_ORDER_VALUE_USD: 6,     // $6 minimum
  EXPIRY_HOURS: 24,
  FILL_DELAY_MINUTES: 3
}

/**
 * Place the initial 6-order grid for a wallet
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

    // 2. Get current ETH price
    const ethPrice = await getCurrentETHPrice()
    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Current ETH price: $${ethPrice}`)

    // 3. Check balances
    const usdcBalance = await getTokenBalance(
      wallet.signer.provider!,
      USDC_TOKEN.address,
      wallet.address,
      false
    )
    const ethBalance = await getTokenBalance(
      wallet.signer.provider!,
      ETH_TOKEN.address,
      wallet.address,
      false
    )

    const usdcBalanceHuman = parseFloat(fromWei(usdcBalance.toString(), USDC_TOKEN.decimals))
    const ethBalanceHuman = parseFloat(fromWei(ethBalance.toString(), ETH_TOKEN.decimals))

    KatanaLogger.info(PREFIX, 
      `[Wallet ${wallet.index}] Balances: ${usdcBalanceHuman} USDC, ${ethBalanceHuman} ETH`
    )

    // 4. Calculate order amounts (20% of balance)
    const usdcPerOrder = usdcBalanceHuman * (GRID_CONFIG.ORDER_SIZE_PERCENT / 100)
    const ethPerOrder = ethBalanceHuman * (GRID_CONFIG.ORDER_SIZE_PERCENT / 100)

    KatanaLogger.info(PREFIX, 
      `[Wallet ${wallet.index}] Order sizes: ${usdcPerOrder} USDC, ${ethPerOrder} ETH`
    )

    // 5. Validate minimum order values
    if (usdcPerOrder < GRID_CONFIG.MIN_ORDER_VALUE_USD) {
      const error = `USDC per order ($${usdcPerOrder.toFixed(2)}) below minimum ($${GRID_CONFIG.MIN_ORDER_VALUE_USD})`
      KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] ${error}`)
      result.errors.push(error)
      return result
    }

    const ethOrderValueUSD = ethPerOrder * ethPrice
    if (ethOrderValueUSD < GRID_CONFIG.MIN_ORDER_VALUE_USD) {
      const error = `ETH per order ($${ethOrderValueUSD.toFixed(2)}) below minimum ($${GRID_CONFIG.MIN_ORDER_VALUE_USD})`
      KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] ${error}`)
      result.errors.push(error)
      return result
    }

    // 6. Place BUY orders (USDC → ETH at -1%, -2%, -3%)
    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Placing ${GRID_CONFIG.BUY_OFFSETS.length} BUY orders...`)

    for (const offset of GRID_CONFIG.BUY_OFFSETS) {
      try {
        const limitPrice = ethPrice * (1 + offset / 100)
        const orderType = 'grid_buy'

        KatanaLogger.info(PREFIX, 
          `[Wallet ${wallet.index}] Placing BUY order: ${usdcPerOrder} USDC @ $${limitPrice.toFixed(2)} (${offset}%)`
        )

        await placeOrder({
          wallet,
          executionId,
          fromToken: USDC_TOKEN,
          toToken: ETH_TOKEN,
          amount: usdcPerOrder.toFixed(6),
          limitPrice,
          orderType,
          parentOrderId: null,
          gridOffset: offset
        })

        result.buyOrders++
        result.totalOrders++

        // Wait 1 second between orders to avoid rate limits
        await sleep(1000)
      } catch (error: any) {
        const errorMsg = `Failed to place BUY order at ${offset}%: ${error.message}`
        KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] ${errorMsg}`)
        result.errors.push(errorMsg)
      }
    }

    // 7. Place SELL orders (ETH → USDC at +1%, +2%, +3%)
    KatanaLogger.info(PREFIX, `[Wallet ${wallet.index}] Placing ${GRID_CONFIG.SELL_OFFSETS.length} SELL orders...`)

    for (const offset of GRID_CONFIG.SELL_OFFSETS) {
      try {
        const limitPrice = ethPrice * (1 + offset / 100)
        const orderType = 'grid_sell'

        KatanaLogger.info(PREFIX, 
          `[Wallet ${wallet.index}] Placing SELL order: ${ethPerOrder} ETH @ $${limitPrice.toFixed(2)} (${offset}%)`
        )

        await placeOrder({
          wallet,
          executionId,
          fromToken: ETH_TOKEN,
          toToken: USDC_TOKEN,
          amount: ethPerOrder.toFixed(18),
          limitPrice,
          orderType,
          parentOrderId: null,
          gridOffset: offset
        })

        result.sellOrders++
        result.totalOrders++

        // Wait 1 second between orders
        await sleep(1000)
      } catch (error: any) {
        const errorMsg = `Failed to place SELL order at ${offset}%: ${error.message}`
        KatanaLogger.error(PREFIX, `[Wallet ${wallet.index}] ${errorMsg}`)
        result.errors.push(errorMsg)
      }
    }

    // 8. Determine success
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
 */
export function getTokenConfigs(): { ETH: TokenConfig; USDC: TokenConfig } {
  return {
    ETH: ETH_TOKEN,
    USDC: USDC_TOKEN
  }
}
