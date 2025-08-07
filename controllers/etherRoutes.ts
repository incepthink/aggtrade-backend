import type { Request, Response, NextFunction } from "express";
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://rpc.katana.network");

const tokens = [
  {
    address: "0x7F1f4b4b29f5058fA32CC7a97141b8D7e5ABDC2d",
    decimals: 18,
    symbol: "KAT",
  },
  {
    address: "0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36",
    decimals: 6,
    symbol: "USDC",
  },
];

const abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

async function getBalances(userAddress: string) {
  const results: any = [];
  for (const token of tokens) {
    const contract = new ethers.Contract(token.address, abi, provider);
    const balance = await contract.balanceOf(userAddress);
    // Optionally fetch decimals dynamically:
    // const decimals = await contract.decimals();
    results.push({
      symbol: token.symbol,
      balance: ethers.formatUnits(balance, token.decimals),
    });
  }
  return results;
}

export async function getKatanaBalance(
  req: Request,
  res: Response,
  _next: NextFunction
) {
  try {
    const { address } = req.query;

    if (!address) {
      res.status(400).json({ status: "error", message: "provide address" });
    }

    const ethBalance = await provider.getBalance(address as string);
    const balanceArr = await getBalances(address as string);

    balanceArr.push({
      symbol: "ETH",
      balance: ethers.formatEther(ethBalance), // Convert BigInt to string
    });

    res.status(200).json({ data: balanceArr });
  } catch (error) {
    console.error("getKatanaBalance", error);
    res.status(500).json({
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

// SushiswapV2 Factory and ABI
const FACTORY_ADDRESS = "0x203e8740894c8955cB8950759876d7E7E45E04c1";
const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
];

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function fee() external view returns (uint24)",
];

const USDC_ADDRESS = "0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36";

const FEE_TIERS = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%

// Helper function to calculate price from sqrtPriceX96
function calculatePrice(
  sqrtPriceX96: bigint,
  token0Address: string,
  tokenAddress: string,
  decimals0: number | bigint,
  decimals1: number | bigint
): number {
  console.log(`\n=== Price Calculation Debug ===`);
  console.log(`sqrtPriceX96: ${sqrtPriceX96}`);
  console.log(`token0: ${token0Address}`);
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
    `price in human units (${dec1} decimals token1 per ${dec0} decimals token0): ${priceToken1PerToken0}`
  );

  // Determine what price we want to return
  const isToken0 = token0Address.toLowerCase() === tokenAddress.toLowerCase();
  console.log(`is requested token token0? ${isToken0}`);

  let finalPrice;
  if (isToken0) {
    // We want price of token0 in terms of token1 (USDC per WETH doesn't make sense)
    // So we want token1 per token0, which is what we calculated
    finalPrice = priceToken1PerToken0;
    console.log(`returning token1/token0 price: ${finalPrice}`);
  } else {
    // We want price of token1 in terms of token0 (USDC per WETH)
    finalPrice = 1 / priceToken1PerToken0;
    console.log(`returning inverted price (token0/token1): ${finalPrice}`);
  }

  console.log(`final price: ${finalPrice}`);
  console.log(`=== End Debug ===\n`);

  return finalPrice;
}

async function findPoolWithLiquidity(
  factory: ethers.Contract,
  tokenA: string,
  tokenB: string
) {
  for (const fee of FEE_TIERS) {
    try {
      const poolAddress = await factory.getPool(tokenA, tokenB, fee);

      if (poolAddress && poolAddress !== ethers.ZeroAddress) {
        // Check if pool has liquidity by calling slot0
        const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
        const slot0 = await pool.slot0();

        // If sqrtPriceX96 is not zero, the pool has been initialized
        if (slot0.sqrtPriceX96 > 0n) {
          return { poolAddress, fee, slot0 };
        }
      }
    } catch (error) {
      // Continue to next fee tier if this one fails
      console.log(`Failed to get pool for fee ${fee}:`, error);
    }
  }
  return null;
}

export async function getKatanaPrice(
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
        // Check for common token addresses that use different decimals
        const getTokenDecimals = (address: string) => {
          const addr = address.toLowerCase();
          if (addr === USDC_ADDRESS.toLowerCase()) return 6;
          // Common WBTC-like tokens use 8 decimals
          if (
            addr.includes("btc") ||
            addr === "0x0913da6da4b42f538b445599b46bb4622342cf52"
          )
            return 8;
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
    console.error("getKatanaPrice", error);
    res.status(500).json({
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
