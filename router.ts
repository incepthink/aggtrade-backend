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
} from "./controllers/1inch";

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

export default router;
