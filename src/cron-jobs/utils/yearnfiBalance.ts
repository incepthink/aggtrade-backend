// Standalone file to calculate cumulated value for Katana (747474) vaults
// No external imports - everything included

const KATANA_CHAIN_ID = 747474;
const KATANA_RPC_URL = 'https://rpc.katana.network/';
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ETH_TOKEN_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

const ERC20_ABI = [
  {
    constant: true,
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    type: 'function'
  },
  {
    constant: true,
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', type: 'string' }],
    type: 'function'
  },
  {
    constant: true,
    inputs: [],
    name: 'name',
    outputs: [{ name: '', type: 'string' }],
    type: 'function'
  },
  {
    constant: true,
    inputs: [{ name: '_owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    type: 'function'
  }
];

const AGGREGATE3_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'target', type: 'address' },
          { internalType: 'bool', name: 'allowFailure', type: 'bool' },
          { internalType: 'bytes', name: 'callData', type: 'bytes' }
        ],
        internalType: 'struct Multicall3.Call3[]',
        name: 'calls',
        type: 'tuple[]'
      }
    ],
    name: 'aggregate3',
    outputs: [
      {
        components: [
          { internalType: 'bool', name: 'success', type: 'bool' },
          { internalType: 'bytes', name: 'returnData', type: 'bytes' }
        ],
        internalType: 'struct Multicall3.Result[]',
        name: 'returnData',
        type: 'tuple[]'
      }
    ],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [{ internalType: 'address', name: 'addr', type: 'address' }],
    name: 'getEthBalance',
    outputs: [{ internalType: 'uint256', name: 'balance', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
];

type TAddress = string;
type TNormalizedBN = { raw: bigint; normalized: number; display: string };
type TToken = {
  address: TAddress;
  name: string;
  symbol: string;
  decimals: number;
  chainID: number;
  balance: TNormalizedBN;
  value: number;
};
type TDict<T> = Record<string, T>;
type TUseBalancesTokens = {
  address: TAddress;
  chainID: number;
  decimals?: number;
  name?: string;
  symbol?: string;
};

function toNormalizedBN(raw: bigint, decimals: number): TNormalizedBN {
  const divisor = BigInt(10) ** BigInt(decimals);
  const normalized = Number(raw) / Number(divisor);
  
  return {
    raw,
    normalized,
    display: normalized.toFixed(decimals > 6 ? 6 : decimals)
  };
}

function toAddress(address: any): TAddress {
  return address?.toLowerCase() || '';
}

function isZeroAddress(address: TAddress): boolean {
  return !address || address === '0x0000000000000000000000000000000000000000';
}

function isEthAddress(address: TAddress): boolean {
  return address?.toLowerCase() === ETH_TOKEN_ADDRESS.toLowerCase();
}

function encodeFunctionData(functionName: string, args: any[] = []): string {
  const functionSignatures: Record<string, string> = {
    decimals: '0x313ce567',
    symbol: '0x95d89b41',
    name: '0x06fdde03',
    balanceOf: '0x70a08231',
    getEthBalance: '0x4d2301cc'
  };

  let encoded = functionSignatures[functionName] || '0x';

  if (functionName === 'balanceOf' && args.length > 0) {
    const address = args[0].toString().replace('0x', '').padStart(64, '0');
    encoded += address;
  }

  if (functionName === 'getEthBalance' && args.length > 0) {
    const address = args[0].toString().replace('0x', '').padStart(64, '0');
    encoded += address;
  }

  return encoded;
}

async function rpcCall(method: string, params: any[]): Promise<any> {
  const response = await fetch(KATANA_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params
    })
  });

  const result = await response.json();
  
  if (result.error) {
    throw new Error(result.error.message);
  }

  return result.result;
}

async function multicall(calls: any[]): Promise<any[]> {
  const results = await Promise.all(
    calls.map(async (call) => {
      try {
        const data = encodeFunctionData(call.functionName, call.args);
        const result = await rpcCall('eth_call', [
          {
            to: call.address,
            data
          },
          'latest'
        ]);
        return { status: 'success', result };
      } catch (error) {
        return { status: 'failure', result: '0x' };
      }
    })
  );

  return results;
}

function decodeUint(hex: string): bigint {
  return BigInt(hex);
}

function decodeString(hex: string): string {
  try {
    const cleaned = hex.replace('0x', '');
    const bytes = cleaned.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || [];
    return String.fromCharCode(...bytes.filter(b => b > 0 && b < 128));
  } catch {
    return '';
  }
}

async function getBalances(
  chainID: number,
  address: TAddress | undefined,
  tokens: TUseBalancesTokens[]
): Promise<[TDict<TToken>, Error | undefined]> {
  let result: TDict<TToken> = {};
  if (!address) {
    return [{}, undefined];
  }
  const ownerAddress = address;
  const calls: any[] = [];

  for (const element of tokens) {
    const { address: token } = element;

    if (isEthAddress(token)) {
      if (element.decimals === undefined || element.decimals === 0) {
        calls.push({ address: ETH_TOKEN_ADDRESS, functionName: 'decimals' });
      }
      if (element.symbol === undefined || element.symbol === '') {
        calls.push({ address: ETH_TOKEN_ADDRESS, functionName: 'symbol' });
      }
      if (element.name === undefined || element.name === '') {
        calls.push({ address: ETH_TOKEN_ADDRESS, functionName: 'name' });
      }
      if (ownerAddress) {
        calls.push({
          address: MULTICALL3_ADDRESS,
          functionName: 'getEthBalance',
          args: [ownerAddress]
        });
      }
    } else {
      if (element.decimals === undefined || element.decimals === 0) {
        calls.push({ address: token, functionName: 'decimals' });
      }
      if (element.symbol === undefined || element.symbol === '') {
        calls.push({ address: token, functionName: 'symbol' });
      }
      if (element.name === undefined || element.name === '') {
        calls.push({ address: token, functionName: 'name' });
      }
      if (ownerAddress) {
        calls.push({ address: token, functionName: 'balanceOf', args: [ownerAddress] });
      }
    }
  }

  try {
    const results = await multicall(calls);

    const _data: TDict<TToken> = {};
    const hasOwnerAddress = Boolean(ownerAddress) && !isZeroAddress(ownerAddress);

    let callIndex = 0;
    for (const element of tokens) {
      const { address, decimals: injectedDecimals, name: injectedName, symbol: injectedSymbol } = element;
      
      if (!_data[toAddress(address)]) {
        _data[toAddress(address)] = {
          address: address,
          name: injectedName || '',
          symbol: injectedSymbol || '',
          decimals: injectedDecimals || 18,
          chainID: chainID,
          balance: toNormalizedBN(BigInt(0), injectedDecimals || 18),
          value: 0
        };
      }

      if (injectedDecimals === undefined || injectedDecimals === 0) {
        const decimalResult = results[callIndex];
        if (decimalResult?.status === 'success') {
          _data[toAddress(address)].decimals = Number(decodeUint(decimalResult.result)) || 18;
        }
        callIndex++;
      }

      if (injectedSymbol === undefined || injectedSymbol === '') {
        const symbolResult = results[callIndex];
        if (symbolResult?.status === 'success') {
          _data[toAddress(address)].symbol = decodeString(symbolResult.result) || '';
        }
        callIndex++;
      }

      if (injectedName === undefined || injectedName === '') {
        const nameResult = results[callIndex];
        if (nameResult?.status === 'success') {
          _data[toAddress(address)].name = decodeString(nameResult.result) || '';
        }
        callIndex++;
      }

      if (hasOwnerAddress) {
        const balanceResult = results[callIndex];
        if (balanceResult?.status === 'success') {
          const balanceOf = decodeUint(balanceResult.result);
          _data[toAddress(address)].balance = toNormalizedBN(balanceOf, _data[toAddress(address)].decimals);
        }
        callIndex++;
      }
    }

    return [_data, undefined];
  } catch (error) {
    console.error('Failed to fetch balances:', error);
    return [result, error as Error];
  }
}

async function calculateCumulatedValue(walletAddress: string): Promise<number> {
  const chainId = KATANA_CHAIN_ID;
  
  const vaultsResponse = await fetch(`https://ydaemon.yearn.fi/${chainId}/vaults/all`);
  const allVaults = await vaultsResponse.json();
  
  const activeVaults = allVaults.filter(
    (vault: any) =>
      vault.version?.startsWith("3") &&
      vault.migration?.available !== true &&
      !vault.info?.isRetired
  );
  const migrations = allVaults.filter(
    (vault: any) =>
      vault.version?.startsWith("3") && vault.migration?.available === true
  );
  const retired = allVaults.filter(
    (vault: any) =>
      vault.version?.startsWith("3") && vault.info?.isRetired === true
  );
  
  const vaultsList = [...activeVaults, ...migrations, ...retired];
  
  const tokens = vaultsList.map((vault: any) => ({
    address: vault.address.toLowerCase(),
    chainID: chainId,
    decimals: vault.decimals || 18,
    name: vault.name,
    symbol: vault.symbol
  }));
  
  const [balances] = await getBalances(chainId, walletAddress.toLowerCase(), tokens);
  
  let total = 0;
  
  for (const vault of vaultsList) {
    const balance = balances[vault.address.toLowerCase()]?.balance?.normalized || 0;
    const price = vault.tvl?.price || 0;
    const vaultValue = balance * price;
    total += vaultValue;
    
    if (vault?.staking?.available && vault?.staking?.address) {
      const stakingBalance = balances[vault.staking.address.toLowerCase()]?.balance?.normalized || 0;
      const stakingValue = stakingBalance * price;
      total += stakingValue;
    }
  }
  
  return total;
}

export default calculateCumulatedValue;