import type { Request, Response, NextFunction } from "express";
import Mapping from "../models";
import Moralis from "moralis";
import { ethers } from "ethers";
import { createProxyMiddleware } from "http-proxy-middleware";
import Bottleneck from "bottleneck";
import axios from "axios";
import { getValue, storeValue } from "../redis";

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

// Chain configurations
const SUPPORTED_CHAINS = {
  ethereum: {
    id: 1,
    name: "Ethereum",
    wethAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  },
  katana: {
    id: 747474,
    name: "Katana",
    wethAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  },
} as const;

type SupportedChain = keyof typeof SUPPORTED_CHAINS;

// Get token price using appropriate API based on chain
async function getTokenPriceByChain(
  address: string,
  chain: SupportedChain
): Promise<number> {
  if (chain === "ethereum") {
    // Use Moralis for Ethereum
    const response = await Moralis.EvmApi.token.getTokenPrice({
      address: address as `0x${string}`,
      chain: "0x1",
    });
    return response.raw.usdPrice;
  } else {
    // Use CoinGecko with retry logic for other chains
    return await fetchPriceWithRetry(address);
  }
}

export async function getTokenPrice(
  req: Request<
    {},
    {},
    {},
    {
      addressOne?: string;
      addressTwo?: string;
      chainId?: string;
    }
  >,
  res: Response
): Promise<void> {
  try {
    let { addressOne, addressTwo, chainId } = req.query;

    if (!addressOne || !addressTwo) {
      res.status(400).json({
        status: "error",
        msg: "Both `addressOne` and `addressTwo` must be provided",
      });
      return;
    }

    const chain = (chainId?.toLowerCase() || "ethereum") as SupportedChain;

    if (!SUPPORTED_CHAINS[chain]) {
      res.status(400).json({
        status: "error",
        msg: "Invalid chainId. Supported chains: ethereum, katana",
      });
      return;
    }

    if (!ethers.isAddress(addressOne) || !ethers.isAddress(addressTwo)) {
      res.status(422).json({
        status: "error",
        msg: "One or both addresses are not valid EVM addresses",
      });
      return;
    }

    const chainConfig = SUPPORTED_CHAINS[chain];
    if (addressOne === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
      addressOne = chainConfig.wethAddress;
    }
    if (addressTwo === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
      addressTwo = chainConfig.wethAddress;
    }

    const [priceOne, priceTwo] = await Promise.all([
      getTokenPriceByChain(addressOne, chain),
      getTokenPriceByChain(addressTwo, chain),
    ]);

    const data = {
      tokenOne: priceOne,
      tokenTwo: priceTwo,
      ratio: priceOne / priceTwo,
      chain: {
        id: chainConfig.id,
        name: chainConfig.name,
      },
    };

    res.status(200).json({ status: "success", data });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unexpected server error";
    console.error("Token price error:", err);

    if (
      message.includes("No liquidity pools found") ||
      message.includes("C0006")
    ) {
      res.status(404).json({
        status: "error",
        msg: "Token price not found. Token may not be available on the specified network or may have insufficient liquidity.",
      });
    } else if (message.includes("rate limit")) {
      res.status(429).json({
        status: "error",
        msg: "Rate limit exceeded. Please try again later.",
      });
    } else {
      res.status(500).json({ status: "error", msg: message });
    }
  }
}

export async function getSupportedChains(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const chains = Object.entries(SUPPORTED_CHAINS).map(([key, config]) => ({
      chainId: key,
      name: config.name,
      id: config.id,
      supported: true,
    }));

    res.status(200).json({
      status: "success",
      data: {
        chains,
        count: chains.length,
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unexpected server error";
    res.status(500).json({ status: "error", msg: message });
  }
}

export async function checkChainHealth(
  req: Request<{ chainId: string }>,
  res: Response
): Promise<void> {
  try {
    const { chainId } = req.params;
    const chain = chainId.toLowerCase() as SupportedChain;

    if (!SUPPORTED_CHAINS[chain]) {
      res.status(400).json({
        status: "error",
        msg: "Invalid chainId. Supported chains: ethereum, katana",
      });
      return;
    }

    const chainConfig = SUPPORTED_CHAINS[chain];
    let healthy = false;
    let latency = 0;

    const startTime = Date.now();

    try {
      if (chain === "ethereum") {
        await Moralis.EvmApi.token.getTokenPrice({
          address: chainConfig.wethAddress as `0x${string}`,
          chain: "0x1",
        });
      } else {
        await fetchPriceWithRetry(chainConfig.wethAddress);
      }

      healthy = true;
      latency = Date.now() - startTime;
    } catch (error) {
      console.error(`Health check failed for ${chain}:`, error);
      healthy = false;
      latency = Date.now() - startTime;
    }

    res.status(200).json({
      status: "success",
      data: {
        chain: {
          id: chainConfig.id,
          name: chainConfig.name,
          chainId: chain,
        },
        healthy,
        latency: `${latency}ms`,
        timestamp: new Date().toISOString(),
      },
    });
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
  reservoirRefreshInterval: 3000,
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
    let data;
    if (tokenAddress === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
      const { data: dataRes } = await axios.get(`${BASE}/coins/ethereum`, {
        headers: {
          ...headers,
          "Accept-Encoding": "gzip, deflate",
        },
        params: { localization: false },
        timeout: 10_000,
      });
      data = dataRes;
    } else {
      const { data: dataRes } = await axios.get(
        `${BASE}/coins/ethereum/contract/${tokenAddress}`,
        {
          headers: {
            ...headers,
            "Accept-Encoding": "gzip, deflate",
          },
          params: { localization: false },
          timeout: 10_000,
        }
      );
      data = dataRes;
    }

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
const DATA_TTL = 60 * 60 * 24 * 365 * 10;
const REFRESH_AFTER_MS = 5 * 60 * 1000;

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

    if (cached) {
      res.json(cached.data);
      return;
    }

    res.status(503).json({ error: "Upstream unavailable, try later." });
  }
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPriceWithRetry(
  address: string,
  attempt = 0
): Promise<number> {
  const url = `https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${address}&vs_currencies=usd`;

  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    if (res.status === 429 || res.status === 503) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        return fetchPriceWithRetry(address, attempt + 1);
      } else {
        console.warn(`Failed to get price for ${address} after retries.`);
        return 0;
      }
    }

    if (!res.ok) {
      throw new Error(`Failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    console.log(data);

    return data[address.toLowerCase()]?.usd ?? 0;
  } catch (err) {
    console.error(`Error fetching price for ${address}:`, err);
    return 0;
  }
}

export async function getTokenPricesFromCoinGecko(
  req: Request<{}, {}, {}, { addresses?: string }>,
  res: Response
): Promise<void> {
  try {
    const { addresses } = req.query;

    if (!addresses) {
      res
        .status(400)
        .json({ status: "error", msg: "`addresses` query required" });
      return;
    }

    const addressList = addresses
      .split(",")
      .map((addr) => addr.trim().toLowerCase())
      .filter((a) => /^0x[a-f0-9]{40}$/i.test(a));

    if (addressList.length === 0) {
      res.status(422).json({ status: "error", msg: "No valid EVM addresses" });
      return;
    }

    const results: { [address: string]: number } = {};

    for (const address of addressList) {
      const price = await fetchPriceWithRetry(address);
      results[address] = price;
    }

    res.status(200).json({ status: "success", data: results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected server error";
    res.status(500).json({ status: "error", msg });
  }
}
