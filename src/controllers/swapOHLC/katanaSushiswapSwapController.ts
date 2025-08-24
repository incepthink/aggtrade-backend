// src/controllers/katanaSushiswapSwapController.ts
import type { Request, Response, NextFunction } from "express";
import { getValue, storeValue } from "../../redis/katanaTokens";
import { BaseSushiswapController } from "./baseSushiswapController";
import { CHAIN_CONFIGS } from "../../config/sushiswap";

class KatanaSushiswapController extends BaseSushiswapController {
  constructor() {
    super(CHAIN_CONFIGS.katana);
    this.initRedis();
  }

  protected initRedis(): void {
    this.setRedisOperations({
      getValue,
      storeValue,
      // deleteValue // Add if you have a delete function in katanaTokens
    });
  }
}

const katanaController = new KatanaSushiswapController();

/**
 * Get Katana swap data with incremental updates
 */
export async function getKatanaSwapData(
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
  return katanaController.getSwapData(req, res, next);
}

/**
 * Clear cache for a specific token on Katana (for debugging/admin)
 */
export async function clearKatanaSwapCache(
  req: Request<{}, {}, {}, { tokenAddress?: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  return katanaController.clearSwapCache(req, res, next);
}