// Katana Network Token Address Mapping
const KATANA_TOKEN_MAP: Record<
  string,
  {
    symbol: string;
    decimals: number;
    logoUrl?: string;
    name: string;
    isNative?: boolean;
  }
> = {
  // Native ETH
  NATIVE: {
    symbol: "ETH",
    decimals: 18,
    name: "Ether",
    isNative: true,
  },

  // KAT Token
  "0x7F1f4b4b29f5058fA32CC7a97141b8D7e5ABDC2d": {
    symbol: "KAT",
    decimals: 18,
    logoUrl: "https://assets.katana.network/icons/kat.svg",
    name: "Katana Network Token",
  },

  // wETH
  "0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62": {
    symbol: "wETH",
    decimals: 18,
    logoUrl: "https://assets.katana.network/icons/eth.svg",
    name: "Vault Bridge ETH",
  },

  // USDC
  "0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36": {
    symbol: "USDC",
    decimals: 6,
    logoUrl: "https://assets.katana.network/icons/usdc.svg",
    name: "Vault Bridge USDC",
  },

  // USDT
  "0x2DCa96907fde857dd3D816880A0df407eeB2D2F2": {
    symbol: "USDT",
    decimals: 6,
    logoUrl: "https://assets.katana.network/icons/usdt.svg",
    name: "Vault Bridge USDT",
  },

  // WBTC
  "0x0913DA6Da4b42f538B445599b46Bb4622342Cf52": {
    symbol: "WBTC",
    decimals: 8,
    logoUrl: "https://assets.katana.network/icons/btc.svg",
    name: "Vault Bridge WBTC",
  },

  // USDS
  "0x62D6A123E8D19d06d68cf0d2294F9A3A0362c6b3": {
    symbol: "USDS",
    decimals: 18,
    logoUrl: "https://assets.katana.network/icons/usds.svg",
    name: "Vault Bridge USDS",
  },

  // AUSD
  "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a": {
    symbol: "AUSD",
    decimals: 6,
    logoUrl: "https://assets.katana.network/icons/ausd.svg",
    name: "Agora Dollar",
  },

  // LBTC
  "0xecAc9C5F704e954931349Da37F60E39f515c11c1": {
    symbol: "LBTC",
    decimals: 8,
    logoUrl: "https://assets.katana.network/icons/lbtc.svg",
    name: "Lombard Staked BTC",
  },

  // BTCK
  "0xB0F70C0bD6FD87dbEb7C10dC692a2a6106817072": {
    symbol: "BTCK",
    decimals: 8,
    logoUrl: "https://assets.katana.network/icons/btck.svg",
    name: "Bitcoin on Katana",
  },

  // JitoSOL
  "0x6C16E26013f2431e8B2e1Ba7067ECCcad0Db6C52": {
    symbol: "JitoSOL",
    decimals: 18,
    logoUrl: "https://assets.katana.network/icons/jitosol.svg",
    name: "Jito Staked SOL",
  },

  // uSOL
  "0x9B8Df6E244526ab5F6e6400d331DB28C8fdDdb55": {
    symbol: "uSOL",
    decimals: 18,
    logoUrl: "https://assets.katana.network/icons/usol.png",
    name: "Solana (Universal)",
  },

  // uSUI
  "0xb0505e5a99abd03d94a1169e638B78EDfEd26ea4": {
    symbol: "uSUI",
    decimals: 18,
    logoUrl: "https://assets.katana.network/icons/usui.png",
    name: "SUI (Universal)",
  },

  // uXRP
  "0x2615a94df961278DcbC41Fb0a54fEc5f10a693aE": {
    symbol: "uXRP",
    decimals: 18,
    logoUrl: "https://assets.katana.network/icons/uxrp.png",
    name: "XRP (Universal)",
  },

  // MORPHO
  "0x1e5eFCA3D0dB2c6d5C67a4491845c43253eB9e4e": {
    symbol: "MORPHO",
    decimals: 18,
    logoUrl: "https://assets.katana.network/icons/morpho.svg",
    name: "Bridge-wrapped MORPHO",
  },

  // POL
  "0xb24e3035d1FCBC0E43CF3143C3Fd92E53df2009b": {
    symbol: "POL",
    decimals: 18,
    logoUrl: "https://assets.katana.network/icons/pol.svg",
    name: "Bridge-wrapped POL",
  },

  // SUSHI
  "0x17BFF452dae47e07CeA877Ff0E1aba17eB62b0aB": {
    symbol: "SUSHI",
    decimals: 18,
    logoUrl: "https://assets.katana.network/icons/sushi.svg",
    name: "Bridge-wrapped SUSHI",
  },

  // YFI
  "0x476eaCd417cD65421bD34fca054377658BB5E02b": {
    symbol: "YFI",
    decimals: 18,
    logoUrl: "https://assets.katana.network/icons/yearn.svg",
    name: "Bridge-wrapped Yearn Finance",
  },

  // weETH
  "0x9893989433e7a383Cb313953e4c2365107dc19a7": {
    symbol: "weETH",
    decimals: 18,
    logoUrl: "https://assets.katana.network/icons/weeth.svg",
    name: "Bridge-wrapped weETH",
  },

  // wstETH
  "0x7Fb4D0f51544F24F385a421Db6e7D4fC71Ad8e5C": {
    symbol: "wstETH",
    decimals: 18,
    logoUrl: "https://assets.katana.network/icons/wsteth.svg",
    name: "Bridge-wrapped wstETH",
  },

  // bvUSD
  "0x876aac7648D79f87245E73316eB2D100e75F3Df1": {
    symbol: "bvUSD",
    decimals: 18,
    logoUrl: "https://assets.katana.network/icons/bvusd.svg",
    name: "BitVault USD",
  },
};

// Helper function to get token info by address (case-insensitive)
function getTokenInfo(address: string) {
  if (
    address.toLowerCase() === "native" ||
    address === "0x0000000000000000000000000000000000000000"
  ) {
    return KATANA_TOKEN_MAP["NATIVE"];
  }

  const tokenAddress = Object.keys(KATANA_TOKEN_MAP).find(
    (addr) => addr.toLowerCase() === address.toLowerCase()
  );

  return tokenAddress ? KATANA_TOKEN_MAP[tokenAddress] : null;
}

// Helper function to get decimals by address
function getTokenDecimals(address: string): number {
  const tokenInfo = getTokenInfo(address);
  return tokenInfo?.decimals || 18; // Default to 18 if not found
}

export { KATANA_TOKEN_MAP, getTokenInfo, getTokenDecimals };
