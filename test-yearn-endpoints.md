# Yearn Finance Endpoints - Test Guide

## Endpoints Implemented

### 1. Deposit Prepare
**POST** `/transaction/yearn/deposit/prepare`

Prepares deposit transaction for Yearn vault. Checks if approval is needed and returns transaction data.

### 2. Withdraw Prepare
**POST** `/transaction/yearn/withdraw/prepare`

Prepares withdraw (redeem) transaction from Yearn vault.

---

## Test Examples

### Example 1: Deposit Preparation (With Approval Check)

```bash
curl -X POST http://localhost:5000/transaction/yearn/deposit/prepare \
  -H "Content-Type: application/json" \
  -d '{
    "vaultAddress": "0x1234567890123456789012345678901234567890",
    "tokenAddress": "0x0987654321098765432109876543210987654321",
    "amount": "100.5",
    "decimals": 18,
    "receiverAddress": "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
    "userAddress": "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
    "chainId": 747474
  }'
```

**Expected Response (if approval needed):**
```json
{
  "message": "Deposit transaction prepared",
  "data": {
    "approval": {
      "to": "0x0987654321098765432109876543210987654321",
      "data": "0x095ea7b3...",
      "value": "0"
    },
    "deposit": {
      "to": "0x1234567890123456789012345678901234567890",
      "data": "0x6e553f65...",
      "value": "0"
    }
  }
}
```

**Expected Response (if approval NOT needed):**
```json
{
  "message": "Deposit transaction prepared",
  "data": {
    "deposit": {
      "to": "0x1234567890123456789012345678901234567890",
      "data": "0x6e553f65...",
      "value": "0"
    }
  }
}
```

---

### Example 2: Withdraw Preparation

```bash
curl -X POST http://localhost:5000/transaction/yearn/withdraw/prepare \
  -H "Content-Type: application/json" \
  -d '{
    "vaultAddress": "0x1234567890123456789012345678901234567890",
    "shares": "50.25",
    "decimals": 18,
    "receiverAddress": "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
    "ownerAddress": "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
    "maxLoss": "1",
    "chainId": 747474
  }'
```

**Expected Response:**
```json
{
  "message": "Withdraw transaction prepared",
  "data": {
    "to": "0x1234567890123456789012345678901234567890",
    "data": "0xba087652...",
    "value": "0"
  }
}
```

---

## Error Cases to Test

### Missing Required Fields

```bash
curl -X POST http://localhost:5000/transaction/yearn/deposit/prepare \
  -H "Content-Type: application/json" \
  -d '{
    "vaultAddress": "0x1234567890123456789012345678901234567890",
    "amount": "100"
  }'
```

**Expected Response:**
```json
{
  "message": "Failed to prepare deposit transaction",
  "error": "Missing required fields: vaultAddress, tokenAddress, amount, decimals, receiverAddress, userAddress, chainId"
}
```

### Invalid Amount (Zero)

```bash
curl -X POST http://localhost:5000/transaction/yearn/deposit/prepare \
  -H "Content-Type: application/json" \
  -d '{
    "vaultAddress": "0x1234567890123456789012345678901234567890",
    "tokenAddress": "0x0987654321098765432109876543210987654321",
    "amount": "0",
    "decimals": 18,
    "receiverAddress": "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
    "userAddress": "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
    "chainId": 747474
  }'
```

**Expected Response:**
```json
{
  "message": "Failed to prepare deposit transaction",
  "error": "Amount must be greater than 0"
}
```

### Invalid Address Format

```bash
curl -X POST http://localhost:5000/transaction/yearn/deposit/prepare \
  -H "Content-Type: application/json" \
  -d '{
    "vaultAddress": "invalid_address",
    "tokenAddress": "0x0987654321098765432109876543210987654321",
    "amount": "100",
    "decimals": 18,
    "receiverAddress": "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
    "userAddress": "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
    "chainId": 747474
  }'
```

**Expected Response:**
```json
{
  "message": "Failed to prepare deposit transaction",
  "error": "Invalid vault address format"
}
```

---

## Implementation Details

### Files Created/Modified

1. **src/abi/yearn.ts** - ABIs for ERC20 and Yearn V3 Vault
2. **src/types/transaction.ts** - Type definitions for Yearn requests/responses
3. **src/controllers/transaction/yearn/index.ts** - Controller with deposit/withdraw logic
4. **src/routes/transaction.ts** - Route registration

### Key Features

- ✅ Automatic approval check for deposits
- ✅ Encodes approval transaction only when needed
- ✅ Encodes deposit transaction using Yearn V3 vault ABI
- ✅ Encodes redeem transaction for withdrawals
- ✅ Full validation of addresses, amounts, and decimals
- ✅ Proper error handling with descriptive messages
- ✅ Uses viem for encoding and blockchain interaction
- ✅ Supports Katana (Ronin) chain (chainId: 747474)

### Flow Diagram

**Deposit Flow:**
```
Frontend → POST /transaction/yearn/deposit/prepare
          → Backend checks allowance via RPC
          → If allowance < amount:
              - Returns both approval + deposit transactions
          → Else:
              - Returns only deposit transaction
          → Frontend signs approval (if needed) → Signs deposit
```

**Withdraw Flow:**
```
Frontend → POST /transaction/yearn/withdraw/prepare
          → Backend encodes redeem transaction
          → Returns transaction data
          → Frontend signs transaction (no approval needed)
```