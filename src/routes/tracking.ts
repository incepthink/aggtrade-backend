import express from 'express'
import {
  logClassicSwap,
  getUserVolume,
  getUserSwapHistory,
  getSwapByTxHash,
  streamSwaps
} from '../controllers/tracking/sushiswapClassicSwap'
import {
  syncLimitOrders
} from '../controllers/tracking/sushiswapLimitOrder'
import {
  placeLimitOrder,
  updateLimitOrderFilled,
  getLimitOrdersByExecution
} from '../controllers/tracking/botLimitOrder'
import {
  startExecution,
  startWalletExecution,
  completeWalletExecution,
  createPortfolioSnapshot,
  getExecutionDetails,
  getExecutionsList,
  getPortfolioHistory
} from '../controllers/tracking/bot'
import {
  getDashboardData,
  getVolumeOverTime,
  getTopTokens,
  getTopWallets
} from '../controllers/tracking/sushiswapDashboard'

const router = express.Router()

// SushiSwap Dashboard endpoints
router.get('/sushiswap/dashboard', getDashboardData)
router.get('/sushiswap/dashboard/volume-over-time', getVolumeOverTime)
router.get('/sushiswap/dashboard/top-tokens', getTopTokens)
router.get('/sushiswap/dashboard/top-wallets', getTopWallets)

// SushiSwap Classic Swap endpoints
router.post('/sushiswap/classic-swap', logClassicSwap)
router.get('/sushiswap/stream', streamSwaps)
router.get('/sushiswap/user/:walletAddress/volume', getUserVolume)
router.get('/sushiswap/user/:walletAddress/history', getUserSwapHistory)
router.get('/sushiswap/tx/:txHash', getSwapByTxHash)

// SushiSwap Limit Order endpoints
router.post('/sushiswap/limit-orders/sync', syncLimitOrders)

// Bot execution endpoints
router.post('/bot/execution/start', startExecution)
router.patch('/bot/execution/:id/wallet/:wallet_index/start', startWalletExecution)
router.patch('/bot/execution/:id/wallet/:wallet_index/complete', completeWalletExecution)
router.post('/bot/portfolio/snapshot', createPortfolioSnapshot)
router.get('/bot/execution/:id', getExecutionDetails)
router.get('/bot/executions', getExecutionsList)
router.get('/bot/portfolio/:execution_id/:wallet_address', getPortfolioHistory)

// Bot limit order endpoints
router.post('/bot/limit-order/placed', placeLimitOrder)
router.patch('/bot/limit-order/:order_id/filled', updateLimitOrderFilled)
router.get('/bot/limit-orders/:execution_id', getLimitOrdersByExecution)

export default router
