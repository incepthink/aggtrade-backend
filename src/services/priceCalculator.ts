// services/priceCalculator.ts - FIXED VERSION
import { Pool, ProcessedSwap, SwapDataWithSqrt } from "../types/katanaSqrtPrice.types";
import { PRICE_LOG_PREFIX } from "../constants/katanaSqrtPrice.constants";
import { KatanaLogger } from "../utils/logger";

export class PriceCalculator {
  /**
   * Calculate token price from sqrtPriceX96 (FIXED VERSION)
   */
  static calculateTokenPriceFromSqrtPriceX96(
    sqrtPriceX96: string,
    token0Decimals: number,
    token1Decimals: number,
    targetToken: 'token0' | 'token1'
  ): number {
    try {
      const sqrtPrice = BigInt(sqrtPriceX96);
      
      // Convert sqrtPriceX96 to price
      // sqrtPriceX96 = sqrt(price) * 2^96
      // price = (sqrtPriceX96 / 2^96)^2
      const Q96 = BigInt(2) ** BigInt(96);
      
      // Use BigInt arithmetic for precision, then convert to float
      const sqrtPriceDecimal = Number(sqrtPrice) / Number(Q96);
      const rawPrice = sqrtPriceDecimal * sqrtPriceDecimal;
      
      // Apply decimal adjustment
      // rawPrice is token1/token0, so we need to adjust for decimal differences
      const decimalAdjustment = Math.pow(10, token1Decimals - token0Decimals);
      
      // This gives us the price of token1 in terms of token0 (adjusted for decimals)
      const token1InToken0 = rawPrice * decimalAdjustment;
      
      let finalPrice: number;
      if (targetToken === 'token1') {
        // Price of token1 in terms of token0
        finalPrice = token1InToken0;
      } else {
        // Price of token0 in terms of token1 (reciprocal)
        finalPrice = token1InToken0 !== 0 ? 1 / token1InToken0 : 0;
      }
      
      KatanaLogger.debug(PRICE_LOG_PREFIX, "SqrtPrice calculation (FIXED)", {
        sqrtPriceX96: sqrtPriceX96.substring(0, 20) + "...",
        token0Decimals,
        token1Decimals,
        targetToken,
        rawPrice,
        decimalAdjustment,
        token1InToken0,
        finalPrice
      });
      
      return finalPrice;
    } catch (error) {
      KatanaLogger.error(PRICE_LOG_PREFIX, "Error calculating token price from sqrtPriceX96", error, {
        sqrtPriceX96,
        token0Decimals,
        token1Decimals,
        targetToken
      });
      return 0;
    }
  }

  /**
   * Calculate pool price ratio from sqrtPriceX96 (DEPRECATED - use calculateTokenPriceFromSqrtPriceX96)
   */
  static calculatePoolRatioFromSqrtPriceX96(
    sqrtPriceX96: string,
    token0Decimals: number,
    token1Decimals: number,
    isToken0: boolean
  ): number {
    // Use the new method for consistency
    return this.calculateTokenPriceFromSqrtPriceX96(
      sqrtPriceX96,
      token0Decimals,
      token1Decimals,
      isToken0 ? 'token0' : 'token1'
    );
  }

  /**
   * Calculate current pool ratio from pool state (UPDATED)
   */
  static calculateCurrentPoolRatio(pool: Pool, isToken0: boolean): number {
    try {
      if (pool.sqrtPrice && pool.sqrtPrice !== "0") {
        const token0Decimals = parseInt(pool.token0.decimals);
        const token1Decimals = parseInt(pool.token1.decimals);
        
        const ratio = this.calculateTokenPriceFromSqrtPriceX96(
          pool.sqrtPrice,
          token0Decimals,
          token1Decimals,
          isToken0 ? 'token0' : 'token1'
        );
        
        KatanaLogger.debug(PRICE_LOG_PREFIX, "Current pool ratio from sqrtPrice", {
          poolId: pool.id,
          sqrtPrice: pool.sqrtPrice.substring(0, 20) + "...",
          ratio,
          token0Symbol: pool.token0.symbol,
          token1Symbol: pool.token1.symbol,
          isToken0
        });
        
        return ratio;
      }
      
      // Fallback to token0Price/token1Price if available
      const fallbackPrice = isToken0 
        ? parseFloat(pool.token1Price || "0")
        : parseFloat(pool.token0Price || "0");
        
      KatanaLogger.warn(PRICE_LOG_PREFIX, "Using fallback price calculation", {
        poolId: pool.id,
        isToken0,
        fallbackPrice,
        token0Price: pool.token0Price,
        token1Price: pool.token1Price
      });
      
      return fallbackPrice;
    } catch (error) {
      KatanaLogger.error(PRICE_LOG_PREFIX, "Error calculating current pool ratio", error, {
        poolId: pool.id,
        isToken0
      });
      return 0;
    }
  }

  /**
   * Process swaps with hybrid scaling approach (UPDATED)
   */
  static processSwapsWithHybridScaling(
    rawSwaps: SwapDataWithSqrt[], 
    tokenAddress: string, 
    isToken0: boolean,
    scalingFactor: number
  ): ProcessedSwap[] {
    const startTime = Date.now();
    
    KatanaLogger.info(PRICE_LOG_PREFIX, "Processing swaps with hybrid scaling", {
      rawSwapCount: rawSwaps.length,
      tokenAddress,
      isToken0,
      scalingFactor
    });

    const processedSwaps = rawSwaps
      .filter(swap => {
        const isValid = swap.sqrtPriceX96 && swap.sqrtPriceX96 !== "0";
        if (!isValid) {
          KatanaLogger.debug(PRICE_LOG_PREFIX, "Filtered out swap with invalid sqrtPrice", {
            swapId: swap.id,
            sqrtPriceX96: swap.sqrtPriceX96
          });
        }
        return isValid;
      })
      .map(swap => {
        try {
          const token0Decimals = parseInt(swap.token0.decimals);
          const token1Decimals = parseInt(swap.token1.decimals);
          
          // Calculate raw pool price using fixed method
          const rawPoolPrice = this.calculateTokenPriceFromSqrtPriceX96(
            swap.sqrtPriceX96,
            token0Decimals,
            token1Decimals,
            isToken0 ? 'token0' : 'token1'
          );

          // Apply scaling factor to get USD price
          const scaledUSDPrice = rawPoolPrice * scalingFactor;

          const processedSwap: ProcessedSwap = {
            id: swap.id,
            timestamp: parseInt(swap.timestamp) * 1000,
            poolPrice: scaledUSDPrice, // Scaled USD price
            rawPoolPrice: rawPoolPrice, // Original pool ratio
            tokenVolumeUSD: isToken0
              ? Math.abs(parseFloat(swap.amount0USD || "0"))
              : Math.abs(parseFloat(swap.amount1USD || "0")),
            totalVolumeUSD: parseFloat(swap.amountUSD || "0"),
            sqrtPriceX96: swap.sqrtPriceX96,
            tick: parseInt(swap.tick || "0"),
          };

          return processedSwap;
        } catch (error) {
          KatanaLogger.error(PRICE_LOG_PREFIX, "Error processing individual swap", error, {
            swapId: swap.id,
            timestamp: swap.timestamp
          });
          return null;
        }
      })
      .filter((swap): swap is ProcessedSwap => swap !== null && swap.poolPrice > 0);

    const validCount = processedSwaps.length;
    const invalidCount = rawSwaps.length - validCount;

    KatanaLogger.performance(PRICE_LOG_PREFIX, 'processSwapsWithHybridScaling', startTime, {
      validSwaps: validCount,
      invalidSwaps: invalidCount,
      successRate: `${((validCount / rawSwaps.length) * 100).toFixed(1)}%`
    });

    return processedSwaps;
  }

  /**
   * Scale existing swaps with new scaling factor
   */
  static rescaleExistingSwaps(swaps: ProcessedSwap[], newScalingFactor: number): ProcessedSwap[] {
    const startTime = Date.now();
    
    KatanaLogger.info(PRICE_LOG_PREFIX, "Rescaling existing swaps", {
      swapCount: swaps.length,
      newScalingFactor
    });

    const rescaledSwaps = swaps.map(swap => ({
      ...swap,
      poolPrice: swap.rawPoolPrice * newScalingFactor, // Recalculate USD price with new factor
    }));

    KatanaLogger.performance(PRICE_LOG_PREFIX, 'rescaleExistingSwaps', startTime, {
      rescaledCount: rescaledSwaps.length
    });

    return rescaledSwaps;
  }

  /**
   * Calculate scaling factor from current prices (UPDATED with better validation)
   */
  static calculateScalingFactor(
    currentSushiPrice: number,
    currentPoolRatio: number,
    tokenAddress: string
  ): number {
    if (currentPoolRatio === 0) {
      KatanaLogger.error(PRICE_LOG_PREFIX, "Cannot calculate scaling factor - pool ratio is zero", undefined, {
        tokenAddress,
        currentSushiPrice,
        currentPoolRatio
      });
      return 1; // Fallback to no scaling
    }

    // Additional validation for reasonable price ranges
    if (currentSushiPrice <= 0) {
      KatanaLogger.error(PRICE_LOG_PREFIX, "Invalid Sushi price for scaling", undefined, {
        tokenAddress,
        currentSushiPrice,
        currentPoolRatio
      });
      return 1;
    }

    const scalingFactor = currentSushiPrice / currentPoolRatio;
    
    // Validate scaling factor is reasonable
    if (scalingFactor <= 0 || !isFinite(scalingFactor)) {
      KatanaLogger.error(PRICE_LOG_PREFIX, "Invalid scaling factor calculated", undefined, {
        tokenAddress,
        currentSushiPrice,
        currentPoolRatio,
        scalingFactor
      });
      return 1;
    }

    KatanaLogger.info(PRICE_LOG_PREFIX, "Scaling factor calculated", {
      tokenAddress,
      currentSushiPrice,
      currentPoolRatio,
      scalingFactor
    });

    return scalingFactor;
  }

  /**
   * Check if price change requires rescaling
   */
  static shouldRescale(
    currentPrice: number,
    storedPrice: number,
    threshold: number = 5
  ): { shouldRescale: boolean; changePercentage: number } {
    if (storedPrice === 0) {
      return { shouldRescale: true, changePercentage: 100 };
    }

    const priceDifference = Math.abs(currentPrice - storedPrice);
    const changePercentage = (priceDifference / storedPrice) * 100;
    const shouldRescale = changePercentage > threshold;

    KatanaLogger.info(PRICE_LOG_PREFIX, "Price change analysis", {
      currentPrice,
      storedPrice,
      priceDifference,
      changePercentage: `${changePercentage.toFixed(2)}%`,
      threshold: `${threshold}%`,
      shouldRescale
    });

    return { shouldRescale, changePercentage };
  }

  /**
   * Helper method to determine which token we're pricing
   */
  static determineTargetToken(tokenAddress: string, pool: Pool): 'token0' | 'token1' {
    const normalizedTokenAddress = tokenAddress.toLowerCase();
    const token0Address = pool.token0.id.toLowerCase();
    const token1Address = pool.token1.id.toLowerCase();
    
    if (normalizedTokenAddress === token0Address) {
      return 'token0';
    } else if (normalizedTokenAddress === token1Address) {
      return 'token1';
    } else {
      KatanaLogger.warn(PRICE_LOG_PREFIX, "Token address not found in pool", {
        tokenAddress,
        token0Address,
        token1Address
      });
      return 'token0'; // Default fallback
    }
  }
}