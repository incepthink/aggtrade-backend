# XP Distribution Testing Guide

This directory contains the XP distribution system and test data based on the specification examples.

## Quick Start

### 1. Seed Test Data

```bash
# Run the seeding script
bun run src/cron-jobs/xp-distribution/seedTestData.ts
```

The seeder will:
- Clean up any existing test data for user ID 11
- Insert sample swap data based on your selected example
- Display a summary of the inserted data

### 2. Run XP Distribution Job

```bash
# Run the XP distribution calculation
bun run src/cron-jobs/xp-distribution/index.ts
```

## Test Examples

The test data implements three examples from the XP distribution specification:

### Example A1: Small Swapper — Bronze League

**Setup:**
- 1 swap of $2,000 with 0.30% fee pool
- Total fees: $6.00
- Single WETH-USDC pair

**Expected Calculation:**
```
Raw XP = min(0.5 × $2,000, 200 × $6)
       = min(1,000, 1,200)
       = 1,000 XP

Bronze bands (per-pair):
  $0-5k @ 100% = $2,000 × 100% = $2,000 weighted
  Decay fraction = $2,000 / $2,000 = 1.0

Decayed XP = 1,000 × 1.0 = 1,000 XP

UPB = 25 XP (first time on this pair)

TOTAL XP = 1,025
```

### Example A2: Medium Swapper — Silver League

**Setup:**
- 3 swaps totaling $20,000 with 0.05% fee pool
- Total fees: $10.00
- Single WETH-USDC pair
- Swaps spaced across different 15-min windows

**Expected Calculation:**
```
Raw XP = min(0.5 × $20,000, 200 × $10)
       = min(10,000, 2,000)
       = 2,000 XP (limited by fees ceiling)

Silver bands (per-pair):
  $0-5k @ 100% = $5,000 weighted
  $5k-20k (15k) @ 70% = $10,500 weighted
  Total weighted EV = $15,500
  Decay fraction = $15,500 / $20,000 = 0.775

Decayed XP = 2,000 × 0.775 = 1,550 XP

UPB = 25 XP (first time on this pair)

TOTAL XP = 1,575
```

### Example A3: High-Volume Specialist — Diamond League

**Setup:**
- 3 swaps totaling $150,000 with 0.05% fee pool
- Total fees: $75.00
- Single WETH-USDC pair
- Swaps spaced across different 15-min windows

**Expected Calculation:**
```
Raw XP = min(0.5 × $150,000, 200 × $75)
       = min(75,000, 15,000)
       = 15,000 XP (limited by fees ceiling)

Diamond bands (per-pair):
  $0-5k @ 100% = $5,000 weighted
  $5k-25k (20k) @ 90% = $18,000 weighted
  $25k-125k (100k) @ 70% = $70,000 weighted
  $125k-150k (25k) @ 25% = $6,250 weighted
  Total weighted EV = $99,250
  Decay fraction = $99,250 / $150,000 = 0.6617

Decayed XP = 15,000 × 0.6617 = 9,925.5 XP

UPB = 25 XP (first time on this pair)

TOTAL XP = 9,950 (approximately)
```

## Customizing Test Data

To test different scenarios, edit `seedTestData.ts`:

```typescript
// Choose which example to seed
async function main() {
  // Option 1: Bronze league
  await seedExampleA1()

  // Option 2: Silver league
  // await seedExampleA2()

  // Option 3: Diamond league
  // await seedExampleA3()

  // Option 4: All examples (tests highest volume)
  // await seedExampleA1()
  // await seedExampleA2()
  // await seedExampleA3()
}
```

## Understanding the Filters

The XP calculation applies multiple filters to identify legitimate trading volume:

### 1. Minimum Fill Size ($10 USD)
Removes dust trades that don't represent meaningful activity.

### 2. Minimum Price Impact (1bp = 0.0001)
Filters out potential wash trading or self-matching with very low impact.

### 3. Round-Trip Detection (5-minute window)
Identifies A→B then B→A reversals and excludes the smaller leg.

### 4. Directional Netting (15-minute window)
Groups swaps by wallet/pair/window and calculates net buy - sell volume.

### 5. Band Decay (per-pair)
Applies league-specific multipliers to volume bands:

| League  | $0-5k | $5k-25k | $25k-125k | $125k+ |
|---------|-------|---------|-----------|--------|
| Bronze  | 100%  | 60%     | 30%       | 10%    |
| Silver  | 100%  | 70%     | 45%       | 15%    |
| Gold    | 100%  | 80%     | 60%       | 20%    |
| Diamond | 100%  | 90%     | 70%       | 25%    |

### 6. Unique Pair Bonus
+25 XP per new pair (max 4 pairs = 100 XP/week)

## Test Data Design

All test swaps are designed to:
- ✅ Pass minimum fill size ($10+)
- ✅ Pass minimum impact (≥ 1bp)
- ✅ Avoid round-trip detection (spaced > 5 minutes apart)
- ✅ Avoid directional netting issues (all BUYs in same direction)
- ✅ Have realistic price impact and fee percentages

## Verification

After running the XP distribution job, verify:

1. **Eligible Volume Calculation**
   - Check that all swaps pass filters
   - Verify per-pair volumes match expected totals

2. **League Determination**
   - Bronze: < $5k
   - Silver: $5k - $25k
   - Gold: $25k - $125k
   - Diamond: ≥ $125k

3. **Band Decay Application**
   - Verify weighted EV calculation
   - Check decay fraction matches expected value

4. **Unique Pair Bonus**
   - Confirm new pairs are detected
   - Verify +25 XP per pair (capped at 4)

5. **Final XP Total**
   - Compare with expected totals above

## Troubleshooting

### Issue: No swaps found
**Solution:** Check that the week range in `getCurrentWeekRange()` includes the test swap timestamps (2025-12-09).

### Issue: Wrong league assigned
**Solution:** Verify total eligible volume across all pairs matches expected values after filters.

### Issue: XP doesn't match expected
**Solution:**
1. Check that fees_usd is set correctly
2. Verify fee ceiling is limiting XP (common in examples A2 and A3)
3. Confirm band decay fractions are calculated correctly

### Issue: Round-trip detection triggered
**Solution:** Ensure swaps are spaced > 5 minutes apart and don't reverse token directions within that window.

### Issue: Directional netting reducing volume
**Solution:** Keep all swaps in the same direction (all BUYs or all SELLs) within each 15-minute window.
