import { Address, createPublicClient, http, getContract } from "viem"
import { ChainId } from "sushi"

// Katana chain configuration
const KATANA_RPC = "https://rpc.katana.network"

// Known addresses to exclude (router, wrapped native, common tokens)
const EXCLUDED_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000', // zero address
  '0xac4c6e212a361c968f1725b4d055b47e63f80b75', // Sushi router
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // ETH placeholder
  '0xd2b37ade14708bf18904047b1e31f8166d39612b', // Common recipient
])

// V3 Pool ABI for fee() function
const POOL_ABI = [
  {
    inputs: [],
    name: 'fee',
    outputs: [{ name: '', type: 'uint24' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

interface PoolFeeInfo {
  poolAddress: Address
  feeTier: number // e.g., 100 = 0.01%, 500 = 0.05%, 3000 = 0.3%, 10000 = 1%
  feePercentage: string // e.g., "0.3%"
}

/**
 * Check if an address looks like it could be a valid contract address
 * Filters out obviously invalid addresses (too many leading zeros, padding)
 */
function isValidContractAddress(addr: string, additionalExclusions: string[] = []): boolean {
  const normalized = addr.toLowerCase()

  // Exclude known non-pool addresses
  if (EXCLUDED_ADDRESSES.has(normalized)) {
    return false
  }

  // Exclude additional addresses (e.g., token addresses)
  if (additionalExclusions.includes(normalized)) {
    return false
  }

  // Filter out addresses with more than 10 leading zeros (likely encoded data)
  // Real deployed contracts rarely have this many leading zeros
  const leadingZeros = (normalized.match(/^0x(0+)/)?.[1] || '').length
  if (leadingZeros > 10) {
    return false
  }

  // Filter out addresses that end with too many zeros (likely padding)
  const trailingZeros = (normalized.match(/(0+)$/)?.[1] || '').length
  if (trailingZeros > 10) {
    return false
  }

  return true
}

/**
 * Check if an address has contract code deployed
 */
async function isContract(address: Address, client: any): Promise<boolean> {
  try {
    const code = await client.getBytecode({ address })
    return code !== undefined && code !== '0x'
  } catch {
    return false
  }
}

/**
 * Extract pool addresses from transaction data
 * Sushi router encodes pool addresses in the calldata
 */
async function extractPoolAddresses(txData: string, client: any, excludeAddresses: string[] = []): Promise<Address[]> {
  const pools: Address[] = []

  // Pool addresses are 20 bytes (40 hex chars)
  // Look for patterns that match Ethereum addresses in the calldata
  const addressPattern = /[0-9a-fA-F]{40}/g
  const matches = txData.match(addressPattern)

  if (!matches) {
    return pools
  }

  // Get unique addresses
  const uniqueSet = new Set(matches)
  const candidateAddresses = Array.from(uniqueSet)
    .map(addr => `0x${addr}`.toLowerCase() as Address)
    .filter(addr => isValidContractAddress(addr, excludeAddresses))

  console.log(`[Pool Fee] Found ${candidateAddresses.length} candidate address(es) after filtering`)

  // Check which addresses are actual contracts
  for (const addr of candidateAddresses) {
    if (await isContract(addr, client)) {
      pools.push(addr)
    }
  }

  return pools
}

/**
 * Query pool contract to get fee tier
 */
async function getPoolFeeTier(poolAddress: Address, client: any): Promise<number | null> {
  try {
    const fee = await client.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: 'fee',
    } as any)

    return Number(fee)
  } catch (error) {
    // Silently skip - address might not be a pool or might not have fee() function
    return null
  }
}

/**
 * Convert fee tier to percentage string
 */
function formatFeePercentage(feeTier: number): string {
  // Fee tier is in hundredths of a basis point
  // 100 = 0.01%, 500 = 0.05%, 3000 = 0.3%, 10000 = 1%
  const percentage = feeTier / 10000
  return `${percentage}%`
}

/**
 * Extract pool addresses and their fee tiers from swap transaction data
 * @param txData - Transaction calldata
 * @param excludeAddresses - Addresses to exclude from pool search (e.g., token addresses)
 */
export async function extractPoolFeeTiers(txData: string, excludeAddresses: string[] = []): Promise<PoolFeeInfo[]> {
  // Create RPC client
  const client = createPublicClient({
    transport: http(KATANA_RPC),
  })

  // Extract pool addresses from calldata
  const poolAddresses = await extractPoolAddresses(txData, client, excludeAddresses)

  if (poolAddresses.length === 0) {
    console.warn('[Pool Fee] No valid pool addresses found in transaction data')
    return []
  }

  console.log(`[Pool Fee] Found ${poolAddresses.length} valid pool address(es):`, poolAddresses)

  // Query each pool for its fee tier
  const poolFeeInfos: PoolFeeInfo[] = []

  for (const poolAddress of poolAddresses) {
    const feeTier = await getPoolFeeTier(poolAddress, client)

    if (feeTier !== null) {
      console.log(`[Pool Fee] Pool ${poolAddress} has fee tier ${feeTier} (${formatFeePercentage(feeTier)})`)
      poolFeeInfos.push({
        poolAddress,
        feeTier,
        feePercentage: formatFeePercentage(feeTier),
      })
    }
  }

  if (poolFeeInfos.length === 0) {
    console.warn('[Pool Fee] No pools with valid fee tiers found')
  }

  return poolFeeInfos
}

/**
 * Calculate total fees paid by user based on amount and fee tiers
 * For multi-hop swaps, fees compound
 */
export function calculateTotalFees(
  amountIn: bigint,
  poolFees: PoolFeeInfo[]
): {
  totalFeeAmount: bigint
  totalFeePercentage: number
  feeBreakdown: Array<{ pool: Address; feeAmount: bigint; feeTier: number }>
} {
  let remainingAmount = amountIn
  const feeBreakdown: Array<{ pool: Address; feeAmount: bigint; feeTier: number }> = []

  // For each pool in the route, calculate fee taken
  for (const poolFee of poolFees) {
    // Fee is taken from the input amount: feeAmount = amount * (feeTier / 1000000)
    const feeAmount = (remainingAmount * BigInt(poolFee.feeTier)) / BigInt(1000000)
    remainingAmount = remainingAmount - feeAmount

    feeBreakdown.push({
      pool: poolFee.poolAddress,
      feeAmount,
      feeTier: poolFee.feeTier,
    })
  }

  const totalFeeAmount = amountIn - remainingAmount
  const totalFeePercentage = Number(totalFeeAmount * BigInt(1000000) / amountIn) / 10000

  return {
    totalFeeAmount,
    totalFeePercentage,
    feeBreakdown,
  }
}
