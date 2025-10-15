// balanceJob.ts
import cron from "node-cron";
import getEtherBalanceUSD, { getErc20BalanceUSD } from "./utils/etherBalance";
import calculateCumulatedValue from "./utils/yearnfiBalance";
import User from "../models/User";
import BalanceHistory from "../models/BalanceHistory";

// Function to update balance for a single user
async function updateUserBalance(userId: number, walletAddress: string) {
  try {
    console.log(`[Balance Update] Processing user: ${walletAddress}`);

    // Fetch ETH balance and Yearn vaults balance in parallel
    const [etherBalUSD, yearnfiBalUSD, erc20BalanceUSD] = await Promise.all([
      getEtherBalanceUSD(walletAddress),
      calculateCumulatedValue(walletAddress),
      getErc20BalanceUSD(walletAddress)
    ]);

    // Calculate total balance
    const totalBalanceUSD = etherBalUSD + yearnfiBalUSD + erc20BalanceUSD;

    // Store balance in history
    await BalanceHistory.recordBalance(userId, totalBalanceUSD.toString());

    // Update last balance check timestamp
    await User.updateLastCheck(walletAddress, 747474);

    console.log(
      `[Balance Update] Success for ${walletAddress}: $${totalBalanceUSD.toFixed(2)}`
    );

    return { success: true, walletAddress, balance: totalBalanceUSD };
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
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    console.log("\n===========================================");
    console.log(`[Cron Job] Completed equity trend update`);
    console.log(`[Cron Job] Total users: ${activeUsers.length}`);
    console.log(`[Cron Job] Successful: ${successful}`);
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