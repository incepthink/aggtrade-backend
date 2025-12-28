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
    const feeUpdateResult = await updateLimitOrderFeesFromSDK(weekStart, weekEnd, testWalletAddress)
    console.log("Fee update summary:")
    console.log("  Total orders found: ", feeUpdateResult.totalOrders)
    console.log("  Wallets processed: ", feeUpdateResult.walletsProcessed)
    console.log("  Fees updated: ", feeUpdateResult.feesUpdated)
    console.log("  Orders not found in SDK: ", feeUpdateResult.ordersNotFoundInSDK)
    if (feeUpdateResult.errors.length > 0) {
        console.log("  Errors: ", feeUpdateResult.errors)
    }

    // Step 2: Fetch swaps for this week (both CLASSIC and LIMIT_ORDER)
    const whereClause: any = {
        swap_type: {
            [Op.in]: ['CLASSIC', 'LIMIT_ORDER']
        },
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

    const allSwaps = await SushiswapActivity.findAll({ where: whereClause })

    if (allSwaps.length === 0) {
        console.log("\n⚠️  No swaps found for the specified criteria")

        // If testing a specific wallet, store 0 XP record
        if (testWalletAddress) {
            console.log(`\n📝 Storing 0 XP record for wallet: ${testWalletAddress}`)

            // Find user_id if exists
            const user = await User.findOne({ where: { wallet_address: testWalletAddress.toLowerCase() } })

            try {
                const [xpRecord, created] = await XpDistribution.upsert({
                    wallet_address: testWalletAddress.toLowerCase(),
                    user_id: user?.id || null,
                    week_start: weekStart,
                    week_end: weekEnd,
                    league: 'bronze' as 'bronze' | 'silver' | 'gold' | 'diamond',
                    swap_xp_raw: 0,
                    swap_xp_decayed: 0,
                    pair_bonus_xp: 0,
                    total_xp: 0,
                    eligible_volume: 0,
                    total_fees: 0,
                    unique_pairs_count: 0,
                    new_pairs_count: 0,
                    total_swaps: 0,
                    metadata: {
                        perPairResults: [],
                        newPairs: [],
                        feeUpdateSummary: {
                            ordersProcessed: feeUpdateResult.totalOrders,
                            feesUpdated: feeUpdateResult.feesUpdated
                        },
                        swapTypeBreakdown: {
                            classic: 0,
                            limitOrder: 0,
                            total: 0
                        },
                        note: "No swaps found for this period"
                    },
                    calculated_at: new Date()
                })

                console.log(`✅ 0 XP record saved to database (${created ? 'created' : 'updated'})`)
            } catch (error) {
                console.error(`❌ Failed to save 0 XP record to database:`, error)
            }
        }

        return
    }

    // Step 3: Group by wallet and process each wallet
    const walletGroups = new Map<string, typeof allSwaps>()
    for (const swap of allSwaps) {
        const wallet = swap.wallet_address
        if (!walletGroups.has(wallet)) {
            walletGroups.set(wallet, [])
        }
        walletGroups.get(wallet)!.push(swap)
    }

    console.log(`\n=== PROCESSING ${walletGroups.size} WALLET(S) ===\n`)

    let processedCount = 0
    let savedCount = 0

    // Process each wallet
    for (const [walletAddress, swaps] of walletGroups.entries()) {
        processedCount++
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
        console.log(`📊 Wallet ${processedCount}/${walletGroups.size}: ${walletAddress}`)
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

        // Calculate swap type breakdown
        const classicSwaps = swaps.filter(s => s.swap_type === 'CLASSIC')
        const limitOrderSwaps = swaps.filter(s => s.swap_type === 'LIMIT_ORDER')

        console.log("\n=== SWAP TYPE BREAKDOWN ===")
        console.log("Total Swaps: ", swaps.length)
        console.log("  Classic swaps: ", classicSwaps.length)
        console.log("  Limit order swaps: ", limitOrderSwaps.length)

        // Get per-pair eligible volumes and fees
        const { perPairData, totalEligibleVolume, totalFees } = getEligibleVolumeAndFees(swaps)

        console.log("\n=== ELIGIBLE VOLUME SUMMARY ===")
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

        const userId = swaps[0].user_id
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
                total_swaps: swaps.length,
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
                    },
                    swapTypeBreakdown: {
                        classic: classicSwaps.length,
                        limitOrder: limitOrderSwaps.length,
                        total: swaps.length,
                        classicVolume: classicSwaps.reduce((sum, s) => sum + Number(s.usd_volume), 0),
                        limitOrderVolume: limitOrderSwaps.reduce((sum, s) => sum + Number(s.usd_volume), 0)
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