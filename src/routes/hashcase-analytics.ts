import { Router } from "express";
import { getSwapDataForChart, getUserDataForChart } from "../controllers/hashcaseAnalytics/users";
import { getSwapsTableData } from "../controllers/hashcaseAnalytics/swaps";

const router = Router()

router.get("/chart/users", getUserDataForChart)
router.get("/chart/sushiswap", getSwapDataForChart)
router.get("/table/swaps", getSwapsTableData)

export default router;