import { Router } from "express";
import { getEquityTrendForUser } from "../controllers/user/equityTrend";
import { getKatanaBalanceRoute } from "../controllers/katanaRoutes";

const router = Router()

router.get("/equity-trend/:userAddress", getEquityTrendForUser)
router.get("/balance/katana/:userAddress", getKatanaBalanceRoute)

export default router