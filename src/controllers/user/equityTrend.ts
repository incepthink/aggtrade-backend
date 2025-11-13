import type { Request, Response, NextFunction } from "express";
import User from "../../models/User";
import getEtherBalanceUSD, { getErc20BalanceUSD } from "../../cron-jobs/utils/etherBalance";
import calculateCumulatedValue from "../../cron-jobs/utils/yearnfiBalance";
import BalanceHistory from "../../models/BalanceHistory";
import { getKatanaBalance, updateTokenAddressesForUser } from "../katanaRoutes";

// Retry utility with exponential backoff
const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<T> => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;

      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error("Max retries exceeded");
};

// Filter out incomplete data points that show V-pattern (drop then recovery)
const filterIncompleteDataPoints = (
  balanceHistory: any[],
  dropThreshold = 30,
  riseThreshold = 40
): any[] => {
  if (balanceHistory.length <= 2) {
    // Not enough data to detect patterns
    return balanceHistory;
  }

  const filtered: any[] = [];
  let filteredCount = 0;

  for (let i = 0; i < balanceHistory.length; i++) {
    const current = parseFloat(balanceHistory[i].balance_usd);

    // Always keep first and last points (can't check patterns)
    if (i === 0 || i === balanceHistory.length - 1) {
      filtered.push(balanceHistory[i]);
      continue;
    }

    const previous = parseFloat(balanceHistory[i - 1].balance_usd);
    const next = parseFloat(balanceHistory[i + 1].balance_usd);

    // Calculate percentage changes
    const dropPercent = ((previous - current) / previous) * 100;
    const risePercent = ((next - current) / current) * 100;

    // Check for V-pattern: significant drop from previous AND significant rise to next
    const isIncomplete = dropPercent > dropThreshold && risePercent > riseThreshold;

    if (isIncomplete) {
      filteredCount++;
      console.log(
        `[Filter Incomplete Data] Removing point at ${balanceHistory[i].timestamp}: ` +
        `balance=${current.toFixed(2)} (${dropPercent.toFixed(1)}% drop, ${risePercent.toFixed(1)}% rise)`
      );
    } else {
      filtered.push(balanceHistory[i]);
    }
  }

  if (filteredCount > 0) {
    console.log(`[Filter Incomplete Data] Filtered out ${filteredCount} incomplete data points`);
  }

  return filtered;
};

const updateBalanceHistory = async (address: string) => {
  try {
    const chainId = 747474;

    // Check if balance update is needed (minute-level check)
    const needsUpdate = await User.needsBalanceUpdate(address, chainId);
    
    if (!needsUpdate) {
      console.log(`[Update Balance History] Skipping - already updated this minute for ${address}`);
      return null;
    }

    // Find or create user
    const { user } = await User.findOrCreateUser(address, chainId);

    // Reactivate if inactive
    if (!user.is_active) {
      await user.update({ is_active: true });
    }

    // Fetch current balance data in parallel with retry logic (functions now return null on failure)
    const [etherBalUSD, yearnfiBalUSD, erc20BalanceUSD] = await Promise.all([
      retryWithBackoff(() => getEtherBalanceUSD(address)).catch(() => null),
      retryWithBackoff(() => calculateCumulatedValue(address)).catch(() => null),
      retryWithBackoff(() => getErc20BalanceUSD(address)).catch(() => null)
    ]);

    // Validate all balances - handle null and NaN
    const isEtherValid = etherBalUSD !== null && Number.isFinite(etherBalUSD);
    const isYearnfiValid = yearnfiBalUSD !== null && Number.isFinite(yearnfiBalUSD);
    const isErc20Valid = erc20BalanceUSD !== null && Number.isFinite(erc20BalanceUSD);

    // Count valid balances
    const validBalancesCount = [isEtherValid, isYearnfiValid, isErc20Valid].filter(Boolean).length;

    // If ALL balances are invalid, throw error
    if (validBalancesCount === 0) {
      console.error(
        `[Update Balance History] All balance components failed for ${address}`
      );

      throw new Error(
        `Cannot store balance - all balance components failed`
      );
    }

    // If some balances are invalid, log warning but continue with partial data
    if (validBalancesCount < 3) {
      const invalidBalances = [];
      if (!isEtherValid) invalidBalances.push(`etherBalUSD: ${etherBalUSD}`);
      if (!isYearnfiValid) invalidBalances.push(`yearnfiBalUSD: ${yearnfiBalUSD}`);
      if (!isErc20Valid) invalidBalances.push(`erc20BalanceUSD: ${erc20BalanceUSD}`);

      console.warn(
        `[Update Balance History] Partial balance data for ${address}. Invalid values: ${invalidBalances.join(', ')}`
      );
    }

    // Calculate total balance using only valid components (treat invalid as 0)
    const totalBalanceUSD =
      (isEtherValid ? etherBalUSD : 0) +
      (isYearnfiValid ? yearnfiBalUSD : 0) +
      (isErc20Valid ? erc20BalanceUSD : 0);

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
    const balanceResult = await updateBalanceHistory(walletAddress);

    // If balance was skipped (already updated this minute), fetch the last recorded balance
    let responseData;
    if (!balanceResult) {
      const lastBalance = await BalanceHistory.getUserHistory(user.id, undefined, undefined, 1);
      const lastBalanceUSD = lastBalance.length > 0 ? parseFloat(lastBalance[0].balance_usd) : 0;
      
      responseData = {
        userId: user.id,
        walletAddress: user.wallet_address,
        chainId: user.chain_id,
        totalBalanceUSD: lastBalanceUSD.toFixed(2),
        isNewUser: created,
        cached: true // Indicate this is cached data
      };
    } else {
      const { userId, etherBalUSD, yearnfiBalUSD, totalBalanceUSD } = balanceResult;
      responseData = {
        userId,
        walletAddress: user.wallet_address,
        chainId: user.chain_id,
        etherBalanceUSD: etherBalUSD !== null ? etherBalUSD.toFixed(2) : 'N/A',
        yearnfiBalanceUSD: yearnfiBalUSD !== null ? yearnfiBalUSD.toFixed(2) : 'N/A',
        totalBalanceUSD: totalBalanceUSD.toFixed(2),
        isNewUser: created,
        cached: false
      };
    }

    // Return response
    res.status(200).json({
      status: "success",
      msg: created ? "User registered for equity tracking" : "User data updated",
      data: responseData,
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

    // Step 2: Get balance history for the user (current data)
    const balanceHistory = await BalanceHistory.getUserHistory(
      user.id,
      undefined, // startDate - get all history
      undefined, // endDate - get all history
      undefined  // limit - get all records
    );

    // Step 2.5: Filter out incomplete data points (V-pattern detection)
    const filteredBalanceHistory = filterIncompleteDataPoints(balanceHistory);

    // Step 3: Format data for chart
    const chartData = filteredBalanceHistory.map((record: any) => ({
      timestamp: record.timestamp,
      balance: parseFloat(record.balance_usd),
      // Format date for display (optional)
      date: new Date(record.timestamp).toLocaleString(),
    }));

    // Step 4: Return response immediately
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

    // Step 5: Update balance history in the background (only if needed)
    updateBalanceHistory(userAddress).catch(error => {
      console.error("[Background Balance Update] Error:", error);
      // Log but don't throw - this is a background task
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