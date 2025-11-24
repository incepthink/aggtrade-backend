import express from 'express'
import {
  logClassicSwap,
  getUserVolume,
  getUserSwapHistory,
  getSwapByTxHash
} from '../controllers/tracking/sushiswapClassicSwap'
import {
  startExecution,
  startWalletExecution,
  completeWalletExecution,
  createPortfolioSnapshot,
  getExecutionDetails,
  getExecutionsList,
  getPortfolioHistory
} from '../controllers/tracking/bot'

const router = express.Router()

// SushiSwap Classic Swap endpoints
router.post('/sushiswap/classic-swap', logClassicSwap)
router.get('/sushiswap/user/:walletAddress/volume', getUserVolume)
router.get('/sushiswap/user/:walletAddress/history', getUserSwapHistory)
router.get('/sushiswap/tx/:txHash', getSwapByTxHash)

// Bot execution endpoints
router.post('/bot/execution/start', startExecution)
router.patch('/bot/execution/:id/wallet/:wallet_index/start', startWalletExecution)
router.patch('/bot/execution/:id/wallet/:wallet_index/complete', completeWalletExecution)
router.post('/bot/portfolio/snapshot', createPortfolioSnapshot)
router.get('/bot/execution/:id', getExecutionDetails)
router.get('/bot/executions', getExecutionsList)
router.get('/bot/portfolio/:execution_id/:wallet_address', getPortfolioHistory)

export default router
