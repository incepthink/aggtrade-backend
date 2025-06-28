// src/routes/route.ts
import { Router } from "express";
import { createMapping, getMappingByUserAddress } from "./controllers";

const router = Router();

// POST /api/address → Create mapping if it doesn't exist
router.post("/address", createMapping);

// GET /api/address/:userAddress → Fetch mapping by user address
router.get("/address/:userAddress", getMappingByUserAddress);

export default router;
