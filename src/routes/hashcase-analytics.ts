import { Router } from "express";
import { getSwapDataForChart, getUserDataForChart } from "../controllers/hashcaseAnalytics/users";

const router = Router()

router.get("/chart/users", getUserDataForChart)
router.get("/chart/sushiswap", getSwapDataForChart)

export default router;