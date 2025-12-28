/**
 * XP Routes
 *
 * Handles XP preview and related endpoints
 */

import { Router } from "express"
import { getXPPreview } from "../controllers/xp/preview"

const router = Router()

// XP preview endpoint
router.get("/preview/:walletAddress", getXPPreview)

export default router
