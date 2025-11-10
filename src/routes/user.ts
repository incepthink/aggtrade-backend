import { Router } from "express";
import { getEquityTrendForUser } from "../controllers/user/equityTrend";
import { getKatanaBalanceRoute } from "../controllers/katanaRoutes";
import { addUserReferral, getUserReferralData, removeUserReferral } from "../controllers/referral";
import { getUserSushiswapTvl } from "../controllers/user/TVL";

const router = Router()

router.get("/equity-trend/:userAddress", getEquityTrendForUser)
router.get("/balance/katana/:userAddress", getKatanaBalanceRoute)
router.get("/referrals/:userAddress", getUserReferralData)
router.post("/referrals/add", addUserReferral)
router.delete("/referrals", removeUserReferral)
router.get("/tvl/sushiswap/:userAddress", getUserSushiswapTvl)

export default router