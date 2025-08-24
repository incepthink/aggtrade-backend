import type { Request, Response, NextFunction } from "express";
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider(
  "https://mainnet.infura.io/v3/01f9aa2ee79449a69f4df21b7ee0b72a"
);

// Uniswap V3 Factory and ABI for Ethereum
const FACTORY_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
];

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function fee() external view returns (uint24)",
  "function liquidity() external view returns (uint128)",
];

const USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const FEE_TIERS = [2500, 3000]; // 0.25% (SushiSwap standard), 0.3% (fallback)

// Helper function to calculate price from sqrtPriceX96
function calculatePrice(
  sqrtPriceX96: bigint,
  token0Address: string,
  token1Address: string,
  tokenAddress: string,
  decimals0: number | bigint,
  decimals1: number | bigint
): number {
  console.log(`\n=== Price Calculation Debug ===`);
  console.log(`sqrtPriceX96: ${sqrtPriceX96}`);
  console.log(`token0: ${token0Address}`);
  console.log(`token1: ${token1Address}`);
  console.log(`requested token: ${tokenAddress}`);
  console.log(`decimals0: ${decimals0}, decimals1: ${decimals1}`);

  // Convert sqrtPriceX96 to a regular price
  const Q96 = 2n ** 96n;
  const sqrtPriceDecimal = Number(sqrtPriceX96) / Number(Q96);
  console.log(`sqrtPriceDecimal: ${sqrtPriceDecimal}`);

  // Raw price is in terms of smallest units: (token1_wei / token0_wei)
  const rawPrice = sqrtPriceDecimal * sqrtPriceDecimal;
  console.log(`rawPrice (token1_wei per token0_wei): ${rawPrice}`);

  const dec0 = Number(decimals0);
  const dec1 = Number(decimals1);

  // Convert to human readable units
  // rawPrice represents (token1_smallest_unit / token0_smallest_unit)
  // To convert to (token1 / token0): rawPrice * (10^dec0) / (10^dec1)
  const priceToken1PerToken0 =
    (rawPrice * Math.pow(10, dec0)) / Math.pow(10, dec1);
  console.log(
    `price in human units (token1 per token0): ${priceToken1PerToken0}`
  );

  // We always want to return the price in USDC
  const usdcAddress = USDC_ADDRESS.toLowerCase();
  const requestedTokenAddress = tokenAddress.toLowerCase();
  const token0Lower = token0Address.toLowerCase();
  const token1Lower = token1Address.toLowerCase();

  console.log(`USDC address: ${usdcAddress}`);
  console.log(`Is token0 USDC? ${token0Lower === usdcAddress}`);
  console.log(`Is token1 USDC? ${token1Lower === usdcAddress}`);
  console.log(
    `Is requested token token0? ${token0Lower === requestedTokenAddress}`
  );
  console.log(
    `Is requested token token1? ${token1Lower === requestedTokenAddress}`
  );

  let finalPrice;

  if (token0Lower === usdcAddress) {
    // token0 is USDC, token1 is the target token
    // priceToken1PerToken0 = token1 per USDC, so we need to invert it
    finalPrice = 1 / priceToken1PerToken0;
    console.log(
      `USDC is token0, inverting price: 1/${priceToken1PerToken0} = ${finalPrice}`
    );
  } else if (token1Lower === usdcAddress) {
    // token1 is USDC, token0 is the target token
    // priceToken1PerToken0 = USDC per token0, which is what we want
    finalPrice = priceToken1PerToken0;
    console.log(`USDC is token1, using direct price: ${finalPrice}`);
  } else {
    // Neither token is USDC - this shouldn't happen in our case
    console.error("Neither token0 nor token1 is USDC!");
    finalPrice = priceToken1PerToken0;
  }

  console.log(`final price in USDC: ${finalPrice}`);
  console.log(`=== End Debug ===\n`);

  return finalPrice;
}

async function findPoolWithLiquidity(
  factory: ethers.Contract,
  tokenA: string,
  tokenB: string
) {
  // Try SushiSwap's 0.25% fee first, then fallback to 0.3%
  for (const fee of FEE_TIERS) {
    try {
      const poolAddress = await factory.getPool(tokenA, tokenB, fee);

      if (poolAddress && poolAddress !== ethers.ZeroAddress) {
        // Check if pool has liquidity by calling slot0
        const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
        const slot0 = await pool.slot0();

        // If sqrtPriceX96 is not zero, the pool has been initialized
        if (slot0.sqrtPriceX96 > 0n) {
          const feePercent = fee === 2500 ? "0.25%" : "0.3%";
          console.log(`Found pool with ${feePercent} fee at: ${poolAddress}`);
          return { poolAddress, fee, slot0 };
        }
      }
    } catch (error) {
      const feePercent = fee === 2500 ? "0.25%" : "0.3%";
      console.log(`Failed to get pool with ${feePercent} fee:`, error);
    }
  }

  return null;
}

export async function getEthereumPrice(
  req: Request,
  res: Response,
  _next: NextFunction
) {
  try {
    const { tokenAddress } = req.query;

    if (!tokenAddress) {
      return res
        .status(400)
        .json({ status: "error", message: "provide address" });
    }

    // Validate token address format
    if (!ethers.isAddress(tokenAddress as string)) {
      return res
        .status(400)
        .json({ status: "error", message: "invalid token address" });
    }

    // If requesting USDC price, return $1.00 directly
    if ((tokenAddress as string).toLowerCase() === USDC_ADDRESS.toLowerCase()) {
      return res.json({
        status: "ok",
        token: tokenAddress,
        quoteToken: USDC_ADDRESS,
        price: 1.0,
        poolAddress: null,
        fee: null,
        factoryUsed: FACTORY_ADDRESS,
        poolInfo: {
          token0: USDC_ADDRESS,
          token1: USDC_ADDRESS,
          sqrtPriceX96: "0",
          tick: "0",
          fee: 0,
        },
        note: "USDC price is always $1.00 as it is the base quote token",
      });
    }

    // Check if factory contract exists
    const factoryCode = await provider.getCode(FACTORY_ADDRESS);
    if (factoryCode === "0x") {
      return res.status(500).json({
        status: "error",
        message: "Factory contract not found at the specified address",
      });
    }

    const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);

    // Find a pool with liquidity
    const poolData = await findPoolWithLiquidity(
      factory,
      tokenAddress as string,
      USDC_ADDRESS
    );

    if (!poolData) {
      return res.status(404).json({
        status: "error",
        message: "No liquidity pool found for this token pair",
        details: {
          token: tokenAddress,
          quoteToken: USDC_ADDRESS,
          feesTried: FEE_TIERS,
        },
      });
    }

    const { poolAddress, fee, slot0 } = poolData;
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);

    try {
      const token0 = await pool.token0();
      const token1 = await pool.token1();

      // Get actual decimals from the token contracts for accuracy
      const token0Contract = new ethers.Contract(
        token0,
        ["function decimals() view returns (uint8)"],
        provider
      );
      const token1Contract = new ethers.Contract(
        token1,
        ["function decimals() view returns (uint8)"],
        provider
      );

      let decimals0, decimals1;
      try {
        [decimals0, decimals1] = await Promise.all([
          token0Contract.decimals(),
          token1Contract.decimals(),
        ]);
        console.log(
          `Token decimals - token0 (${token0}): ${decimals0}, token1 (${token1}): ${decimals1}`
        );
      } catch (decimalError) {
        // Fallback to assumed decimals if contract calls fail
        const getTokenDecimals = (address: string) => {
          const addr = address.toLowerCase();
          // USDC on Ethereum has 6 decimals
          if (addr === USDC_ADDRESS.toLowerCase()) return 6;
          // WETH on Ethereum
          if (addr === "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2") return 18;
          // WBTC on Ethereum uses 8 decimals
          if (addr === "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599") return 8;
          // USDT on Ethereum uses 6 decimals
          if (addr === "0xdac17f958d2ee523a2206206994597c13d831ec7") return 6;
          // LINK on Ethereum uses 18 decimals
          if (addr === "0x514910771af9ca656af840dff83e8264ecf986ca") return 18;
          // Default to 18 for most ERC20 tokens
          return 18;
        };

        decimals0 = getTokenDecimals(token0);
        decimals1 = getTokenDecimals(token1);
        console.log("Using fallback decimals due to error:", decimalError);
        console.log(
          `Fallback decimals - token0: ${decimals0}, token1: ${decimals1}`
        );
      }

      const price = calculatePrice(
        slot0.sqrtPriceX96,
        token0,
        token1,
        tokenAddress as string,
        Number(decimals0),
        Number(decimals1)
      );

      // Format price to show more decimal places (up to 8 decimal places)
      const formattedPrice = parseFloat(price.toFixed(8));

      res.json({
        status: "ok",
        token: tokenAddress,
        quoteToken: USDC_ADDRESS,
        price: formattedPrice,
        poolAddress: poolAddress,
        fee: fee,
        factoryUsed: FACTORY_ADDRESS,
        poolInfo: {
          token0,
          token1,
          sqrtPriceX96: slot0.sqrtPriceX96.toString(),
          tick: slot0.tick.toString(),
          fee: fee,
        },
      });
    } catch (poolError: any) {
      console.error("Pool contract call failed:", poolError);
      return res.status(500).json({
        status: "error",
        message: "Failed to get pool data",
        details: {
          poolAddress,
          error:
            poolError instanceof Error
              ? poolError.message
              : "Unknown pool error",
        },
      });
    }
  } catch (error) {
    console.error("getEthereumPrice", error);
    res.status(500).json({
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

// Alternative simpler function if you just need the price calculation
export async function getTokenPriceInUSDC(
  tokenAddress: string,
  provider: ethers.Provider
): Promise<number | null> {
  try {
    // If requesting USDC price, return $1.00 directly
    if (tokenAddress.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
      return 1.0;
    }

    const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);

    // Find a pool with liquidity
    const poolData = await findPoolWithLiquidity(
      factory,
      tokenAddress,
      USDC_ADDRESS
    );

    if (!poolData) {
      console.log("No liquidity pool found for token:", tokenAddress);
      return null;
    }

    const { poolAddress, slot0 } = poolData;
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);

    const token0 = await pool.token0();
    const token1 = await pool.token1();

    // Get decimals
    const token0Contract = new ethers.Contract(
      token0,
      ["function decimals() view returns (uint8)"],
      provider
    );
    const token1Contract = new ethers.Contract(
      token1,
      ["function decimals() view returns (uint8)"],
      provider
    );

    const [decimals0, decimals1] = await Promise.all([
      token0Contract.decimals(),
      token1Contract.decimals(),
    ]);

    const price = calculatePrice(
      slot0.sqrtPriceX96,
      token0,
      token1,
      tokenAddress,
      Number(decimals0),
      Number(decimals1)
    );

    return parseFloat(price.toFixed(8));
  } catch (error) {
    console.error("Error getting token price:", error);
    return null;
  }
}

// SushiSwap API function
export async function getSushiSwapPrice(
  tokenAddress: string
): Promise<number | null> {
  try {
    const response = await fetch(
      `https://api.sushi.com/price/v1/1/${tokenAddress}`
    );

    if (!response.ok) {
      console.log(`SushiSwap API error: ${response.status}`);
      return null;
    }

    console.log(response);

    const data = await response.json();

    return data;
  } catch (error) {
    console.log("Failed to fetch from SushiSwap API:", error);
    return null;
  }
}

// Express route handler
export async function getSushiPrice(
  req: Request,
  res: Response,
  _next: NextFunction
) {
  try {
    const { tokenAddress } = req.query;

    if (!tokenAddress) {
      return res.status(400).json({
        status: "error",
        message: "Token address is required",
        usage: "GET /sushi-price?tokenAddress=0x...",
      });
    }

    // Validate token address format
    if (!ethers.isAddress(tokenAddress as string)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid token address format",
      });
    }

    console.log(`Fetching SushiSwap price for token: ${tokenAddress}`);

    // Get price from SushiSwap API
    const price = await getSushiSwapPrice(tokenAddress as string);

    if (price === null) {
      return res.status(404).json({
        status: "error",
        message: "Price not found for this token",
        details: {
          token: tokenAddress,
          source: "sushiswap-api",
          note: "Token might not be available on SushiSwap or API might be down",
        },
      });
    }

    // Return successful response
    res.json({
      status: "ok",
      token: tokenAddress,
      price: price,
      source: "sushiswap-api",
      timestamp: new Date().toISOString(),
      chain: "ethereum",
      chainId: 1,
    });
  } catch (error) {
    console.error("getSushiPrice error:", error);
    res.status(500).json({
      status: "error",
      message: "Internal server error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

// Alternative route with fallback to calculated price
export async function getSushiPriceWithFallback(
  req: Request,
  res: Response,
  _next: NextFunction
) {
  try {
    const { tokenAddress } = req.query;

    if (!tokenAddress) {
      return res.status(400).json({
        status: "error",
        message: "Token address is required",
      });
    }

    if (!ethers.isAddress(tokenAddress as string)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid token address format",
      });
    }

    console.log(`Fetching price for token: ${tokenAddress}`);

    // Try SushiSwap API first
    const sushiPrice = await getSushiSwapPrice(tokenAddress as string);

    console.log("SUSHIPRICE", sushiPrice);

    if (sushiPrice !== null) {
      return res.json({
        status: "ok",
        token: tokenAddress,
        price: sushiPrice,
        source: "sushiswap-api",
        timestamp: new Date().toISOString(),
        chain: "ethereum",
        chainId: 1,
      });
    }

    // Fallback message (you can integrate your Uniswap V3 calculation here)
    return res.status(404).json({
      status: "error",
      message: "Price not available from SushiSwap API",
      details: {
        token: tokenAddress,
        attempted_sources: ["sushiswap-api"],
        suggestion: "Try using the Uniswap V3 price endpoint instead",
      },
    });
  } catch (error) {
    console.error("getSushiPriceWithFallback error:", error);
    res.status(500).json({
      status: "error",
      message: "Internal server error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
