// utils/getEtherBalanceUSD.ts

import axios from "axios";
import User from "../../models/User";
import {
  safeStringToBigInt,
  isValidNumber,
  safeMultiply,
  validateNumber,
  extractPrice,
  retryWithBackoff
} from "./validators";

const decimalsMap = new Map([
  ["0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d", 18], // KAT
  ["0x203a662b0bd271a6ed5a60edfbd04bfce608fd36", 6],  // USDC
  ["0x00000000efe302beaa2b3e6e1b18d08d69a9012a", 6],  // AUSD
  ["0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072", 8],  // BTCK
  ["0x876aac7648d79f87245e73316eb2d100e75f3df1", 18], // bvUSD
  ["0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62", 18], // WETH
  ["0x6c16e26013f2431e8b2e1ba7067ecccad0db6c52", 18], // JitoSOL
  ["0xfba805659e5050544e185cccdf592fd77f8c7210", 18], // KITSU
  ["0xecac9c5f704e954931349da37f60e39f515c11c1", 8],  // LBTC
  ["0xaefec36b1c6e8a03fb6563cec97cfea7a80d3ea0", 18], // LKAT
  ["0x1e5efca3d0db2c6d5c67a4491845c43253eb9e4e", 18], // MORPHO
  ["0xb24e3035d1fcbc0e43cf3143c3fd92e53df2009b", 18], // POL
  ["0xb244add9fe6cb17558221e4dfea960e680ccd29b", 18], // PROVE
  ["0x17bff452dae47e07cea877ff0e1aba17eb62b0ab", 18], // SUSHI
  ["0xa6c996a8d401271e8c4f95927443538d4a1f3fa2", 18], // unKat
  ["0x2dca96907fde857dd3d816880a0df407eeb2d2f2", 6],  // USDT
  ["0x9b8df6e244526ab5f6e6400d331db28c8fdddb55", 18], // uSOL
  ["0x0913da6da4b42f538b445599b46bb4622342cf52", 8],  // WBTC
  ["0x9893989433e7a383cb313953e4c2365107dc19a7", 18], // weETH
  ["0x476eacd417cd65421bd34fca054377658bb5e02b", 18], // YFI
  ["0x4772d2e014f9fc3a820c444e3313968e9a5c8121", 18], // yUSD
]);

function weiToEth(wei: string): string | null {
  const weiBigInt = safeStringToBigInt(wei);
  if (weiBigInt === null) {
    console.warn(`[weiToEth] Invalid wei value: "${wei}"`);
    return null;
  }

  try {
    const ethValue = weiBigInt / BigInt(10 ** 18);
    const remainder = weiBigInt % BigInt(10 ** 18);
    const decimals = remainder.toString().padStart(18, '0').slice(0, 6);
    return `${ethValue}.${decimals}`;
  } catch (error) {
    console.error(`[weiToEth] Conversion error for wei: "${wei}"`, error);
    return null;
  }
}

async function getEtherPriceSushi(): Promise<number | null> {
  const weth = "0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62";

  // Wrap API call with retry logic (5 retries for rate limit resilience)
  const result = await retryWithBackoff(
    async () => {
      const { data } = await axios.get(
        `https://api.sushi.com/price/v1/747474/${weth}`,
        {
          timeout: 5000,
        }
      );

      const price = extractPrice(data);
      if (price === null) {
        throw new Error('Invalid price data received');
      }
      return price;
    },
    5,
    1500,
    'Sushi ETH price'
  );

  return result;
}

async function getPriceSushi(address: string): Promise<number | null> {
  // Special case: KAT token is not yet launched, return 0 price
  const KAT_TOKEN_ADDRESS = "0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d";
  if (address.toLowerCase() === KAT_TOKEN_ADDRESS.toLowerCase()) {
    return 0;
  }

  // Wrap API call with retry logic (5 retries for rate limit resilience)
  const result = await retryWithBackoff(
    async () => {
      const { data } = await axios.get(
        `https://api.sushi.com/price/v1/747474/${address}`,
        {
          timeout: 5000,
        }
      );

      const price = extractPrice(data);
      if (price === null) {
        throw new Error('Invalid price data received');
      }
      return price;
    },
    5,
    1500,
    `Sushi price for ${address.substring(0, 10)}...`
  );

  return result;
}

export async function getErc20BalanceUSD(walletAddress: string): Promise<number | null> {
  try {
    // Get user and their token addresses
    const user = await User.findByWallet(walletAddress, 747474);

    if (!user || !user.token_addresses || user.token_addresses.length === 0) {
      return 0;
    }

    const tokenAddresses = user.token_addresses;
    let totalUSD = 0;
    let hasAnyFailure = false; // Track if any token fails

    // Process tokens sequentially to avoid rate limiting
    // This is slower but more reliable and avoids overwhelming the API
    for (const tokenAddress of tokenAddresses) {
      try {
        const lowerCaseAddress = tokenAddress.toLowerCase();

        // Skip ETH placeholder address
        if (lowerCaseAddress === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
          continue;
        }

        // Get decimals for the token
        const decimals = decimalsMap.get(lowerCaseAddress) || 18;

        // Fetch balance and price sequentially (5 retries for rate limit resilience)
        const balanceWei = await retryWithBackoff(
          async () => {
            const res = await axios.get(
              `https://api.etherscan.io/v2/api?chainid=747474&module=account&action=tokenbalance&contractaddress=${tokenAddress}&address=${walletAddress}&tag=latest&apikey=${process.env.ETHERSCAN_API}`,
              { timeout: 5000 }
            );

            if (!res.data?.result) {
              throw new Error('Invalid Etherscan response');
            }

            return res.data.result;
          },
          5,
          1500,
          `Token balance for ${tokenAddress.substring(0, 10)}...`
        );

        // If balance fetch failed after retries, mark as failure
        if (balanceWei === null) {
          console.warn(`[getErc20BalanceUSD] Failed to fetch balance for token ${tokenAddress}`);
          hasAnyFailure = true;
          continue;
        }

        // Validate balance
        const balanceNum = validateNumber(balanceWei, `balance for ${tokenAddress}`);
        if (balanceNum === null) {
          console.warn(`[getErc20BalanceUSD] Invalid balance for token ${tokenAddress}`);
          hasAnyFailure = true;
          continue;
        }

        // Convert to human readable format
        const balance = balanceNum / Math.pow(10, decimals);

        // Fetch price
        const price = await getPriceSushi(tokenAddress);

        // Validate price
        if (price === null || !isValidNumber(price)) {
          console.warn(`[getErc20BalanceUSD] Invalid price for token ${tokenAddress}, price: ${price}`);
          hasAnyFailure = true;
          continue;
        }

        // Calculate USD value with safe multiplication
        const usdValue = safeMultiply(balance, price);
        if (usdValue === null) {
          console.warn(`[getErc20BalanceUSD] Invalid USD calculation for token ${tokenAddress}`);
          hasAnyFailure = true;
          continue;
        }

        totalUSD += usdValue;

        // Add small delay between token processing to avoid rate limits (300ms)
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (error) {
        console.error(`Error fetching balance/price for ${tokenAddress}:`, error);
        hasAnyFailure = true;
      }
    }

    // If any token failed, return null to mark entire balance as failed
    if (hasAnyFailure) {
      console.warn(`[getErc20BalanceUSD] One or more tokens failed for ${walletAddress}, marking as failed`);
      return null;
    }

    return totalUSD;
  } catch (error) {
    console.error("[getErc20BalanceUSD] Error:", error);
    return null;
  }
}

async function getEtherBalanceUSD(walletAddress: string): Promise<number | null> {
  try {
    // Fetch ETH balance from Etherscan with retry (5 retries for rate limit resilience)
    const etherBalWei = await retryWithBackoff(
      async () => {
        const etherscanUrl = `https://api.etherscan.io/v2/api?chainid=747474&module=account&action=balance&address=${walletAddress}&tag=latest&apikey=${process.env.ETHERSCAN_API}`;
        const etherscanRes = await axios.get(etherscanUrl, { timeout: 5000 });

        if (!etherscanRes.data?.result) {
          throw new Error('Invalid Etherscan response');
        }

        return etherscanRes.data.result;
      },
      5,
      1500,
      'Etherscan ETH balance'
    );

    if (etherBalWei === null) {
      console.warn(`[getEtherBalanceUSD] Failed to fetch ETH balance for ${walletAddress}`);
      return null;
    }

    // Validate and convert balance
    const etherBal = weiToEth(etherBalWei);
    if (etherBal === null) {
      console.warn(`[getEtherBalanceUSD] Failed to convert ETH balance for ${walletAddress}`);
      return null;
    }

    // Validate and get price (already has retry inside)
    const etherPrice = await getEtherPriceSushi();
    if (etherPrice === null) {
      console.warn(`[getEtherBalanceUSD] Failed to get ETH price`);
      return null;
    }

    // Safe multiplication
    const etherBalNum = validateNumber(etherBal, 'etherBalance');
    if (etherBalNum === null) {
      console.warn(`[getEtherBalanceUSD] Invalid ETH balance number: ${etherBal}`);
      return null;
    }

    const etherBalUSD = safeMultiply(etherBalNum, etherPrice);
    if (etherBalUSD === null) {
      console.warn(`[getEtherBalanceUSD] Failed to calculate USD value`);
      return null;
    }

    return etherBalUSD;
  } catch (error) {
    console.error(`[getEtherBalanceUSD] Error fetching ETH balance for ${walletAddress}:`, error);
    return null;
  }
}

export default getEtherBalanceUSD;