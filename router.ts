// src/routes/route.ts
import { Router } from "express";
import {
  createMapping,
  getMappingByUserAddress,
  getPriceData,
  getTokenPrice,
  getTokenPricesFromCoinGecko,
} from "./controllers/controllers";
import {
  getTokens1inch,
  portfolioDetailedController,
  portfolioHistoryController,
  SwapHistoryByAddress,
} from "./controllers/1inch";

import { getKatanaBalance, getKatanaPrice } from "./controllers/etherRoutes";

const router = Router();

// POST /api/address → Create mapping if it doesn't exist
router.post("/address", createMapping);

// GET /api/address/:userAddress → Fetch mapping by user address
router.get("/address/:userAddress", getMappingByUserAddress);

router.get("/tokenPrice", getTokenPrice);

router.get("/chart/price", getPriceData);

router.get("/coingecko-prices", getTokenPricesFromCoinGecko);

router.get("/proxy/1inch/tokens", getTokens1inch);
router.get(
  "/proxy/1inch/profile/detailed-overview",
  portfolioDetailedController
);
router.get("/proxy/1inch/profile/equity-trend", portfolioHistoryController);

router.get("/proxy/1inch/profile/swap-history", SwapHistoryByAddress);

router.get("/balance/katana", getKatanaBalance);
router.get("/price/katana", getKatanaPrice);

export default router;
