import { Router } from "express";
import { getEquityTrendForUser } from "../controllers/user/equityTrend";

const router = Router()

router.get("/equity-trend/:userAddress", getEquityTrendForUser)

export default router