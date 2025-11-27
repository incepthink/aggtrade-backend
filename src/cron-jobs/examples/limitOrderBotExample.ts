/**
 * LIMIT ORDER BOT - USAGE EXAMPLES
 *
 * This file shows how to use the limit order bot with different configurations
 */

import { triggerLimitOrderBotManually, type LimitOrderParams } from '../limitOrderBot'

// ============================================================================
// EXAMPLE 1: Simple ETH → USDC Limit Order
// ============================================================================

async function example1_SimpleETHToUSDC() {
  console.log('\n=== EXAMPLE 1: Simple ETH → USDC Limit Order ===\n')

  const params: LimitOrderParams = {
    fromToken: 'ETH',
    toToken: 'USDC',
    fromAmount: '1.0',        // Sell 1 ETH
    limitPrice: 2100,         // At price of 2100 USDC per ETH
    chunks: 10,               // Split into 10 chunks
    fillDelayMinutes: 30,     // Execute 1 chunk every 30 minutes
    expiryHours: 24           // Order expires in 24 hours
  }

  await triggerLimitOrderBotManually(params)
}

// ============================================================================
// EXAMPLE 2: USDC → ETH Limit Order (Buying ETH)
// ============================================================================

async function example2_USDCToETH() {
  console.log('\n=== EXAMPLE 2: USDC → ETH Limit Order (Buying ETH) ===\n')

  const params: LimitOrderParams = {
    fromToken: 'USDC',
    toToken: 'ETH',
    fromAmount: '5000',       // Spend 5000 USDC
    limitPrice: 0.0005,       // At price of 0.0005 ETH per USDC (= 1 ETH for 2000 USDC)
    chunks: 5,                // Split into 5 chunks (1000 USDC each)
    fillDelayMinutes: 60,     // Execute 1 chunk every hour
    expiryHours: 48           // Order expires in 48 hours
  }

  await triggerLimitOrderBotManually(params)
}

// ============================================================================
// EXAMPLE 3: Small Test Order
// ============================================================================

async function example3_SmallTestOrder() {
  console.log('\n=== EXAMPLE 3: Small Test Order ===\n')

  const params: LimitOrderParams = {
    fromToken: 'ETH',
    toToken: 'USDC',
    fromAmount: '0.01',       // Small test: 0.01 ETH
    limitPrice: 2000,         // At current market price
    chunks: 2,                // Just 2 chunks for testing
    fillDelayMinutes: 5,      // Quick execution - 5 minutes between chunks
    expiryHours: 12           // Expires in 12 hours
  }

  await triggerLimitOrderBotManually(params)
}

// ============================================================================
// EXAMPLE 4: Aggressive DCA Strategy
// ============================================================================

async function example4_AggressiveDCA() {
  console.log('\n=== EXAMPLE 4: Aggressive DCA Strategy ===\n')

  const params: LimitOrderParams = {
    fromToken: 'USDC',
    toToken: 'ETH',
    fromAmount: '10000',      // $10,000 USDC
    limitPrice: 0.00048,      // Buy at $2083 per ETH (0.00048 ETH per USDC)
    chunks: 20,               // 20 small chunks ($500 each)
    fillDelayMinutes: 15,     // Execute every 15 minutes
    expiryHours: 6            // Complete within 6 hours
  }

  await triggerLimitOrderBotManually(params)
}

// ============================================================================
// EXAMPLE 5: Conservative Take Profit
// ============================================================================

async function example5_ConservativeTakeProfit() {
  console.log('\n=== EXAMPLE 5: Conservative Take Profit ===\n')

  const params: LimitOrderParams = {
    fromToken: 'ETH',
    toToken: 'USDC',
    fromAmount: '5.0',        // Sell 5 ETH
    limitPrice: 2200,         // Take profit at $2200
    chunks: 25,               // Small chunks for minimal slippage
    fillDelayMinutes: 120,    // Execute every 2 hours
    expiryHours: 168          // Expires in 1 week
  }

  await triggerLimitOrderBotManually(params)
}

// ============================================================================
// RUN EXAMPLES
// ============================================================================

async function runExample() {
  const exampleNumber = process.env.EXAMPLE || '3' // Default to example 3 (small test)

  switch (exampleNumber) {
    case '1':
      await example1_SimpleETHToUSDC()
      break
    case '2':
      await example2_USDCToETH()
      break
    case '3':
      await example3_SmallTestOrder()
      break
    case '4':
      await example4_AggressiveDCA()
      break
    case '5':
      await example5_ConservativeTakeProfit()
      break
    default:
      console.log('Invalid example number. Use EXAMPLE=1, EXAMPLE=2, etc.')
      process.exit(1)
  }
}

// Uncomment to run:
// runExample().catch(console.error)

export {
  example1_SimpleETHToUSDC,
  example2_USDCToETH,
  example3_SmallTestOrder,
  example4_AggressiveDCA,
  example5_ConservativeTakeProfit
}