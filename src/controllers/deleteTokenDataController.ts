// File: src/controllers/deleteTokenDataController.ts

import type { Request, Response } from "express";
import KatanaSwap from "../models/KatanaSwap";
import { deleteValue } from "../redis/katanaTokens";

const FULL_SWAP_DATA_PREFIX = "full_swaps_katana_";

export async function deleteTokenData(
  req: Request<{ tokenAddress: string }>,
  res: Response
): Promise<void> {
  const { tokenAddress } = req.params;

  if (!tokenAddress) {
    res.status(400).json({
      status: "error",
      message: "tokenAddress parameter is required",
    });
    return;
  }

  const normalizedAddress = tokenAddress.toLowerCase();
  const batchSize = 1000;
  let totalDeleted = 0;

  try {
    console.log(`[Delete Token] Starting deletion for ${normalizedAddress}`);

    // Delete from MySQL in batches
    while (true) {
      const deleted = await KatanaSwap.destroy({
        where: { token_address: normalizedAddress },
        limit: batchSize,
      });

      if (deleted === 0) break;

      totalDeleted += deleted;
      console.log(`[Delete Token] Deleted ${deleted} rows | Total: ${totalDeleted}`);

      // Small delay to let MySQL purge undo logs
      await new Promise((r) => setTimeout(r, 500));
    }

    // Delete from Redis
    const redisKey = `${FULL_SWAP_DATA_PREFIX}${normalizedAddress}`;
    await deleteValue(redisKey);
    console.log(`[Delete Token] Cleared Redis cache: ${redisKey}`);

    console.log(`[Delete Token] ✓ Complete: ${totalDeleted} rows deleted from MySQL + Redis cleared`);

    res.status(200).json({
      status: "success",
      message: "Token data deleted successfully",
      tokenAddress: normalizedAddress,
      rowsDeleted: totalDeleted,
      redisCleared: true,
    });

  } catch (error: any) {
    console.error(`[Delete Token] Error:`, error);
    res.status(500).json({
      status: "error",
      message: "Failed to delete token data",
      error: error.message,
      tokenAddress: normalizedAddress,
      rowsDeleted: totalDeleted,
    });
  }
}