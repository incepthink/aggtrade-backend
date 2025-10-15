import type { Request, Response, NextFunction } from "express";
import User from "../../models/User";
import getEtherBalanceUSD, { getErc20BalanceUSD } from "../../cron-jobs/utils/etherBalance";
import calculateCumulatedValue from "../../cron-jobs/utils/yearnfiBalance";
import BalanceHistory from "../../models/BalanceHistory";
import { getKatanaBalance, updateTokenAddressesForUser } from "../katanaRoutes";

const updateBalanceHistory = async (address: string) => {
  try {
    const chainId = 747474;

    // Find or create user
    const { user } = await User.findOrCreateUser(address, chainId);

    // Reactivate if inactive
    if (!user.is_active) {
      await user.update({ is_active: true });
    }

    // Fetch current balance data in parallel
    const [etherBalUSD, yearnfiBalUSD, erc20BalanceUSD] = await Promise.all([
      getEtherBalanceUSD(address),
      calculateCumulatedValue(address),
      getErc20BalanceUSD(address)
    ]);

    const totalBalanceUSD = etherBalUSD + yearnfiBalUSD + erc20BalanceUSD;

    // Store balance snapshot and update check time in parallel
    await Promise.all([
      BalanceHistory.recordBalance(user.id, totalBalanceUSD.toString()),
      User.updateLastCheck(address, chainId)
    ]);

    return {
      userId: user.id,
      etherBalUSD,
      yearnfiBalUSD,
      erc20BalanceUSD,
      totalBalanceUSD,
    };
  } catch (error) {
    console.error("[Update Balance History] Error:", error);
    throw error;
  }
};

export const storeUserForEquityTracking = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { walletAddress } = req.body;

    // Validate wallet address
    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({
        status: "error",
        msg: "Invalid wallet address",
      });
    }

    // Get user info before updating
    const { user, created } = await User.findOrCreateUser(walletAddress, 747474);

    const data = await getKatanaBalance(walletAddress);
    
        // Update user token addresses
       await updateTokenAddressesForUser(walletAddress, data);

    // Update balance history
    const { userId, etherBalUSD, yearnfiBalUSD, totalBalanceUSD } = 
      await updateBalanceHistory(walletAddress);

    // Return response
    res.status(200).json({
      status: "success",
      msg: created ? "User registered for equity tracking" : "User data updated",
      data: {
        userId,
        walletAddress: user.wallet_address,
        chainId: user.chain_id,
        etherBalanceUSD: etherBalUSD.toFixed(2),
        yearnfiBalanceUSD: yearnfiBalUSD.toFixed(2),
        totalBalanceUSD: totalBalanceUSD.toFixed(2),
        isNewUser: created,
      },
    });
  } catch (error: any) {
    console.error("[Store User for Equity Tracking] Error:", error);

    res.status(500).json({
      status: "error",
      msg: "Failed to store user for equity tracking",
      debug: { error: error?.message ?? String(error) },
    });
  }
};


export const getEquityTrendForUser = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { userAddress } = req.params;
    const chainId = 747474; // Katana chain

    // Validate wallet address
    if (!userAddress || !/^0x[a-fA-F0-9]{40}$/i.test(userAddress)) {
      return res.status(400).json({
        status: "error",
        msg: "Invalid wallet address",
      });
    }

    // Step 1: Find user in database
    const user = await User.findByWallet(userAddress, chainId);
    console.log("token-address", user?.token_addresses);
    
    if (user?.token_addresses === null) {
      const data = await getKatanaBalance(userAddress);
    
        // Update user token addresses
       await updateTokenAddressesForUser(userAddress, data);
    }

    if (!user) {
      return res.status(404).json({
        status: "error",
        msg: "User not found. Please connect wallet first.",
      });
    }

    // Step 2: Get balance history for the user
    const balanceHistory = await BalanceHistory.getUserHistory(
      user.id,
      undefined, // startDate - get all history
      undefined, // endDate - get all history
      undefined  // limit - get all records
    );

    // Step 3: Format data for chart
    const chartData = balanceHistory.map((record: any) => ({
      timestamp: record.timestamp,
      balance: parseFloat(record.balance_usd),
      // Format date for display (optional)
      date: new Date(record.timestamp).toLocaleString(),
    }));

    // Step 4: Return response
    res.status(200).json({
      status: "success",
      msg: "Equity trend data retrieved successfully",
      data: {
        walletAddress: user.wallet_address,
        chainId: user.chain_id,
        totalRecords: chartData.length,
        history: chartData,
      },
    });
  } catch (error: any) {
    console.error("[Get Equity Trend] Error:", error);

    res.status(500).json({
      status: "error",
      msg: "Failed to fetch equity trend data",
      debug: { error: error?.message ?? String(error) },
    });
  }
};