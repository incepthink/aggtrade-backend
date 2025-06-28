import type { Request, Response, NextFunction } from "express";
import Mapping from "./models";

/**
 * POST /api/address
 * Body: { userAddress: string, dydxAddress: string }
 *
 * • Creates a new mapping if none exists
 * • Otherwise updates the stored dydxAddress
 */
export async function createMapping(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userAddress, dydxAddress } = req.body as {
      userAddress?: string;
      dydxAddress?: string;
    };

    if (!userAddress || !dydxAddress) {
      console.log("❌  Missing fields");
      res.status(400).json({ error: "Missing fields" });
      return;
    }

    const filter = { userAddress: userAddress.toLowerCase() };

    /* look for an existing document */
    const existing = await Mapping.findOne(filter);

    if (existing) {
      /* update dydxAddress */
      existing.dydxAddress = dydxAddress;
      await existing.save();
      console.log("🔄  Mapping updated");
      res.status(200).json(existing);
      return;
    }

    /* create new mapping */
    const created = await Mapping.create({
      userAddress: filter.userAddress,
      dydxAddress,
    });

    console.log("✅  Mapping saved");
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/address/:userAddress
 */
export async function getMappingByUserAddress(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userAddress } = req.params;

    const doc = await Mapping.findOne({
      userAddress: userAddress.toLowerCase(),
    }).lean();

    if (!doc) {
      res.status(404).json({ error: "Mapping not found" });
      return;
    }

    res.json(doc);
  } catch (err) {
    next(err);
  }
}
