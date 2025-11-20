import type { Request, Response, NextFunction } from "express";
import User from "../../models/User";
import { verifyMessage } from "ethers";

export const getUserSignature = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { wallet } = req.query;

    // Validate wallet address
    if (!wallet || typeof wallet !== 'string' || !/^0x[a-fA-F0-9]{40}$/i.test(wallet)) {
      return res.status(400).json({
        status: "error",
        msg: "Invalid wallet address",
      });
    }

    // Find user by wallet
    const user = await User.findByWallet(wallet.toLowerCase());

    // Check if signature exists
    const exists = !!(user && user.signature);

    res.status(200).json({
      exists
    });
  } catch (error: any) {
    console.error("[Get User Signature] Error:", error);

    res.status(500).json({
      status: "error",
      msg: "Failed to check signature",
      debug: { error: error?.message ?? String(error) },
    });
  }
};

export const storeUserSignature = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { wallet, signature, message, timestamp } = req.body;

    // Validate required fields
    if (!wallet || !signature || !message) {
      return res.status(400).json({
        status: "error",
        msg: "Missing required fields: wallet, signature, message",
      });
    }

    // Validate wallet address format
    if (!/^0x[a-fA-F0-9]{40}$/i.test(wallet)) {
      return res.status(400).json({
        status: "error",
        msg: "Invalid wallet address format",
      });
    }

    // Verify signature
    let recoveredAddress: string;
    try {
      recoveredAddress = verifyMessage(message, signature);
    } catch (error) {
      return res.status(400).json({
        status: "error",
        msg: "Invalid signature",
      });
    }

    // Check if recovered address matches wallet
    if (recoveredAddress.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(400).json({
        status: "error",
        msg: "Signature does not match wallet address",
      });
    }

    // Find or create user
    const { user } = await User.findOrCreateUser(wallet.toLowerCase());

    // Check if signature already exists
    if (user.signature) {
      return res.status(400).json({
        status: "error",
        msg: "Signature already exists for this wallet",
      });
    }

    // Store signature
    await user.update({ signature });

    res.status(200).json({
      status: "success",
      msg: "Signature stored successfully",
    });
  } catch (error: any) {
    console.error("[Store User Signature] Error:", error);

    res.status(500).json({
      status: "error",
      msg: "Failed to store signature",
      debug: { error: error?.message ?? String(error) },
    });
  }
}