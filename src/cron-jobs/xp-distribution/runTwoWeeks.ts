import { disrtibuteXPJob } from './index'
import { getCurrentWeekRange } from './utils/timeUtils'

/**
 * Run XP Distribution for Current Week and Last Week
 *
 * This function processes XP calculations for both the current week
 * and the previous week, storing results in the xp_distributions table.
 *
 * The function runs sequentially (last week first, then current week)
 * to ensure proper order and allow early detection of issues.
 *
 * @param testWalletAddress - Optional wallet address for testing single wallet
 */
export const runCurrentAndLastWeek = async (testWalletAddress?: string) => {
  try {
    console.log("=".repeat(60))
    console.log("XP DISTRIBUTION: CURRENT WEEK + LAST WEEK")
    console.log("=".repeat(60))

    // Get current week range
    const currentWeek = getCurrentWeekRange()

    // Calculate last week's range
    const lastWeekStart = new Date(currentWeek.weekStart)
    lastWeekStart.setDate(lastWeekStart.getDate() - 7)

    const lastWeekEnd = new Date(currentWeek.weekEnd)
    lastWeekEnd.setDate(lastWeekEnd.getDate() - 7)

    // Process LAST WEEK first
    console.log("\n" + "=".repeat(60))
    console.log("PROCESSING LAST WEEK")
    console.log("=".repeat(60))
    await disrtibuteXPJob(
      { weekStart: lastWeekStart, weekEnd: lastWeekEnd },
      testWalletAddress
    )

    // Process CURRENT WEEK
    console.log("\n" + "=".repeat(60))
    console.log("PROCESSING CURRENT WEEK")
    console.log("=".repeat(60))
    await disrtibuteXPJob(currentWeek, testWalletAddress)

    console.log("\n" + "=".repeat(60))
    console.log("COMPLETED: Both weeks processed successfully!")
    console.log("=".repeat(60))
  } catch (error) {
    console.error("\n" + "=".repeat(60))
    console.error("ERROR: Failed to process XP distribution")
    console.error("=".repeat(60))
    console.error(error)
    throw error
  }
}

// ============================================================================
// USAGE EXAMPLES
// ============================================================================

// Run for all wallets in both weeks:
runCurrentAndLastWeek()

// TEST MODE: Run for single wallet in both weeks:
// runCurrentAndLastWeek('0x8c26601997966e439a4245054df2576d54a70f29')
