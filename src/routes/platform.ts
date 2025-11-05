import { Router } from "express";
import { getKatanaSwapData } from "../controllers/katanaSushiswapOHLCController";
import { getKatanaPools } from "../controllers/pools/katanaPoolsController";

const router = Router()

router.get("/chart/katana", getKatanaSwapData)
router.get("/pools/katana", getKatanaPools)

export default router;