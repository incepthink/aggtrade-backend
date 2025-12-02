import { ethers } from 'ethers'
import { BotWallet } from './types'
import { startWalletMonitor } from './walletMonitor'
import { generateExecutionId, sleep } from '../utils/botHelpers'
import BotExecution from '../../models/BotExecution'
import BotWalletExecution from '../../models/BotWalletExecution'
import BotLimitOrder from '../../models/BotLimitOrder'
import { KatanaLogger } from '../../utils/logger'
import { getGridConfig } from './gridManager'

const PREFIX = '[GridBotOrchestrator]'

const RPC_URL = 'https://rpc.katana.network'
const WALLET_START_STAGGER_MS = 10000 // 10 seconds between wallet starts

/**
 * Load bot wallets from environment variables
 */
function loadBotWallets(provider: ethers.Provider): BotWallet[] {
  const wallets: BotWallet[] = []

  for (let i = 1; i <= 10; i++) {
    const envKey = `WALLET_${i}`
    const privateKey = process.env[envKey]

    if (!privateKey) {
      KatanaLogger.info(PREFIX, `${envKey} not found, stopping wallet loading at ${i - 1} wallets`)
      break
    }

    try {
      const wallet = new ethers.Wallet(privateKey, provider)

      wallets.push({
        index: i,
        address: wallet.address,
        privateKey,
        signer: wallet
      })

      KatanaLogger.info(PREFIX, `Loaded ${envKey}: ${wallet.address}`)
    } catch (error) {
      KatanaLogger.error(PREFIX, `Failed to load ${envKey}`, error)
      // Continue loading other wallets
    }
  }

  return wallets
}

/**
 * Get the latest execution ID for a wallet that has pending orders
 * Returns null if no pending orders exist for this wallet
 */
async function getLatestExecutionForWallet(walletAddress: string): Promise<string | null> {
  try {
    // Find the most recent wallet execution that has pending/partial orders
    const latestExecution = await BotWalletExecution.findOne({
      where: {
        wallet_address: walletAddress
      },
      order: [['created_at', 'DESC']],
      include: [{
        model: BotLimitOrder,
        where: {
          status: ['pending', 'partial']
        },
        required: true, // INNER JOIN - only return if pending orders exist
        attributes: ['id'] // We only need to check existence
      }]
    })

    if (latestExecution) {
      const orderCount = await BotLimitOrder.count({
        where: {
          execution_id: latestExecution.execution_id,
          wallet_address: walletAddress,
          status: ['pending', 'partial']
        }
      })

      KatanaLogger.info(PREFIX,
        `Found latest execution ${latestExecution.execution_id} for wallet ${walletAddress} ` +
        `with ${orderCount} pending orders`
      )

      return latestExecution.execution_id
    }

    KatanaLogger.info(PREFIX, `No pending orders found for wallet ${walletAddress} - will create new execution`)
    return null
  } catch (error) {
    KatanaLogger.error(PREFIX, `Failed to get latest execution for ${walletAddress}`, error)
    return null // Fall back to creating new execution
  }
}

/**
 * Initialize bot execution record
 */
async function initializeBotExecution(
  executionId: string,
  totalWallets: number
): Promise<void> {
  try {
    await BotExecution.create({
      execution_id: executionId,
      strategy_name: 'grid_bot',
      total_wallets: totalWallets,
      completed_wallets: 0,
      failed_wallets: 0,
      total_volume_usd: 0,
      start_time: new Date(),
      status: 'running'
    })

    KatanaLogger.info(PREFIX, `Bot execution initialized: ${executionId}`)
  } catch (error) {
    KatanaLogger.error(PREFIX, 'Failed to initialize bot execution', error)
    throw error
  }
}

/**
 * Initialize wallet execution record
 */
async function initializeWalletExecution(
  executionId: string,
  wallet: BotWallet
): Promise<void> {
  try {
    await BotWalletExecution.create({
      execution_id: executionId,
      wallet_index: wallet.index,
      wallet_address: wallet.address,
      tokens: ['ETH', 'USDC'],
      swaps_completed: 0,
      limit_orders_placed: 6, // Initial grid: 3 buy + 3 sell
      limit_orders_filled: 0,
      total_volume_usd: 0,
      status: 'running',
      start_time: new Date()
    })

    KatanaLogger.info(PREFIX, `Wallet execution initialized: ${wallet.address}`)
  } catch (error) {
    KatanaLogger.error(PREFIX, `Failed to initialize wallet execution for ${wallet.address}`, error)
    // Don't throw - continue with other wallets
  }
}

/**
 * Start a single wallet monitor with error handling
 */
async function startWalletMonitorSafe(
  wallet: BotWallet,
  executionId: string
): Promise<void> {
  try {
    // Check if wallet execution already exists (resuming case)
    const existingWalletExecution = await BotWalletExecution.findOne({
      where: {
        execution_id: executionId,
        wallet_address: wallet.address
      }
    })

    if (!existingWalletExecution) {
      // New execution - initialize wallet execution record
      await initializeWalletExecution(executionId, wallet)
    } else {
      // Resuming execution - just update status
      KatanaLogger.info(PREFIX,
        `[Wallet ${wallet.index}] Resuming existing wallet execution`
      )
    }

    await startWalletMonitor(wallet, executionId)

    await BotWalletExecution.update(
      { status: 'running' },
      {
        where: {
          execution_id: executionId,
          wallet_address: wallet.address
        }
      }
    )
  } catch (error) {
    KatanaLogger.error(PREFIX, `Failed to start monitor for wallet ${wallet.index}`, error)

    // Update wallet execution status to failed
    try {
      await BotWalletExecution.update(
        {
          status: 'failed',
          error_message: error instanceof Error ? error.message : 'Unknown error',
          end_time: new Date()
        },
        {
          where: {
            execution_id: executionId,
            wallet_address: wallet.address
          }
        }
      )

      // Increment failed wallet counter
      await BotExecution.increment('failed_wallets', {
        where: { execution_id: executionId }
      })
    } catch (updateError) {
      KatanaLogger.error(PREFIX, 'Failed to update failed wallet status', updateError)
    }
  }
}

/**
 * Start the grid bot orchestrator
 */
export async function startGridBotOrchestrator(): Promise<void> {
  KatanaLogger.info(PREFIX, '=== GRID BOT ORCHESTRATOR STARTING ===')

  try {
    // Check testing mode
    const gridConfig = getGridConfig()
    if (gridConfig.TESTING_MODE) {
      KatanaLogger.warn(PREFIX, '╔══════════════════════════════════════════════════════╗')
      KatanaLogger.warn(PREFIX, '║          🧪 TESTING MODE ENABLED 🧪                  ║')
      KatanaLogger.warn(PREFIX, '║  Orders will NOT be sent to blockchain              ║')
      KatanaLogger.warn(PREFIX, '║  All orders will be auto-marked as filled           ║')
      KatanaLogger.warn(PREFIX, '║  Set GRID_BOT_TESTING_MODE=false to disable         ║')
      KatanaLogger.warn(PREFIX, '╚══════════════════════════════════════════════════════╝')
    }

    // 1. Initialize Ethereum provider
    const provider = new ethers.JsonRpcProvider(RPC_URL)
    KatanaLogger.info(PREFIX, `Connected to RPC: ${RPC_URL}`)

    // 2. Load bot wallets from environment
    const wallets = loadBotWallets(provider)

    if (wallets.length === 0) {
      KatanaLogger.error(PREFIX, 'No wallets loaded! Check environment variables WALLET_1, WALLET_2, etc.')
      return
    }

    KatanaLogger.info(PREFIX, `Loaded ${wallets.length} wallets`)

    // 3. Check for existing executions or create new ones per wallet
    const walletExecutions: Map<string, string> = new Map() // wallet address -> executionId
    let newExecutionsNeeded = 0

    for (const wallet of wallets) {
      const existingExecutionId = await getLatestExecutionForWallet(wallet.address)

      if (existingExecutionId) {
        walletExecutions.set(wallet.address, existingExecutionId)
        KatanaLogger.info(PREFIX,
          `[Wallet ${wallet.index}] Resuming execution: ${existingExecutionId}`
        )
      } else {
        newExecutionsNeeded++
      }
    }

    // 4. Create new execution ID for wallets that need one
    let newExecutionId: string | null = null
    if (newExecutionsNeeded > 0) {
      newExecutionId = generateExecutionId()
      KatanaLogger.info(PREFIX,
        `Creating new execution ${newExecutionId} for ${newExecutionsNeeded} wallet(s) without pending orders`
      )

      // Initialize bot execution record for new execution
      await initializeBotExecution(newExecutionId, newExecutionsNeeded)

      // Assign new execution ID to wallets that need it
      for (const wallet of wallets) {
        if (!walletExecutions.has(wallet.address)) {
          walletExecutions.set(wallet.address, newExecutionId)
          KatanaLogger.info(PREFIX,
            `[Wallet ${wallet.index}] Using new execution: ${newExecutionId}`
          )
        }
      }
    }

    // 5. Start wallet monitors with staggered timing
    KatanaLogger.info(PREFIX,
      `Starting ${wallets.length} wallet monitors (staggered by ${WALLET_START_STAGGER_MS / 1000}s)...`
    )

    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i]
      const executionId = walletExecutions.get(wallet.address)!

      KatanaLogger.info(PREFIX,
        `[${i + 1}/${wallets.length}] Starting monitor for wallet ${wallet.index} with execution ${executionId}...`
      )

      // Start monitor (async, doesn't block)
      startWalletMonitorSafe(wallet, executionId).catch((error) => {
        KatanaLogger.error(PREFIX, `Uncaught error in wallet ${wallet.index} monitor`, error)
      })

      // Stagger starts (except for last wallet)
      if (i < wallets.length - 1) {
        KatanaLogger.info(PREFIX, 
          `Waiting ${WALLET_START_STAGGER_MS / 1000}s before starting next wallet...`
        )
        await sleep(WALLET_START_STAGGER_MS)
      }
    }

    KatanaLogger.info(PREFIX, '=== ALL WALLET MONITORS STARTED ===')
    KatanaLogger.info(PREFIX, 
      `Grid bot is now running with ${wallets.length} wallets. Monitoring every 2-3 minutes.`
    )
  } catch (error) {
    KatanaLogger.error(PREFIX, 'Grid bot orchestrator failed to start', error)
    throw error
  }
}
