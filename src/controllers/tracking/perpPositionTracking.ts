import type { Request, Response, NextFunction } from "express";
import User from "../../models/User";
import PerpPosition from "../../models/PerpPosition";

interface CreatePerpPositionRequest {
  walletAddress: string;
  market: string;
  side: "LONG" | "SHORT";
  orderType: "MARKET" | "LIMIT" | "STOP_MARKET" | "STOP_LIMIT";
  leverage: number;
  quantity: string;
  openOrderId: string;
  openFillId: string;
  openTxHash: string;
  status?: "OPEN" | "CLOSED" | "LIQUIDATED" | "CANCELLED";
  entryPrice?: string | null;
  exitPrice?: string | null;
  closeOrderId?: string | null;
  closeFillId?: string | null;
  closeTxHash?: string | null;
  reduceOnly?: boolean;
  triggerPrice?: string | null;
  limitPrice?: string | null;
  openedAt?: string;
  closedAt?: string | null;
}

export const createPerpPosition = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const data: CreatePerpPositionRequest = req.body;

    const missingFields: string[] = [];
    if (!data.walletAddress) missingFields.push("walletAddress");
    if (!data.market) missingFields.push("market");
    if (!data.side) missingFields.push("side");
    if (!data.orderType) missingFields.push("orderType");
    if (data.leverage === undefined || data.leverage === null)
      missingFields.push("leverage");
    if (!data.quantity) missingFields.push("quantity");
    if (!data.openOrderId) missingFields.push("openOrderId");
    // if (!data.openFillId) missingFields.push('openFillId')
    // if (!data.openTxHash) missingFields.push('openTxHash')

    if (missingFields.length > 0) {
      return res
        .status(400)
        .json({ error: "Missing required fields", missing: missingFields });
    }

    const { user } = await User.findOrCreateUser(
      data.walletAddress.toLowerCase(),
    );

    const existing = await PerpPosition.findOne({
      where: { open_order_id: data.openOrderId },
    });
    if (existing) {
      return res
        .status(409)
        .json({ error: "Position with this open_order_id already exists" });
    }

    const position = await PerpPosition.create({
      user_id: user.id,
      wallet_address: data.walletAddress.toLowerCase(),
      market: data.market,
      side: data.side,
      order_type: data.orderType,
      status: data.status ?? "OPEN",
      leverage: data.leverage,
      quantity: String(data.quantity),
      entry_price: data.entryPrice ?? null,
      exit_price: data.exitPrice ?? null,
      open_order_id: data.openOrderId,
      close_order_id: data.closeOrderId ?? null,
      open_fill_id: data.openFillId,
      close_fill_id: data.closeFillId ?? null,
      open_tx_hash: data.openTxHash,
      close_tx_hash: data.closeTxHash ?? null,
      reduce_only: data.reduceOnly ?? false,
      trigger_price: data.triggerPrice ?? null,
      limit_price: data.limitPrice ?? null,
      opened_at: data.openedAt ? new Date(data.openedAt) : new Date(),
      closed_at: data.closedAt ? new Date(data.closedAt) : null,
    });

    return res.status(201).json({ success: true, position_id: position.id });
  } catch (error) {
    next(error);
  }
};
