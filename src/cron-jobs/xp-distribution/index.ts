import { Op } from "sequelize"
import { User } from "../../models"
import SushiswapActivity from "../../models/SushiswapActivity"
import { getEligibleVolumeAndFees } from "./services/eligibleVolume"
import { determineLeague, apply_band_decay_by_pair } from "./services/bandDecay"
import { getCurrentWeekRange } from "./utils/timeUtils"
import { calculateUniquePairBonus } from "./services/uniquePairBonus"

export const disrtibuteXPJob = async (testWeekRange?: { weekStart: Date, weekEnd: Date }) => {
    // // Step 0: Get the required data from DB
    // const users = await User.findAll()
    // for (const user of users) {
    //     const allUserSwaps = await SushiswapActivity.findAll({where: {user_id: user.id, status: 'success'}})

    //     // Step 1: Get the Eligible Swaps
    //     const { eligibleVolume, totalFees } = getEligibleVolumeAndFees(allUserSwaps)
    // }

    // Get week range (use testWeekRange for testing, otherwise get current week)
    const { weekStart, weekEnd } = testWeekRange || getCurrentWeekRange()
    console.log("\n=== WEEK RANGE ===")
    console.log("Week Start: ", weekStart.toISOString())
    console.log("Week End: ", weekEnd.toISOString())

    // Fetch user swaps for this week only
    const userSwaps = await SushiswapActivity.findAll({
        where: {
            user_id: 11,
            status: 'success',
            timestamp: {
                [Op.gte]: weekStart,
                [Op.lt]: weekEnd
            }
        }
    })

    // Get per-pair eligible volumes and fees
    const { perPairData, totalEligibleVolume, totalFees } = getEligibleVolumeAndFees(userSwaps)

    console.log("\n=== ELIGIBLE VOLUME SUMMARY ===")
    console.log("Total Eligible Volume: ", totalEligibleVolume)
    console.log("Total Fees: ", totalFees)
    console.log("Number of Pairs: ", perPairData.length)
    console.log("\nPer-Pair Breakdown:")
    perPairData.forEach(p => {
        console.log(`  ${p.pair}: EV=$${p.eligibleVolume.toFixed(2)}, Fees=$${p.totalFees.toFixed(2)}`)
    })

    // Determine league based on total EV across all pairs
    const league = determineLeague(totalEligibleVolume)
    console.log("\n=== LEAGUE DETERMINATION ===")
    console.log("League: ", league)
    console.log("Based on Total EV: $", totalEligibleVolume)

    // Apply band decay per pair
    const { perPairResults, totalXP } = apply_band_decay_by_pair(perPairData, league)

    console.log("\n=== XP CALCULATION RESULTS ===")
    console.log("Total XP (after band decay): ", totalXP)
    console.log("\nPer-Pair XP Breakdown:")
    perPairResults.forEach(r => {
        console.log(`  ${r.pair}:`)
        console.log(`    EV: $${r.eligibleVolume.toFixed(2)}`)
        console.log(`    XP (raw): ${r.xp_swap_raw.toFixed(2)}`)
        console.log(`    Decay fraction: ${r.decayFraction.toFixed(4)} (${(r.decayFraction * 100).toFixed(2)}%)`)
        console.log(`    XP (decayed): ${r.xp_swap_decayed.toFixed(2)}`)
    })

    // Calculate unique pair bonus
    const upbResult = await calculateUniquePairBonus(11, perPairData, weekStart)

    // Calculate final XP
    const finalXP = totalXP + upbResult.xp_pair_bonus

    // Display unique pair bonus results
    console.log("\n=== UNIQUE PAIR BONUS ===")
    console.log("Total historical pairs: ", upbResult.totalHistoricalPairs)
    console.log("This week's eligible pairs: ", perPairData.length)
    console.log("New pairs (first-time): ", upbResult.countOfNewPairs)
    console.log("New pairs (capped at 4): ", upbResult.cappedCount)
    console.log("Pair bonus XP: ", upbResult.xp_pair_bonus)
    if (upbResult.newPairs.length > 0) {
        console.log("New pairs list:")
        upbResult.newPairs.forEach((pair, i) => {
            const [token0, token1] = pair.split('-')
            const overCap = i >= 4 ? ' (not counted - over cap)' : ''
            console.log(`  ${i + 1}. ${token0.slice(0, 10)}.../${token1.slice(0, 10)}...${overCap}`)
        })
    }

    console.log("\n=== FINAL XP TOTAL ===")
    console.log("XP from swaps (decayed): ", totalXP)
    console.log("XP from pair bonus: ", upbResult.xp_pair_bonus)
    console.log("FINAL XP: ", finalXP)
}

// disrtibuteXPJob()