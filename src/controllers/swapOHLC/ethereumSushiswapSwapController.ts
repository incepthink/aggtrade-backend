// src/controllers/ethereumSushiswapSwapController.ts
import type { Request, Response, NextFunction } from "express";
import { getValue, storeValue } from "../../redis/ethereumTokens";
import { BaseSushiswapController } from "./baseSushiswapController";
import { CHAIN_CONFIGS } from "../../config/sushiswap";

class EthereumSushiswapController extends BaseSushiswapController {
  constructor() {
    super(CHAIN_CONFIGS.ethereum);
    this.initRedis();
  }

  protected initRedis(): void {
    this.setRedisOperations({
      getValue,
      storeValue,
      // deleteValue // Add if you have a delete function in ethereumTokens
    });
  }
}

const ethereumController = new EthereumSushiswapController();

/**
 * Get Ethereum swap data with incremental updates
 */
export async function getEthereumSwapData(
  req: Request<
    {},
    {},
    {},
    {
      tokenAddress?: string;
      days?: string;
      force?: string;
    }
  >,
  res: Response,
  next: NextFunction
): Promise<void> {
  return ethereumController.getSwapData(req, res, next);
}

/**
 * Clear cache for a specific token on Ethereum (for debugging/admin)
 */
export async function clearEthereumSwapCache(
  req: Request<{}, {}, {}, { tokenAddress?: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  return ethereumController.clearSwapCache(req, res, next);
}