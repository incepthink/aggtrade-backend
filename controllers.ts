import type { Request, Response, NextFunction } from "express";
import Mapping from "./models";
import Moralis from "moralis";
import { ethers } from "ethers";

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

export async function getTokenPrice(
  req: Request<{}, {}, {}, { addressOne?: string; addressTwo?: string }>,
  res: Response
): Promise<void> {
  try {
    const { addressOne, addressTwo } = req.query;

    // 1. Validate presence
    if (!addressOne || !addressTwo) {
      res.status(400).json({
        status: "error",
        msg: "Both `addressOne` and `addressTwo` must be provided",
      });
    }

    // 2. Validate address format
    if (!ethers.isAddress(addressOne) || !ethers.isAddress(addressTwo)) {
      res.status(422).json({
        status: "error",
        msg: "One or both addresses are not valid EVM addresses",
      });
    }

    // 3. Fetch prices (safe to assert type now)
    const [resOne, resTwo] = await Promise.all([
      Moralis.EvmApi.token.getTokenPrice({
        address: addressOne as `0x${string}`,
      }),
      Moralis.EvmApi.token.getTokenPrice({
        address: addressTwo as `0x${string}`,
      }),
    ]);

    // 4. Build response
    const data = {
      tokenOne: resOne.raw.usdPrice,
      tokenTwo: resTwo.raw.usdPrice,
      ratio: resOne.raw.usdPrice / resTwo.raw.usdPrice,
    };

    res.status(200).json({ status: "success", data });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unexpected server error";
    res.status(500).json({ status: "error", msg: message });
  }
}
