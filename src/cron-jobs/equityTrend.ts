// balanceJob.ts
import cron from "node-cron";
import getEtherBalanceUSD, { getErc20BalanceUSD } from "./utils/etherBalance";
import calculateCumulatedValue from "./utils/yearnfiBalance";
import User from "../models/User";
import BalanceHistory from "../models/BalanceHistory";
import { KatanaLogger, generateCorrelationId } from "../utils/logger";

// Function to update balance for a single user
async function updateUserBalance(userId: number, walletAddress: string) {
  // Generate correlation ID for tracking this user's processing
  const correlationId = generateCorrelationId();
  const prefix = `[EquityTrend:${correlationId}]`;

  try {
    KatanaLogger.info(prefix, "Processing user balance", {
      userId,
      walletAddress: walletAddress.substring(0, 10) + "...",
      correlationId
    });

    // Check if balance update is needed (minute-level check)
    const needsUpdate = await User.needsBalanceUpdate(walletAddress, 747474);

    if (!needsUpdate) {
      KatanaLogger.info(prefix, "User already updated, skipping", {
        walletAddress: walletAddress.substring(0, 10) + "...",
        correlationId
      });
      return { success: true, walletAddress, skipped: true };
    }

    // Fetch ETH balance, Yearn vaults balance, and ERC20 balance in parallel
    // Each function has built-in retry logic at the API call level
    const [etherBalUSD, yearnfiBalUSD, erc20BalanceUSD] = await Promise.all([
      getEtherBalanceUSD(walletAddress).catch(() => null),
      calculateCumulatedValue(walletAddress).catch(() => null),
      getErc20BalanceUSD(walletAddress).catch(() => null)
    ]);

    // Validate all balances - handle null and NaN
    const isEtherValid = etherBalUSD !== null && Number.isFinite(etherBalUSD);
    const isYearnfiValid = yearnfiBalUSD !== null && Number.isFinite(yearnfiBalUSD);
    const isErc20Valid = erc20BalanceUSD !== null && Number.isFinite(erc20BalanceUSD);

    // Count valid balances
    const validBalancesCount = [isEtherValid, isYearnfiValid, isErc20Valid].filter(Boolean).length;

    // If ALL balances are invalid, throw error
    if (validBalancesCount === 0) {
      KatanaLogger.error(prefix, "All balance components failed", undefined, {
        walletAddress: walletAddress.substring(0, 10) + "...",
        ethValid: isEtherValid,
        yearnValid: isYearnfiValid,
        erc20Valid: isErc20Valid,
        correlationId
      });

      throw new Error("All balance components failed");
    }

    // If some balances are invalid, log warning but continue with partial data
    if (validBalancesCount < 3) {
      KatanaLogger.warn(prefix, "Partial balance data, some components failed", {
        walletAddress: walletAddress.substring(0, 10) + "...",
        validCount: validBalancesCount,
        ethValid: isEtherValid,
        yearnValid: isYearnfiValid,
        erc20Valid: isErc20Valid,
        correlationId
      });
    }

    // Calculate total balance using only valid components (treat invalid as 0)
    const totalBalanceUSD =
      (isEtherValid ? etherBalUSD : 0) +
      (isYearnfiValid ? yearnfiBalUSD : 0) +
      (isErc20Valid ? erc20BalanceUSD : 0);

    // Store balance in history and update last check time in parallel
    await Promise.all([
      BalanceHistory.recordBalance(userId, totalBalanceUSD.toString()),
      User.updateLastCheck(walletAddress, 747474)
    ]);

    // Log success with balance breakdown
    KatanaLogger.info(prefix, "User balance updated successfully", {
      walletAddress: walletAddress.substring(0, 10) + "...",
      totalUSD: totalBalanceUSD.toFixed(2),
      ethUSD: isEtherValid ? etherBalUSD?.toFixed(2) : 'N/A',
      yearnUSD: isYearnfiValid ? yearnfiBalUSD?.toFixed(2) : 'N/A',
      erc20USD: isErc20Valid ? erc20BalanceUSD?.toFixed(2) : 'N/A',
      correlationId
    });

    return { success: true, walletAddress, balance: totalBalanceUSD, skipped: false };
  } catch (error: any) {
    KatanaLogger.error(prefix, "Failed to update user balance", error, {
      walletAddress: walletAddress.substring(0, 10) + "...",
      correlationId
    });
    return { success: false, walletAddress, error: error?.message };
  }
}

// Main cron job function
async function runEquityTrendUpdate() {
  const startTime = Date.now();
  const prefix = "[EquityTrendCron]";

  KatanaLogger.info(prefix, "Starting equity trend update", {
    timestamp: new Date().toISOString()
  });

  try {
    // Get all active users from database
    const activeUsers = await User.getActiveUsers(747474);

    if (activeUsers.length === 0) {
      KatanaLogger.info(prefix, "No active users to update");
      return;
    }

    KatanaLogger.info(prefix, "Retrieved active users", {
      totalUsers: activeUsers.length
    });

    // Process all users with rate limiting (batch of 5 at a time)
    const batchSize = 5;
    const results = [];
    const totalBatches = Math.ceil(activeUsers.length / batchSize);

    for (let i = 0; i < activeUsers.length; i += batchSize) {
      const batch = activeUsers.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;

      // Only log progress every 3 batches to reduce log spam
      if (batchNum % 3 === 1 || batchNum === totalBatches) {
        KatanaLogger.progress(prefix, batchNum, totalBatches, {
          batchNumber: batchNum
        });
      }

      const batchResults = await Promise.all(
        batch.map((user: any) =>
          updateUserBalance(user.id, user.wallet_address)
        )
      );

      results.push(...batchResults);

      // Add delay between batches to avoid overwhelming APIs
      if (i + batchSize < activeUsers.length) {
        await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay
      }
    }

    // Calculate statistics
    const successful = results.filter((r) => r.success && !r.skipped).length;
    const skipped = results.filter((r) => r.success && r.skipped).length;
    const failed = results.filter((r) => !r.success).length;
    const failedUsers = results.filter((r) => !r.success).map(r => r.walletAddress.substring(0, 10) + "...");

    // Performance logging
    KatanaLogger.performance(prefix, "equity_trend_update", startTime, {
      totalUsers: activeUsers.length,
      successful,
      skipped,
      failed
    });

    // Log failed users if any
    if (failed > 0) {
      KatanaLogger.warn(prefix, "Some users failed to update", {
        failedCount: failed,
        failedUsers: failedUsers.slice(0, 10) // Only log first 10
      });
    }

    KatanaLogger.info(prefix, "Equity trend update completed", {
      totalUsers: activeUsers.length,
      successful,
      skipped,
      failed,
      successRate: `${((successful / activeUsers.length) * 100).toFixed(1)}%`
    });

  } catch (error: any) {
    KatanaLogger.error(prefix, "Fatal error in cron job", error);
  }
}

// Schedule cron job to run every 4 hours
// Pattern: "0 */4 * * *" = At minute 0 past every 4th hour
cron.schedule("0 */4 * * *", async () => {
  await runEquityTrendUpdate();
});

// Run immediately on startup for testing
(async () => {
  const prefix = "[EquityTrendStartup]";
  KatanaLogger.info(prefix, "Starting equity trend tracker");
  KatanaLogger.info(prefix, "Scheduled to run every 4 hours");
  KatanaLogger.info(prefix, "Running initial update now");

  await runEquityTrendUpdate();
})();

KatanaLogger.info("[EquityTrendCron]", "Equity trend tracker initialized and scheduled");