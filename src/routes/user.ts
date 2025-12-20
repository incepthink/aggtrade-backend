import { Router } from "express";
import { getEquityTrendForUser } from "../controllers/user/equityTrend";
import { getKatanaBalanceRoute } from "../controllers/katanaRoutes";
import { addUserReferral, getUserReferralData, removeUserReferral } from "../controllers/referral";
import { getUserSushiswapTvl } from "../controllers/user/TVL";
import { getUserSignature, storeUserSignature } from "../controllers/user/wallet";
import { getXpDashboard, getXpSummary } from "../controllers/user/xpDashboard";

const router = Router()

router.get("/equity-trend/:userAddress", getEquityTrendForUser)
router.get("/balance/katana/:userAddress", getKatanaBalanceRoute)
router.get("/referrals/:userAddress", getUserReferralData)
router.post("/referrals/add", addUserReferral)
router.delete("/referrals", removeUserReferral)
router.get("/tvl/sushiswap/:userAddress", getUserSushiswapTvl)
router.get("/signature", getUserSignature)
router.post("/signature", storeUserSignature)
router.get("/xp/:walletAddress", getXpDashboard)
router.get("/xp-summary/:walletAddress", getXpSummary)

export default router