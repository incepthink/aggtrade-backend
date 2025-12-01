import { Router } from "express"
import {
  getClassicSwapQuote,
  executeClassicSwap
} from "../controllers/transaction/classic-swap"
import {
  prepareYearnDeposit,
  prepareYearnWithdraw
} from "../controllers/transaction/yearn"
import {
  prepareLimitOrder
} from "../controllers/transaction/twap"
import {
  prepareMorphoWithdraw,
  prepareMorphoDeposit,
  prepareMorphoBorrow,
  prepareMorphoRepay
} from "../controllers/transaction/morpho"

const router = Router()

// Classic Swap endpoints
router.post("/classic-swap/quote", getClassicSwapQuote)
router.post("/classic-swap/execute", executeClassicSwap)

// Yearn Finance endpoints
router.post("/yearn/deposit/prepare", prepareYearnDeposit)
router.post("/yearn/withdraw/prepare", prepareYearnWithdraw)

// TWAP (Orbs) Limit Orders endpoints
router.post("/twap/limit-order/prepare", prepareLimitOrder)

// Morpho Blue endpoints
router.post("/morpho/withdraw/prepare", prepareMorphoWithdraw)
router.post("/morpho/deposit/prepare", prepareMorphoDeposit)
router.post("/morpho/borrow/prepare", prepareMorphoBorrow)
router.post("/morpho/repay/prepare", prepareMorphoRepay)

export default router
