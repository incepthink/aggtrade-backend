/**
 * Test script for Morpho withdraw endpoint
 * Run with: bun run test-morpho-endpoint.ts
 */

import type { MorphoWithdrawRequest, MorphoWithdrawResponse } from "./src/types/transaction"

const API_BASE_URL = process.env.API_URL || "http://localhost:5000"

async function testMorphoWithdraw() {
  console.log("\n=== Testing Morpho Withdraw Endpoint ===\n")

  // Example test data - replace with real values to actually test
  const testRequest: MorphoWithdrawRequest = {
    vaultAddress: "0x0000000000000000000000000000000000000001", // Replace with real vault
    assetAddress: "0x0000000000000000000000000000000000000002", // Replace with real asset
    userAddress: "0x0000000000000000000000000000000000000003", // Replace with real user
    amount: "100.5", // Human-readable amount
    chainId: 747474, // Katana
    decimals: 18
  }

  console.log("Request payload:")
  console.log(JSON.stringify(testRequest, null, 2))

  try {
    const response = await fetch(`${API_BASE_URL}/api/transaction/morpho/withdraw/prepare`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(testRequest)
    })

    console.log(`\nResponse status: ${response.status} ${response.statusText}`)

    const data = await response.json()
    console.log("\nResponse data:")
    console.log(JSON.stringify(data, null, 2))

    if (response.ok) {
      const morphoResponse = data.data as MorphoWithdrawResponse
      console.log(`\n✅ Success! Generated ${morphoResponse.transactions.length} transaction(s)`)
      console.log(`Needs approval: ${morphoResponse.needsApproval}`)

      morphoResponse.transactions.forEach((tx, i) => {
        console.log(`\nTransaction ${i + 1}:`)
        console.log(`  To: ${tx.to}`)
        console.log(`  Value: ${tx.value}`)
        console.log(`  Data: ${tx.data.substring(0, 66)}...`)
      })
    } else {
      console.log("\n❌ Request failed")
    }

  } catch (error) {
    console.error("\n❌ Error:", error instanceof Error ? error.message : String(error))
  }
}

// Test validation errors
async function testValidation() {
  console.log("\n=== Testing Validation ===\n")

  const invalidTests = [
    {
      name: "Missing required fields",
      body: {
        vaultAddress: "0x0000000000000000000000000000000000000001"
      }
    },
    {
      name: "Invalid chain ID",
      body: {
        vaultAddress: "0x0000000000000000000000000000000000000001",
        assetAddress: "0x0000000000000000000000000000000000000002",
        userAddress: "0x0000000000000000000000000000000000000003",
        amount: "100",
        chainId: 1, // Wrong chain
        decimals: 18
      }
    },
    {
      name: "Invalid amount",
      body: {
        vaultAddress: "0x0000000000000000000000000000000000000001",
        assetAddress: "0x0000000000000000000000000000000000000002",
        userAddress: "0x0000000000000000000000000000000000000003",
        amount: "-100", // Negative
        chainId: 747474,
        decimals: 18
      }
    },
    {
      name: "Invalid address format",
      body: {
        vaultAddress: "invalid_address",
        assetAddress: "0x0000000000000000000000000000000000000002",
        userAddress: "0x0000000000000000000000000000000000000003",
        amount: "100",
        chainId: 747474,
        decimals: 18
      }
    }
  ]

  for (const test of invalidTests) {
    console.log(`Testing: ${test.name}`)
    try {
      const response = await fetch(`${API_BASE_URL}/api/transaction/morpho/withdraw/prepare`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(test.body)
      })

      const data = await response.json()
      if (response.status === 400) {
        console.log(`  ✅ Correctly rejected: ${data.error}\n`)
      } else {
        console.log(`  ❌ Expected 400, got ${response.status}\n`)
      }
    } catch (error) {
      console.log(`  ❌ Error: ${error}\n`)
    }
  }
}

// Run tests
async function main() {
  console.log("Note: Make sure the server is running on", API_BASE_URL)
  console.log("Update the test addresses with real values for actual testing\n")

  await testValidation()
  await testMorphoWithdraw()
}

main()
