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
 * Get token balance for a wallet with retry logic
 * Handles intermittent RPC failures with exponential backoff
 */
export async function getTokenBalance(
  provider: ethers.Provider,
  tokenAddress: string,
  ownerAddress: string,
  isNative: boolean = false,
  maxRetries: number = 3,
  retryDelayMs: number = 1000
): Promise<bigint> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (isNative || tokenAddress === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
        return await provider.getBalance(ownerAddress)
      } else {
        const ERC20_ABI = [
          'function balanceOf(address account) view returns (uint256)'
        ]
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider)
        return await tokenContract.balanceOf(ownerAddress)
      }
    } catch (error: any) {
      lastError = error

      // Check if it's a server error that should be retried
      const shouldRetry =
        error?.code === 'SERVER_ERROR' ||
        error?.message?.includes('500') ||
        error?.message?.includes('Internal Server Error')

      if (shouldRetry && attempt < maxRetries) {
        const delay = retryDelayMs * Math.pow(2, attempt - 1) // Exponential backoff
        console.log(`[Bot Wallet Manager] RPC error (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }

      // If not retryable or max retries reached, throw
      throw error
    }
  }

  // Should never reach here, but TypeScript needs this
  throw lastError || new Error('Failed to get token balance after retries')
}

/**
 * Check and approve token if needed with retry logic
 * Handles intermittent RPC failures with exponential backoff
 */
export async function ensureTokenApproval(
  wallet: ethers.Wallet,
  tokenAddress: string,
  spenderAddress: string,
  amountWei: string,
  isNative: boolean = false,
  maxRetries: number = 3,
  retryDelayMs: number = 1000
): Promise<{ needsApproval: boolean; txHash?: string }> {
  // Native ETH doesn't need approval
  if (isNative || tokenAddress === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
    return { needsApproval: false }
  }

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
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

        // Fetch fresh nonce for approval transaction
        const currentNonce = await wallet.provider!.getTransactionCount(wallet.address, 'pending')
        console.log(`[Token Approval] Using nonce: ${currentNonce}`)

        // Approve unlimited amount (common pattern for bots) with explicit nonce
        const approvalTx = await tokenContract.approve(
          spenderAddress,
          ethers.MaxUint256,
          { nonce: currentNonce }
        )
        console.log(`[Token Approval] Approval tx hash: ${approvalTx.hash}`)

        const receipt = await approvalTx.wait()
        console.log(`[Token Approval] Approved in block ${receipt?.blockNumber}`)

        return { needsApproval: true, txHash: approvalTx.hash }
      }

      console.log('[Token Approval] Sufficient allowance already exists')
      return { needsApproval: false }

    } catch (error: any) {
      lastError = error

      // Check if it's a nonce error that should be retried
      const isNonceError = error?.code === 'NONCE_EXPIRED' || error?.message?.includes('nonce too low')

      // Check if it's a server error that should be retried
      const isServerError =
        error?.code === 'SERVER_ERROR' ||
        error?.message?.includes('500') ||
        error?.message?.includes('Internal Server Error')

      const shouldRetry = isNonceError || isServerError

      if (shouldRetry && attempt < maxRetries) {
        const delay = isNonceError ? 2000 : retryDelayMs * Math.pow(2, attempt - 1) // Longer delay for nonce errors
        console.log(`[Token Approval] ${isNonceError ? 'Nonce' : 'RPC'} error (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }

      // If not retryable or max retries reached, throw
      throw error
    }
  }

  // Should never reach here, but TypeScript needs this
  throw lastError || new Error('Failed to ensure token approval after retries')
}