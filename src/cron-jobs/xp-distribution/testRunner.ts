/**
 * XP Distribution Test Runner
 *
 * This script provides full integration testing of the XP distribution system by:
 * 1. Seeding the database with test data from testDataExamples.json
 * 2. Running the complete XP distribution calculation
 * 3. Cleaning up test data from the database
 *
 * Usage:
 *   bun run src/cron-jobs/xp-distribution/testRunner.ts
 */

import fs from 'fs'
import path from 'path'
import { Op } from 'sequelize'
import SushiswapActivity from '../../models/SushiswapActivity'
import sequelize from '../../utils/db/sequelize'
import { disrtibuteXPJob } from './index'

/**
 * Load test data from JSON file
 */
function loadTestData(): any[] {
  const jsonPath = path.join(__dirname, 'testDataExamples.json')
  const jsonContent = fs.readFileSync(jsonPath, 'utf-8')
  const testData = JSON.parse(jsonContent)

  console.log(`Loaded ${testData.length} test swaps from testDataExamples.json`)
  return testData
}

/**
 * Seed database with test data
 *
 * @param testData - Array of test swap records from JSON
 * @returns Array of created record IDs for cleanup
 */
async function seedTestData(testData: any[]): Promise<number[]> {
  console.log('\n=== SEEDING DATABASE ===')

  // Convert JSON data to format suitable for bulkCreate
  const swapsToCreate = testData.map(swap => ({
    user_id: swap.user_id,
    wallet_address: swap.wallet_address,
    swap_type: swap.swap_type,
    tx_hash: swap.tx_hash,
    chain_id: swap.chain_id,
    block_number: swap.block_number,
    block_timestamp: swap.block_timestamp ? new Date(swap.block_timestamp) : null,
    token_from_address: swap.token_from_address,
    token_from_symbol: swap.token_from_symbol,
    token_from_amount: swap.token_from_amount,
    token_to_address: swap.token_to_address,
    token_to_symbol: swap.token_to_symbol,
    token_to_amount: swap.token_to_amount,
    usd_volume: swap.usd_volume,
    fees_usd: swap.fees_usd,
    execution_price: swap.execution_price,
    price_impact: swap.price_impact,
    pool_id: swap.pool_id,
    order_id: swap.order_id,
    filled_src_amount: swap.filled_src_amount,
    filled_dst_amount: swap.filled_dst_amount,
    is_partial_fill: swap.is_partial_fill,
    progress: swap.progress,
    status: swap.status,
    metadata: swap.metadata,
    timestamp: new Date(swap.timestamp) // Convert ISO string to Date
  }))

  // Insert all test swaps in a single transaction
  const createdSwaps = await SushiswapActivity.bulkCreate(swapsToCreate, {
    returning: true,
    validate: true
  })

  const createdIds = createdSwaps.map(swap => swap.id)

  console.log(`Successfully inserted ${createdIds.length} test swaps`)
  console.log(`Created IDs: ${createdIds.join(', ')}`)

  return createdIds
}

/**
 * Clean up test data from database
 *
 * @param createdIds - Array of record IDs to delete
 */
async function cleanupTestData(createdIds: number[]): Promise<void> {
  console.log('\n=== CLEANING UP TEST DATA ===')

  if (createdIds.length === 0) {
    console.log('No records to clean up')
    return
  }

  const deletedCount = await SushiswapActivity.destroy({
    where: {
      id: {
        [Op.in]: createdIds
      }
    }
  })

  console.log(`Deleted ${deletedCount} test swap records`)
}

/**
 * Main test flow
 */
async function runTest() {
  let createdIds: number[] = []

  try {
    // Step 1: Load test data from JSON
    console.log('=== XP DISTRIBUTION TEST RUNNER ===\n')
    console.log('Step 1: Loading test data...')
    const testData = loadTestData()

    // Step 2: Seed database
    console.log('\nStep 2: Seeding database with test data...')
    createdIds = await seedTestData(testData)

    // Step 3: Run XP distribution with test week range
    console.log('\nStep 3: Running XP distribution calculation...')

    // Define test week range (December 9-16, 2025)
    const testWeekRange = {
      weekStart: new Date('2025-12-09T00:00:00Z'),
      weekEnd: new Date('2025-12-16T00:00:00Z')
    }

    await disrtibuteXPJob(testWeekRange)

    // Step 4: Cleanup
    console.log('\nStep 4: Cleaning up test data...')
    await cleanupTestData(createdIds)

    console.log('\n=== TEST COMPLETED SUCCESSFULLY ===')

  } catch (error) {
    console.error('\n=== TEST FAILED ===')
    console.error('Error:', error)

    // Attempt cleanup even if test fails
    if (createdIds.length > 0) {
      try {
        console.log('\nAttempting cleanup after error...')
        await cleanupTestData(createdIds)
      } catch (cleanupError) {
        console.error('Cleanup failed:', cleanupError)
      }
    }

    process.exit(1)
  } finally {
    // Close database connection
    await sequelize.close()
    console.log('\nDatabase connection closed')
  }
}

// Run the test
runTest()
