/**
 * Bot Wallet Manager
 * Manages bot wallets loaded from environment variables
 * Supports WALLET_1, WALLET_2, ... WALLET_N private keys
 */

import { ethers } from 'ethers'

export interface BotWallet {
  index: number
  address: string
  privateKey: string
  signer: ethers.Wallet
}

/**
 * Load all bot wallets from environment variables
 * Looks for WALLET_1, WALLET_2, etc.
 */
export function loadBotWallets(provider: ethers.Provider): BotWallet[] {
  const wallets: BotWallet[] = []
  let index = 1

  while (true) {
    const envKey = `WALLET_${index}`
    const privateKey = process.env[envKey]

    if (!privateKey) {
      // Stop when we don't find the next wallet
      break
    }

    try {
      const wallet = new ethers.Wallet(privateKey, provider)
      wallets.push({
        index,
        address: wallet.address,
        privateKey,
        signer: wallet
      })
      console.log(`[Bot Wallet Manager] Loaded wallet ${index}: ${wallet.address}`)
      index++
    } catch (error) {
      console.error(`[Bot Wallet Manager] Invalid private key for ${envKey}:`, error)
      break
    }
  }

  if (wallets.length === 0) {
    console.warn('[Bot Wallet Manager] No bot wallets found in environment variables!')
    console.warn('[Bot Wallet Manager] Add wallet private keys as WALLET_1, WALLET_2, etc.')
  } else {
    console.log(`[Bot Wallet Manager] Loaded ${wallets.length} bot wallets`)
  }

  return wallets
}

/**
 * Get a specific wallet by index
 */
export function getBotWallet(wallets: BotWallet[], index: number): BotWallet | undefined {
  return wallets.find(w => w.index === index)
}

/**
 * Get token balance for a wallet
 */
export async function getTokenBalance(
  provider: ethers.Provider,
  tokenAddress: string,
  ownerAddress: string,
  isNative: boolean = false
): Promise<bigint> {
  if (isNative || tokenAddress === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
    return await provider.getBalance(ownerAddress)
  } else {
    const ERC20_ABI = [
      'function balanceOf(address account) view returns (uint256)'
    ]
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider)
    return await tokenContract.balanceOf(ownerAddress)
  }
}

/**
 * Check and approve token if needed
 */
export async function ensureTokenApproval(
  wallet: ethers.Wallet,
  tokenAddress: string,
  spenderAddress: string,
  amountWei: string,
  isNative: boolean = false
): Promise<{ needsApproval: boolean; txHash?: string }> {
  // Native ETH doesn't need approval
  if (isNative || tokenAddress === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
    return { needsApproval: false }
  }

  const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)'
  ]

  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet)

  // Check current allowance
  const currentAllowance = await tokenContract.allowance(wallet.address, spenderAddress)

  console.log(`[Token Approval] Current allowance: ${currentAllowance.toString()}`)
  console.log(`[Token Approval] Required amount: ${amountWei}`)

  if (currentAllowance < BigInt(amountWei)) {
    console.log('[Token Approval] Insufficient allowance, approving...')

    // Approve unlimited amount (common pattern for bots)
    const approvalTx = await tokenContract.approve(spenderAddress, ethers.MaxUint256)
    console.log(`[Token Approval] Approval tx hash: ${approvalTx.hash}`)

    const receipt = await approvalTx.wait()
    console.log(`[Token Approval] Approved in block ${receipt?.blockNumber}`)

    return { needsApproval: true, txHash: approvalTx.hash }
  }

  console.log('[Token Approval] Sufficient allowance already exists')
  return { needsApproval: false }
}