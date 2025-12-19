import { Op } from "sequelize"
import { User, XpDistribution } from "../../models"
import SushiswapActivity from "../../models/SushiswapActivity"
import { getEligibleVolumeAndFees } from "./services/eligibleVolume"
import { determineLeague, apply_band_decay_by_pair } from "./services/bandDecay"
import { getCurrentWeekRange } from "./utils/timeUtils"
import { calculateUniquePairBonus, UniquePairBonusResult } from "./services/uniquePairBonus"
import { updateLimitOrderFeesFromSDK } from "./services/limitOrderFees"

export const disrtibuteXPJob = async (
    testWeekRange?: { weekStart: Date, weekEnd: Date },
    testWalletAddress?: string
) => {
    // // Step 0: Get the required data from DB
    // const users = await User.findAll()
    // for (const user of users) {
    //     const allUserSwaps = await SushiswapActivity.findAll({where: {user_id: user.id, status: 'success'}})

    //     // Step 1: Get the Eligible Swaps
    //     const { eligibleVolume, totalFees } = getEligibleVolumeAndFees(allUserSwaps)
    // }

    // Get week range (use testWeekRange for testing, otherwise get current week)
    const { weekStart, weekEnd } = testWeekRange || getCurrentWeekRange()
    console.log("\n=== XP DISTRIBUTION JOB ===")
    console.log("Week Start: ", weekStart.toISOString())
    console.log("Week End: ", weekEnd.toISOString())
    if (testWalletAddress) {
        console.log("TEST MODE: Processing single wallet -", testWalletAddress)
    }

    // Step 1: Update limit order fees from TWAP SDK
    console.log("\n=== UPDATING LIMIT ORDER FEES FROM SDK ===")
    const feeUpdateResult = await updateLimitOrderFeesFromSDK(weekStart, weekEnd)
    console.log("Fee update summary:")
    console.log("  Total orders found: ", feeUpdateResult.totalOrders)
    console.log("  Wallets processed: ", feeUpdateResult.walletsProcessed)
    console.log("  Fees updated: ", feeUpdateResult.feesUpdated)
    console.log("  Orders not found in SDK: ", feeUpdateResult.ordersNotFoundInSDK)
    if (feeUpdateResult.errors.length > 0) {
        console.log("  Errors: ", feeUpdateResult.errors)
    }

    // Step 2: Fetch limit orders for this week
    const whereClause: any = {
        swap_type: 'LIMIT_ORDER',
        status: 'success',
        timestamp: {
            [Op.gte]: weekStart,
            [Op.lt]: weekEnd
        }
    }

    // Filter by wallet address if testing
    if (testWalletAddress) {
        whereClause.wallet_address = testWalletAddress.toLowerCase()
    }

    const allLimitOrders = await SushiswapActivity.findAll({ where: whereClause })

    if (allLimitOrders.length === 0) {
        console.log("\n⚠️  No limit orders found for the specified criteria")
        return
    }

    // Step 3: Group by wallet and process each wallet
    const walletGroups = new Map<string, typeof allLimitOrders>()
    for (const order of allLimitOrders) {
        const wallet = order.wallet_address
        if (!walletGroups.has(wallet)) {
            walletGroups.set(wallet, [])
        }
        walletGroups.get(wallet)!.push(order)
    }

    console.log(`\n=== PROCESSING ${walletGroups.size} WALLET(S) ===\n`)

    let processedCount = 0
    let savedCount = 0

    // Process each wallet
    for (const [walletAddress, limitOrders] of walletGroups.entries()) {
        processedCount++
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
        console.log(`📊 Wallet ${processedCount}/${walletGroups.size}: ${walletAddress}`)
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

        // Get per-pair eligible volumes and fees
        const { perPairData, totalEligibleVolume, totalFees } = getEligibleVolumeAndFees(limitOrders)

        console.log("\n=== ELIGIBLE VOLUME SUMMARY ===")
        console.log("Total Swaps: ", limitOrders.length)
        console.log("Total Eligible Volume: $", totalEligibleVolume.toFixed(2))
        console.log("Total Fees: $", totalFees.toFixed(4))
        console.log("Number of Pairs: ", perPairData.length)

        if (perPairData.length > 0) {
            console.log("\nPer-Pair Breakdown:")
            perPairData.forEach(p => {
                console.log(`  ${p.pair}: EV=$${p.eligibleVolume.toFixed(2)}, Fees=$${p.totalFees.toFixed(4)}`)
            })
        }

        // Determine league based on total EV across all pairs
        const league = determineLeague(totalEligibleVolume)
        console.log("\n=== LEAGUE DETERMINATION ===")
        console.log("League: ", league.toUpperCase())
        console.log("Based on Total EV: $", totalEligibleVolume.toFixed(2))

        // Apply band decay per pair
        const { perPairResults, totalXP } = apply_band_decay_by_pair(perPairData, league)

        console.log("\n=== XP CALCULATION RESULTS ===")
        console.log("Total XP (after band decay): ", totalXP.toFixed(4))

        if (perPairResults.length > 0) {
            console.log("\nPer-Pair XP Breakdown:")
            perPairResults.forEach(r => {
                console.log(`  ${r.pair}:`)
                console.log(`    EV: $${r.eligibleVolume.toFixed(2)}`)
                console.log(`    XP (raw): ${r.xp_swap_raw.toFixed(2)}`)
                console.log(`    Decay: ${(r.decayFraction * 100).toFixed(2)}%`)
                console.log(`    XP (decayed): ${r.xp_swap_decayed.toFixed(2)}`)
            })
        }

        // Calculate unique pair bonus
        let upbResult: UniquePairBonusResult = {
            totalHistoricalPairs: 0,
            countOfNewPairs: 0,
            cappedCount: 0,
            xp_pair_bonus: 0,
            newPairs: []
        }

        const userId = limitOrders[0].user_id
        if (userId) {
            upbResult = await calculateUniquePairBonus(userId, perPairData, weekStart)
        }

        // Calculate final XP
        const finalXP = totalXP + upbResult.xp_pair_bonus

        console.log("\n=== UNIQUE PAIR BONUS ===")
        console.log("Total historical pairs: ", upbResult.totalHistoricalPairs)
        console.log("This week's eligible pairs: ", perPairData.length)
        console.log("New pairs (first-time): ", upbResult.countOfNewPairs)
        console.log("Pair bonus XP: ", upbResult.xp_pair_bonus.toFixed(4))

        console.log("\n=== FINAL XP TOTAL ===")
        console.log("XP from swaps (decayed): ", totalXP.toFixed(4))
        console.log("XP from pair bonus: ", upbResult.xp_pair_bonus.toFixed(4))
        console.log("🎯 FINAL XP: ", finalXP.toFixed(4))

        // Step 4: Save to database (upsert)
        try {
            const [xpRecord, created] = await XpDistribution.upsert({
                wallet_address: walletAddress,
                user_id: userId || null,
                week_start: weekStart,
                week_end: weekEnd,
                league: league.toLowerCase() as 'bronze' | 'silver' | 'gold' | 'diamond',
                swap_xp_raw: perPairResults.reduce((sum, r) => sum + r.xp_swap_raw, 0),
                swap_xp_decayed: totalXP,
                pair_bonus_xp: upbResult.xp_pair_bonus,
                total_xp: finalXP,
                eligible_volume: totalEligibleVolume,
                total_fees: totalFees,
                unique_pairs_count: perPairData.length,
                new_pairs_count: upbResult.countOfNewPairs,
                total_swaps: limitOrders.length,
                metadata: {
                    perPairResults: perPairResults.map(r => ({
                        pair: r.pair,
                        eligibleVolume: r.eligibleVolume,
                        totalFees: r.totalFees,
                        xp_raw: r.xp_swap_raw,
                        xp_decayed: r.xp_swap_decayed,
                        decayFraction: r.decayFraction
                    })),
                    newPairs: upbResult.newPairs,
                    feeUpdateSummary: {
                        ordersProcessed: feeUpdateResult.totalOrders,
                        feesUpdated: feeUpdateResult.feesUpdated
                    }
                },
                calculated_at: new Date()
            })

            savedCount++
            console.log(`\n✅ XP saved to database (${created ? 'created' : 'updated'})`)
        } catch (error) {
            console.error(`\n❌ Failed to save XP to database:`, error)
        }
    }

    console.log(`\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    console.log(`📈 SUMMARY`)
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    console.log(`Total wallets processed: ${processedCount}`)
    console.log(`Total records saved: ${savedCount}`)
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)
}
disrtibuteXPJob(undefined, '0xf7ef21c37b9836e61FE71bE1075FAEfFd1A7ac68')
// ============================================================================
// USAGE EXAMPLES
// ============================================================================

// Run for all wallets in current week:
// disrtibuteXPJob()

// Run for all wallets in specific week:
// disrtibuteXPJob({ weekStart: new Date('2025-01-01'), weekEnd: new Date('2025-01-08') })

// TEST MODE: Run for single wallet in current week:
// disrtibuteXPJob(undefined, '0x8c26601997966e439a4245054df2576d54a70f29')

// TEST MODE: Run for single wallet in specific week:
// disrtibuteXPJob(
//     { weekStart: new Date('2025-01-01'), weekEnd: new Date('2025-01-08') },
//     '0x8c26601997966e439a4245054df2576d54a70f29'
// )