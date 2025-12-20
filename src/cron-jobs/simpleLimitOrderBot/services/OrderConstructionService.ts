/**
 * Order Construction Service
 * Handles building and validating orders before execution
 */

import { ethers } from 'ethers'
import { TwapService } from '../../../services/twap'
import { toWei, fromWei, calculateOutputAmount, calculateMinAmountOut, calculateDeadline } from '../../utils/botHelpers'
import { BalanceService } from './BalanceService'
import { KatanaLogger } from '../../../utils/logger'

const PREFIX = '[OrderConstruction]'

export interface ConstructedOrder {
  orderType: 'grid_buy' | 'grid_sell' | 'counter_buy' | 'counter_sell'
  fromToken: any
  toToken: any
  fromAmount: string
  fromAmountWei: string
  toAmountWei: string
  toAmountMin: string
  limitPrice: number
  gridOffset?: number
  transaction: any
}

export class OrderConstructionService {
  /**
   * Construct an order (validate but don't execute)
   */
  static async constructOrder(
    provider: ethers.Provider,
    walletAddress: string,
    orderType: 'grid_buy' | 'grid_sell' | 'counter_buy' | 'counter_sell',
    fromToken: any,
    toToken: any,
    amount: string,
    limitPrice: number,
    expiryHours: number,
    gridOffset?: number
  ): Promise<ConstructedOrder> {
    KatanaLogger.info(
      PREFIX,
      `Constructing ${orderType}: ${amount} ${fromToken.symbol} → ${toToken.symbol} @ $${limitPrice.toFixed(2)}`
    )

    // Calculate amounts in wei
    const fromAmountWei = toWei(amount, fromToken.decimals)
    const toAmountWei = calculateOutputAmount(
      fromAmountWei,
      limitPrice,
      fromToken.decimals,
      toToken.decimals
    )
    const toAmountMin = calculateMinAmountOut(toAmountWei, 0.1) // 0.1% slippage
    const deadline = calculateDeadline(expiryHours)

    KatanaLogger.info(PREFIX, `Wei amounts: from=${fromAmountWei}, to_min=${toAmountMin}`)

    // Validate balance
    const { balance, balanceHuman } = await BalanceService.getBalance(
      provider,
      fromToken.address,
      walletAddress,
      fromToken.isNative,
      fromToken.decimals
    )

    KatanaLogger.info(PREFIX, `Balance: ${balanceHuman} ${fromToken.symbol}`)

    if (balance < BigInt(fromAmountWei)) {
      throw new Error(
        `Insufficient ${fromToken.symbol} balance: have ${balanceHuman}, need ${amount}`
      )
    }

    // Prepare transaction
    const transaction = TwapService.prepareLimitOrder({
      srcToken: fromToken.address as any,
      dstToken: toToken.address as any,
      srcAmount: fromAmountWei,
      dstMinAmount: toAmountMin,
      srcChunkAmount: fromAmountWei,
      fillDelay: { unit: 'Minutes', value: 3 },
      deadline: deadline
    })

    KatanaLogger.info(PREFIX, 'Order constructed and validated')

    return {
      orderType,
      fromToken,
      toToken,
      fromAmount: amount,
      fromAmountWei,
      toAmountWei,
      toAmountMin,
      limitPrice,
      gridOffset,
      transaction
    }
  }

  /**
   * Construct a pair of orders (buy + sell)
   */
  static async constructOrderPair(
    provider: ethers.Provider,
    walletAddress: string,
    baseToken: any,
    targetToken: any,
    buyOffset: number,
    sellOffset: number,
    currentPrice: number,
    baseTokenPrice: number,
    expiryHours: number,
    minOrderSizeUsd: number
  ): Promise<{ buyOrder: ConstructedOrder; sellOrder: ConstructedOrder }> {
    KatanaLogger.info(PREFIX, `Constructing pair: BUY ${buyOffset}%, SELL ${sellOffset}%`)

    // Get balances
    const { balanceHuman: baseBalance } = await BalanceService.getBalance(
      provider,
      baseToken.address,
      walletAddress,
      baseToken.isNative,
      baseToken.decimals
    )

    const { balanceHuman: targetBalance } = await BalanceService.getBalance(
      provider,
      targetToken.address,
      walletAddress,
      targetToken.isNative,
      targetToken.decimals
    )

    // Calculate order sizes
    const buyPrice = currentPrice * (1 + buyOffset / 100)
    const { orderSize: buyAmount } = BalanceService.calculateOrderSize(
      baseBalance,
      baseTokenPrice,
      minOrderSizeUsd
    )

    const sellPrice = currentPrice * (1 + sellOffset / 100)
    const { orderSize: sellAmount } = BalanceService.calculateOrderSize(
      targetBalance,
      currentPrice,
      minOrderSizeUsd
    )

    // Calculate correct limit prices
    // Buy order: spending baseToken to get targetToken
    // limitPrice = how many targetTokens per baseToken
    const buyLimitPrice = baseTokenPrice / buyPrice

    // Sell order: spending targetToken to get baseToken
    // limitPrice = how many baseTokens per targetToken
    const sellLimitPrice = sellPrice / baseTokenPrice

    // Construct buy order
    const buyOrder = await this.constructOrder(
      provider,
      walletAddress,
      'grid_buy',
      baseToken,
      targetToken,
      buyAmount,
      buyLimitPrice,
      expiryHours,
      buyOffset
    )

    // Construct sell order
    const sellOrder = await this.constructOrder(
      provider,
      walletAddress,
      'grid_sell',
      targetToken,
      baseToken,
      sellAmount,
      sellLimitPrice,
      expiryHours,
      sellOffset
    )

    KatanaLogger.info(PREFIX, 'Order pair constructed successfully')

    return { buyOrder, sellOrder }
  }
}
