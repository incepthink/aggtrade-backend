// balanceJob.ts
import cron from "node-cron";
import getEtherBalanceUSD, { getErc20BalanceUSD } from "./utils/etherBalance";
import calculateCumulatedValue from "./utils/yearnfiBalance";
import User from "../models/User";
import BalanceHistory from "../models/BalanceHistory";

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

// Function to update balance for a single user
async function updateUserBalance(userId: number, walletAddress: string) {
  try {
    console.log(`[Balance Update] Processing user: ${walletAddress}`);

    // Check if balance update is needed (minute-level check)
    const needsUpdate = await User.needsBalanceUpdate(walletAddress, 747474);
    
    if (!needsUpdate) {
      console.log(`[Balance Update] Skipping ${walletAddress} - already updated this minute`);
      return { success: true, walletAddress, skipped: true };
    }

    // Fetch ETH balance and Yearn vaults balance in parallel with retry logic
    const [etherBalUSD, yearnfiBalUSD, erc20BalanceUSD] = await Promise.all([
      retryWithBackoff(() => getEtherBalanceUSD(walletAddress)),
      retryWithBackoff(() => calculateCumulatedValue(walletAddress)),
      retryWithBackoff(() => getErc20BalanceUSD(walletAddress))
    ]);

    // Validate all balances are valid numbers
    const isEtherValid = Number.isFinite(etherBalUSD);
    const isYearnfiValid = Number.isFinite(yearnfiBalUSD);
    const isErc20Valid = Number.isFinite(erc20BalanceUSD);

    // Check if all balances are valid
    if (!isEtherValid || !isYearnfiValid || !isErc20Valid) {
      const invalidBalances = [];
      if (!isEtherValid) invalidBalances.push(`etherBalUSD: ${etherBalUSD}`);
      if (!isYearnfiValid) invalidBalances.push(`yearnfiBalUSD: ${yearnfiBalUSD}`);
      if (!isErc20Valid) invalidBalances.push(`erc20BalanceUSD: ${erc20BalanceUSD}`);
      
      console.error(
        `[Balance Update] Incomplete balance data for ${walletAddress}. Invalid values: ${invalidBalances.join(', ')}`
      );
      
      throw new Error(
        `Cannot store incomplete balance. Invalid values: ${invalidBalances.join(', ')}`
      );
    }

    // Calculate total balance
    const totalBalanceUSD = etherBalUSD + yearnfiBalUSD + erc20BalanceUSD;

    // Store balance in history and update last check time in parallel
    await Promise.all([
      BalanceHistory.recordBalance(userId, totalBalanceUSD.toString()),
      User.updateLastCheck(walletAddress, 747474)
    ]);

    console.log(
      `[Balance Update] Success for ${walletAddress}: $${totalBalanceUSD.toFixed(2)} (ETH: $${etherBalUSD.toFixed(2)}, Yearnfi: $${yearnfiBalUSD.toFixed(2)}, ERC20: $${erc20BalanceUSD.toFixed(2)})`
    );

    return { success: true, walletAddress, balance: totalBalanceUSD, skipped: false };
  } catch (error: any) {
    console.error(
      `[Balance Update] Error for ${walletAddress}:`,
      error?.message
    );
    return { success: false, walletAddress, error: error?.message };
  }
}

// Main cron job function
async function runEquityTrendUpdate() {
  console.log("\n===========================================");
  console.log(`[Cron Job] Starting equity trend update at ${new Date().toISOString()}`);
  console.log("===========================================\n");

  try {
    // Get all active users from database
    const activeUsers = await User.getActiveUsers(747474);

    if (activeUsers.length === 0) {
      console.log("[Cron Job] No active users to update");
      return;
    }

    console.log(`[Cron Job] Found ${activeUsers.length} active users to update\n`);

    // Process all users with rate limiting (batch of 5 at a time)
    const batchSize = 5;
    const results = [];

    for (let i = 0; i < activeUsers.length; i += batchSize) {
      const batch = activeUsers.slice(i, i + batchSize);
      
      console.log(`[Cron Job] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(activeUsers.length / batchSize)}`);

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

    // Summary
    const successful = results.filter((r) => r.success && !r.skipped).length;
    const skipped = results.filter((r) => r.success && r.skipped).length;
    const failed = results.filter((r) => !r.success).length;

    console.log("\n===========================================");
    console.log(`[Cron Job] Completed equity trend update`);
    console.log(`[Cron Job] Total users: ${activeUsers.length}`);
    console.log(`[Cron Job] Successfully updated: ${successful}`);
    console.log(`[Cron Job] Skipped (already updated): ${skipped}`);
    console.log(`[Cron Job] Failed: ${failed}`);
    console.log("===========================================\n");
  } catch (error: any) {
    console.error("[Cron Job] Fatal error:", error?.message);
  }
}

// Schedule cron job to run every 4 hours
// Pattern: "0 */4 * * *" = At minute 0 past every 4th hour
cron.schedule("0 */4 * * *", async () => {
  await runEquityTrendUpdate();
});

// Run immediately on startup (optional - remove if you don't want this)
// (async () => {
//   console.log("[Cron Job] Starting equity trend tracker...");
//   console.log("[Cron Job] Scheduled to run every 4 hours");
//   console.log("[Cron Job] Running initial update now...\n");
  
//   await runEquityTrendUpdate();
// })();

console.log("[Cron Job] Equity trend tracker is running...");