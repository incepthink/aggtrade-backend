// balanceJob.ts
import cron from "node-cron";
import getEtherBalanceUSD, { getErc20BalanceUSD } from "./utils/etherBalance";
import calculateCumulatedValue from "./utils/yearnfiBalance";
import User from "../models/User";
import BalanceHistory from "../models/BalanceHistory";
import { KatanaLogger, generateCorrelationId } from "../utils/logger";
import CronJobRun from "../models/CronJobRun";
import FailedBalanceQueue from "../models/FailedBalanceQueue";

// Type definitions for update results
type UpdateResult = {
  success: boolean;
  walletAddress: string;
  userId: number;
  skipped?: boolean;
  balance?: number;
  error?: string;
  retried?: boolean;
  abandoned?: boolean;
  willRetry?: boolean;
};

// Helper function to get current scheduled time (round to 4-hour marks: 0, 4, 8, 12, 16, 20)
function getCurrentScheduledTime(): Date {
  const now = new Date()
  const hour = Math.floor(now.getHours() / 4) * 4
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0)
}

// Function to update balance for a single user
async function updateUserBalance(userId: number, walletAddress: string): Promise<UpdateResult> {
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
      return { success: true, walletAddress, skipped: true, userId };
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

    // Convert invalid components to 'n/a' for storage
    const etherBalanceStr = isEtherValid ? etherBalUSD.toString() : 'n/a';
    const yearnfiBalanceStr = isYearnfiValid ? yearnfiBalUSD.toString() : 'n/a';
    const erc20BalanceStr = isErc20Valid ? erc20BalanceUSD.toString() : 'n/a';

    // Calculate total balance from only valid components (treat invalid as 0)
    const totalBalanceUSD =
      (isEtherValid ? etherBalUSD : 0) +
      (isYearnfiValid ? yearnfiBalUSD : 0) +
      (isErc20Valid ? erc20BalanceUSD : 0);

    // Determine status based on data completeness
    const hasIncompleteData = !isEtherValid || !isYearnfiValid || !isErc20Valid;
    const status = hasIncompleteData ? 'fail' : 'success';

    // Log warning if any components are invalid (partial data)
    if (hasIncompleteData) {
      const invalidComponents = [];
      if (!isEtherValid) invalidComponents.push('ETH');
      if (!isYearnfiValid) invalidComponents.push('Yearn');
      if (!isErc20Valid) invalidComponents.push('ERC20');

      KatanaLogger.warn(prefix, "Storing incomplete balance data with status='fail'", {
        walletAddress: walletAddress.substring(0, 10) + "...",
        invalidComponents: invalidComponents.join(', '),
        totalUSD: totalBalanceUSD.toFixed(2),
        status: 'fail',
        correlationId
      });
    }

    // Store balance in history (with component breakdown and status) and update last check time in parallel
    await Promise.all([
      BalanceHistory.recordBalance(
        userId,
        totalBalanceUSD.toString(),
        etherBalanceStr,
        yearnfiBalanceStr,
        erc20BalanceStr,
        status
      ),
      User.updateLastCheck(walletAddress, 747474)
    ]);

    // Log success with balance breakdown
    KatanaLogger.info(prefix, "User balance updated successfully", {
      walletAddress: walletAddress.substring(0, 10) + "...",
      totalUSD: totalBalanceUSD.toFixed(2),
      ethUSD: isEtherValid ? etherBalUSD.toFixed(2) : 'n/a',
      yearnUSD: isYearnfiValid ? yearnfiBalUSD.toFixed(2) : 'n/a',
      erc20USD: isErc20Valid ? erc20BalanceUSD.toFixed(2) : 'n/a',
      correlationId
    });

    return { success: true, walletAddress, balance: totalBalanceUSD, skipped: false, userId };
  } catch (error: any) {
    KatanaLogger.error(prefix, "Failed to update user balance", error, {
      walletAddress: walletAddress.substring(0, 10) + "...",
      correlationId
    });
    return { success: false, walletAddress, error: error?.message, userId };
  }
}

// Function to process retry queue
async function processRetryQueue(cronRunId: number): Promise<UpdateResult[]> {
  const prefix = "[RetryQueue]";

  const retriableUsers = await FailedBalanceQueue.getRetriableUsers();

  if (retriableUsers.length === 0) {
    return [];
  }

  KatanaLogger.info(prefix, `Processing ${retriableUsers.length} users from retry queue`);

  const results = [];

  for (const queueEntry of retriableUsers) {
    await FailedBalanceQueue.markRetrying(queueEntry.id);

    const result = await updateUserBalance(queueEntry.user_id, queueEntry.wallet_address);

    if (result.success && !result.skipped) {
      await FailedBalanceQueue.markSuccess(queueEntry.id);
      KatanaLogger.info(prefix, `Retry successful for user ${queueEntry.user_id}`);
      results.push({ ...result, retried: true });
    } else if (queueEntry.retry_count >= queueEntry.max_retries - 1) {
      await FailedBalanceQueue.markAbandoned(queueEntry.id);
      KatanaLogger.warn(prefix, `User ${queueEntry.user_id} abandoned after max retries`);
      results.push({ ...result, abandoned: true });
    } else {
      await FailedBalanceQueue.incrementRetry(queueEntry.id);
      results.push({ ...result, willRetry: true });
    }

    // Small delay between retries
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return results;
}

// Main cron job function
export async function runEquityTrendUpdate() {
  const startTime = Date.now();
  const prefix = "[EquityTrendCron]";
  const scheduledTime = getCurrentScheduledTime();

  KatanaLogger.info(prefix, "Starting equity trend update", {
    scheduledTime: scheduledTime.toISOString(),
    timestamp: new Date().toISOString()
  });

  let cronRun;

  try {
    // Get all active users from database
    const activeUsers = await User.getActiveUsers(747474);

    if (activeUsers.length === 0) {
      KatanaLogger.info(prefix, "No active users to update");
      return;
    }

    // Create cron run record
    cronRun = await CronJobRun.createRun('equity_trend_update', scheduledTime, activeUsers.length);

    KatanaLogger.info(prefix, "Retrieved active users", {
      totalUsers: activeUsers.length,
      cronRunId: cronRun.id
    });

    // STEP 1: Process retry queue first
    const retryResults = await processRetryQueue(cronRun.id);

    // STEP 2: Process regular active users (same as before)
    const batchSize = 2;
    const results = [];
    const totalBatches = Math.ceil(activeUsers.length / batchSize);

    for (let i = 0; i < activeUsers.length; i += batchSize) {
      const batch = activeUsers.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;

      if (batchNum % 5 === 1 || batchNum === totalBatches) {
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

      if (i + batchSize < activeUsers.length) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    // STEP 3: Combine results
    const allResults = [...retryResults, ...results];

    // STEP 4: Add failed users to retry queue
    const failedUsers = allResults.filter(r => !r.success && !r.skipped && !r.abandoned);

    for (const failed of failedUsers) {
      await FailedBalanceQueue.addToQueue(
        failed.userId,
        failed.walletAddress,
        cronRun.id,
        failed.error || 'Unknown error'
      );
    }

    // STEP 5: Calculate statistics
    const successful = allResults.filter((r) => r.success && !r.skipped).length;
    const skipped = allResults.filter((r) => r.success && r.skipped).length;
    const failed = failedUsers.length;
    const retriedSuccess = retryResults.filter(r => r.success && r.retried).length;

    // STEP 6: Update cron run record with final stats
    await CronJobRun.updateRunStatus(cronRun.id, 'completed', {
      successful_users: successful,
      skipped_users: skipped,
      failed_users: failed,
      duration_ms: Date.now() - startTime
    });

    // Performance logging
    KatanaLogger.performance(prefix, "equity_trend_update", startTime, {
      totalUsers: activeUsers.length,
      successful,
      skipped,
      failed,
      retriedSuccess,
      cronRunId: cronRun.id
    });

    // Log failed users if any
    if (failed > 0) {
      KatanaLogger.warn(prefix, `${failed} users failed, added to retry queue`);
    }

    KatanaLogger.info(prefix, "Equity trend update completed", {
      totalUsers: activeUsers.length,
      successful,
      skipped,
      failed,
      retriedSuccess,
      successRate: `${((successful / activeUsers.length) * 100).toFixed(1)}%`,
      cronRunId: cronRun.id
    });

  } catch (error: any) {
    KatanaLogger.error(prefix, "Fatal error in cron job", error);

    // Update cron run as failed
    if (cronRun) {
      await CronJobRun.updateRunStatus(cronRun.id, 'failed', {
        error_message: error.message,
        duration_ms: Date.now() - startTime
      });
    }
  }
}

// Schedule cron job to run every 4 hours
// Pattern: "0 */4 * * *" = At minute 0 past every 4th hour
cron.schedule("0 */4 * * *", async () => {
  await runEquityTrendUpdate();
});

// Run immediately on startup for testing
// (async () => {
//   const prefix = "[EquityTrendStartup]";
//   KatanaLogger.info(prefix, "Starting equity trend tracker");
//   KatanaLogger.info(prefix, "Scheduled to run every 4 hours");
//   KatanaLogger.info(prefix, "Running initial update now");

//   await runEquityTrendUpdate();
// })();

KatanaLogger.info("[EquityTrendCron]", "Equity trend tracker initialized and scheduled");