// utils/getEtherBalanceUSD.ts

import axios from "axios";
import User from "../../models/User";

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

function weiToEth(wei: string): string {
  const ethValue = BigInt(wei) / BigInt(10 ** 18);
  const remainder = BigInt(wei) % BigInt(10 ** 18);
  const decimals = remainder.toString().padStart(18, '0').slice(0, 6);
  return `${ethValue}.${decimals}`;
}

async function getEtherPriceSushi(): Promise<number> {
  const weth = "0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62";

  const { data } = await axios.get(
    `https://api.sushi.com/price/v1/747474/${weth}`,
    {
      timeout: 5000,
    }
  );

  return data;
}

async function getPriceSushi(address: string): Promise<number> {
  const { data } = await axios.get(
    `https://api.sushi.com/price/v1/747474/${address}`,
    {
      timeout: 5000,
    }
  );

  return data;
}

export async function getErc20BalanceUSD(walletAddress: string): Promise<number> {
  try {
    // Get user and their token addresses
    const user = await User.findByWallet(walletAddress, 747474);
    
    if (!user || !user.token_addresses || user.token_addresses.length === 0) {
      return 0;
    }

    const tokenAddresses = user.token_addresses;
    let totalUSD = 0;

    // Fetch balances and prices in parallel
    const balancePromises = tokenAddresses.map(async (tokenAddress) => {
      try {
        const lowerCaseAddress = tokenAddress.toLowerCase();
        
        // Skip ETH placeholder address
        if (lowerCaseAddress === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
          return 0;
        }

        // Get decimals for the token
        const decimals = decimalsMap.get(lowerCaseAddress) || 18;

        // Fetch balance and price in parallel
        const [balanceRes, price] = await Promise.all([
          axios.get(
            `https://api.etherscan.io/v2/api?chainid=747474&module=account&action=tokenbalance&contractaddress=${tokenAddress}&address=${walletAddress}&tag=latest&apikey=${process.env.ETHERSCAN_API}`,
            { timeout: 5000 }
          ),
          getPriceSushi(tokenAddress)
        ]);

        const balanceWei = balanceRes.data.result;
        
        // Convert to human readable format
        const balance = Number(balanceWei) / Math.pow(10, decimals);
        
        // Calculate USD value
        const usdValue = balance * price;

        return usdValue;
      } catch (error) {
        console.error(`Error fetching balance/price for ${tokenAddress}:`, error);
        return 0;
      }
    });

    // Wait for all promises and sum up
    const usdValues = await Promise.all(balancePromises);
    totalUSD = usdValues.reduce((sum, value) => sum + value, 0);

    return totalUSD;
  } catch (error) {
    console.error("[getErc20BalanceUSD] Error:", error);
    return 0;
  }
}

async function getEtherBalanceUSD(walletAddress: string): Promise<number> {
  const etherscanUrl = `https://api.etherscan.io/v2/api?chainid=747474&module=account&action=balance&address=${walletAddress}&tag=latest&apikey=${process.env.ETHERSCAN_API}`;

  const etherscanRes = await axios.get(etherscanUrl);
  const etherBalWei = etherscanRes.data.result;
  const etherBal = weiToEth(etherBalWei);
  
  const etherPrice = await getEtherPriceSushi();
  const etherBalUSD = Number(etherBal) * etherPrice;

  return etherBalUSD;
}

export default getEtherBalanceUSD;