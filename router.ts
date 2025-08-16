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

import { getKatanaBalance, getKatanaPrice } from "./controllers/katanaRoutes";

import {
  getEthereumPrice,
  getSushiPriceWithFallback,
} from "./controllers/ethereumRoutes";

// Import 1inch OHLC controllers
import {
  getOHLCData as getOHLCData1inch,
  getBatchOHLCData as getBatchOHLCData1inch,
  clearOHLCCache as clearOHLCCache1inch,
} from "./controllers/oneInchOHLCController";

// Import SushiSwap Ethereum OHLC controllers (pool-based)
import {
  getOHLCData as getOHLCDataSushi,
  getBatchOHLCData as getBatchOHLCDataSushi,
  clearOHLCCache as clearOHLCCacheSushi,
} from "./controllers/sushiswapOHLCController";

// Import Ethereum Token OHLC controllers (token-based)
import {
  getEthereumTokenOHLCData,
  clearEthereumTokenOHLCCache,
} from "./controllers/ethereumTokenOHLCController";

// Import Katana SushiSwap Pool OHLC controllers
import {
  getKatanaOHLCData,
  clearKatanaOHLCCache,
} from "./controllers/katanaSushiswapOHLCController";

// Import Katana Token OHLC controllers
import {
  getKatanaTokenOHLCData,
  clearKatanaTokenOHLCCache,
} from "./controllers/katanaTokenOHLCController";

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

router.get("/price/ethereum", getSushiPriceWithFallback);

// 1inch OHLC routes
router.get("/ohlc/1inch", getOHLCData1inch);
router.post("/ohlc/1inch/batch", getBatchOHLCData1inch);
router.delete("/ohlc/1inch/cache", clearOHLCCache1inch);

// SushiSwap Ethereum OHLC routes (pool-based implementation)
router.get("/ohlc/sushiswap", getOHLCDataSushi);
router.post("/ohlc/sushiswap/batch", getBatchOHLCDataSushi);
router.delete("/ohlc/sushiswap/cache", clearOHLCCacheSushi);

// Ethereum Token OHLC routes (token-based implementation using TokenHourData/TokenDayData)
router.get("/ohlc/ethereum/token", getEthereumTokenOHLCData);
router.delete("/ohlc/ethereum/token/cache", clearEthereumTokenOHLCCache);

// Katana SushiSwap Pool OHLC routes (original pool-based implementation)
router.get("/ohlc/katana/pool", getKatanaOHLCData);
router.delete("/ohlc/katana/pool/cache", clearKatanaOHLCCache);

// Katana Token OHLC routes (new token-based implementation)
router.get("/ohlc/katana/token", getKatanaTokenOHLCData);
router.delete("/ohlc/katana/token/cache", clearKatanaTokenOHLCCache);

// Katana OHLC routes (defaults to token-based for better coverage)
router.get("/ohlc/katana", getKatanaTokenOHLCData);
router.delete("/ohlc/katana/cache", clearKatanaTokenOHLCCache);

// Ethereum OHLC routes (defaults to token-based for better coverage)
router.get("/ohlc/ethereum", getEthereumTokenOHLCData);
router.delete("/ohlc/ethereum/cache", clearEthereumTokenOHLCCache);

// Default OHLC route (uses 1inch as primary fallback)
router.get("/ohlc", getOHLCData1inch);
router.post("/ohlc/batch", getBatchOHLCData1inch);

export default router;
