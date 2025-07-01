import type { Request, Response, NextFunction } from "express";
import Mapping from "./models";
import Moralis from "moralis";
import { ethers } from "ethers";
import { createProxyMiddleware } from "http-proxy-middleware";
import Bottleneck from "bottleneck";
import axios from "axios";
import { getValue, storeValue } from "./redis";

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

export const oneInchProxy = createProxyMiddleware({
  target: "https://api.1inch.dev",
  changeOrigin: true,
  pathRewrite: {
    "^/approve/allowance": "/swap/v5.2/1/approve/allowance",
    "^/approve/transaction": "/swap/v5.2/1/approve/transaction",
    "^/swap": "/swap/v5.2/1/swap",
  },
  on: {
    proxyReq(proxyReq, req) {
      proxyReq.setHeader("Authorization", `Bearer ${process.env.ONEINCH_KEY}`);
      console.log("[1inch ➜]", req.url);
    },
    proxyRes(proxyRes, req) {
      console.log("[1inch ⇦]", proxyRes.statusCode, req.url);
    },
  },
});

const limiter = new Bottleneck({
  reservoir: 1,
  reservoirRefreshAmount: 1,
  reservoirRefreshInterval: 3000, // refill 1 request per second
});

export const rateLimit = (req: Request, res: Response, next: NextFunction) => {
  limiter.schedule(() => Promise.resolve()).then(next);
};

type Point = { ts: number; price: number };
type Meta = { fdv: number | null; vol: number | null };

async function fetchFromCoinGecko(tokenAddress: string): Promise<{
  chart: Point[];
  metadata: Meta;
}> {
  const BASE = "https://api.coingecko.com/api/v3";
  const KEY = process.env.COINGECKO_API_KEY;
  const headers = KEY ? { "x-cg-demo-api-key": KEY } : undefined;

  const ethRegex = /^0x[a-f0-9]{40}$/i;
  let coinId = tokenAddress;

  let fdv = 0;
  let vol = 0;

  if (ethRegex.test(tokenAddress)) {
    const { data } = await axios.get(
      `${BASE}/coins/ethereum/contract/${tokenAddress}`,
      { headers, params: { localization: false }, timeout: 10_000 }
    );
    coinId = data.id;
    fdv = data.market_data?.fully_diluted_valuation?.usd ?? null;
    vol = data.market_data?.total_volume?.usd ?? null;
  }

  const {
    data: { prices },
  } = await axios.get(`${BASE}/coins/${coinId}/market_chart`, {
    headers: {
      ...headers,
      "Accept-Encoding": "gzip, deflate",
    },
    params: { vs_currency: "usd", days: 365 },
    timeout: 10_000,
  });

  return {
    chart: prices.map(([ts, price]: [number, number]) => ({ ts, price })),
    metadata: { fdv, vol },
  };
}

const CACHE_KEY_PREFIX = "priceChart_";
const DATA_TTL = 60 * 60 * 24 * 365 * 10; // keep Redis entry for 10 years
const REFRESH_AFTER_MS = 5 * 60 * 1000; // refetch if older than 5 min

export async function getPriceData(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  const raw = String(req.query.tokenAddress || "")
    .trim()
    .toLowerCase();
  if (!raw) {
    res.status(400).json({ error: "tokenAddress param missing" });
    return;
  }

  const CACHE_KEY = `${CACHE_KEY_PREFIX}${raw}`;

  /* ───────────── 1) read cache ───────────── */
  let cached: { updated: number; data: any[] } | null = null;
  try {
    const cachedStr = await getValue(CACHE_KEY);
    if (cachedStr) cached = JSON.parse(cachedStr);
  } catch (e) {
    console.error("redis read error", e);
  }

  const isFresh = cached && Date.now() - cached.updated < REFRESH_AFTER_MS;
  if (isFresh) {
    res.json(cached!.data);
    return;
  }

  /* ───────────── 2) need refresh ───────────── */
  try {
    const data = await fetchFromCoinGecko(raw);
    await storeValue(
      CACHE_KEY,
      JSON.stringify({ updated: Date.now(), data }),
      DATA_TTL
    );
    res.json(data);
  } catch (err) {
    console.warn("CoinGecko fetch failed:", (err as any).message);

    // serve stale cache if we have it
    if (cached) {
      res.json(cached.data);
      return;
    }

    // no cache at all → bubble up
    res.status(503).json({ error: "Upstream unavailable, try later." });
  }
}
