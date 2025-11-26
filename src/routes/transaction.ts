import { Router } from "express"
import {
  getClassicSwapQuote,
  executeClassicSwap
} from "../controllers/transaction/classic-swap"

const router = Router()

// Classic Swap endpoints
router.post("/classic-swap/quote", getClassicSwapQuote)
router.post("/classic-swap/execute", executeClassicSwap)

export default router
