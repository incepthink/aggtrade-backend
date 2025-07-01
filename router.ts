// src/routes/route.ts
import { Router } from "express";
import {
  createMapping,
  getMappingByUserAddress,
  getPriceData,
  getTokenPrice,
} from "./controllers";

const router = Router();

// POST /api/address → Create mapping if it doesn't exist
router.post("/address", createMapping);

// GET /api/address/:userAddress → Fetch mapping by user address
router.get("/address/:userAddress", getMappingByUserAddress);

router.get("/tokenPrice", getTokenPrice);

router.get("/chart/price", getPriceData);

export default router;
