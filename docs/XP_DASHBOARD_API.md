# XP Dashboard API Documentation

Quick guide for frontend integration of the XP dashboard endpoints.

## Endpoints

### 1. Full Dashboard Data

```
GET /user/xp/:walletAddress
```

**Use for**: Main XP dashboard page with weekly breakdown

**Example Request**:

```javascript
const response = await fetch(
  "/user/xp/0x1234567890abcdef1234567890abcdef12345678"
);
const data = await response.json();
```

**Response**:

```json
{
  "status": "success",
  "data": {
    "wallet_address": "0x1234...5678",
    "total_xp": 1250.5,
    "total_weeks": 2,
    "weekly_data": [
      {
        "week_start": "2025-12-13T00:00:00.000Z",
        "week_end": "2025-12-20T00:00:00.000Z",
        "league": "gold",
        "total_xp": 750.25,
        "swap_xp_raw": 800.0,
        "swap_xp_decayed": 725.25,
        "pair_bonus_xp": 25.0,
        "eligible_volume": 15000.5,
        "total_fees": 45.15,
        "unique_pairs_count": 5,
        "new_pairs_count": 1,
        "total_swaps": 42,
        "calculated_at": "2025-12-20T10:30:00.000Z"
      }
    ]
  }
}
```

---

### 2. Summary Only

```
GET /user/xp-summary/:walletAddress
```

**Use for**: Quick stats, navbar, or profile widgets

**Example Request**:

```javascript
const response = await fetch(
  "/user/xp-summary/0x1234567890abcdef1234567890abcdef12345678"
);
const data = await response.json();
```

**Response**:

```json
{
  "status": "success",
  "data": {
    "wallet_address": "0x1234...5678",
    "total_xp": 1250.5,
    "total_weeks": 2,
    "latest_week": {
      "week_start": "2025-12-13T00:00:00.000Z",
      "week_end": "2025-12-20T00:00:00.000Z",
      "total_xp": 750.25
    },
    "earliest_week": {
      "week_start": "2025-12-06T00:00:00.000Z",
      "week_end": "2025-12-13T00:00:00.000Z",
      "total_xp": 500.25
    }
  }
}
```

---

## Dashboard UI Components

### Header Section

Display prominent stats at the top:

```
┌─────────────────────────────────────────┐
│  Total XP: 1,250.5 XP                  │
│  Active Weeks: 2                        │
│  Current League: Gold                   │
└─────────────────────────────────────────┘
```

**Data to show**:

- `data.total_xp` - Total accumulated XP
- `data.total_weeks` - Number of active weeks
- `data.weekly_data[0].league` - Current league tier

---

### Weekly Breakdown Table/Cards

Show each week's performance with key metrics:

```
┌────────────────────────────────────────────────────────┐
│  Week: Dec 13 - Dec 20                     🏆 Gold     │
├────────────────────────────────────────────────────────┤
│  Total XP: 750.25 XP                                   │
│  • Swap XP (after decay): 725.25                       │
│  • Pair Bonus: +25.00                                  │
│                                                         │
│  📊 Activity:                                          │
│  • Volume: $15,000.50                                  │
│  • Fees Paid: $45.15                                   │
│  • Total Swaps: 42                                     │
│  • Unique Pairs: 5 (1 new)                             │
└────────────────────────────────────────────────────────┘
```

**For each week in `weekly_data`, display**:

**Week Header**:

- `week_start` to `week_end` (format dates nicely)
- `league` badge (bronze/silver/gold/diamond with color coding)

**XP Breakdown**:

- `total_xp` - Main XP for the week (large, prominent)
- `swap_xp_decayed` - XP from swaps
- `pair_bonus_xp` - Bonus XP from trading pairs

**Activity Stats**:

- `eligible_volume` - Format as currency ($15,000.50)
- `total_fees` - Format as currency ($45.15)
- `total_swaps` - Number of swaps
- `unique_pairs_count` - Total unique pairs traded
- `new_pairs_count` - First-time pairs (show as badge/highlight)

---

## League Tier Colors

```javascript
const leagueColors = {
  bronze: "#CD7F32",
  silver: "#C0C0C0",
  gold: "#FFD700",
  diamond: "#B9F2FF",
};
```

---

## Error Handling

**404 - No XP Data**:

```json
{
  "status": "error",
  "msg": "No XP data found for this wallet address"
}
```

Show message: "No XP earned yet. Start trading to earn XP!"

**400 - Invalid Address**:

```json
{
  "status": "error",
  "msg": "Invalid wallet address"
}
```

Show message: "Please connect a valid wallet"

---

## Performance Tips

1. **Use summary endpoint** for quick displays (navbar, profile cards)
2. **Use full dashboard endpoint** only on the dedicated XP dashboard page
3. **Cache data** - XP is calculated weekly, safe to cache for 1-5 minutes
4. **Sort by week_start DESC** - Data comes pre-sorted (newest first)

---

## Example React Component

```jsx
import { useState, useEffect } from "react";

function XpDashboard({ walletAddress }) {
  const [xpData, setXpData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchXP() {
      try {
        const res = await fetch(`/user/xp/${walletAddress}`);
        const data = await res.json();

        if (data.status === "success") {
          setXpData(data.data);
        }
      } catch (error) {
        console.error("Failed to fetch XP:", error);
      } finally {
        setLoading(false);
      }
    }

    if (walletAddress) {
      fetchXP();
    }
  }, [walletAddress]);

  if (loading) return <div>Loading XP data...</div>;
  if (!xpData) return <div>No XP data found</div>;

  return (
    <div className="xp-dashboard">
      {/* Header */}
      <div className="xp-header">
        <h1>Total XP: {xpData.total_xp.toFixed(2)}</h1>
        <p>Active for {xpData.total_weeks} weeks</p>
      </div>

      {/* Weekly Breakdown */}
      <div className="weekly-grid">
        {xpData.weekly_data.map((week, i) => (
          <div key={i} className={`week-card ${week.league}`}>
            <div className="week-header">
              <span>{new Date(week.week_start).toLocaleDateString()}</span>
              <span className="league-badge">{week.league}</span>
            </div>

            <div className="xp-total">{week.total_xp.toFixed(2)} XP</div>

            <div className="xp-breakdown">
              <p>Swap XP: {week.swap_xp_decayed.toFixed(2)}</p>
              <p>Pair Bonus: +{week.pair_bonus_xp.toFixed(2)}</p>
            </div>

            <div className="stats">
              <p>Volume: ${week.eligible_volume.toLocaleString()}</p>
              <p>Swaps: {week.total_swaps}</p>
              <p>
                Pairs: {week.unique_pairs_count}
                {week.new_pairs_count > 0 && (
                  <span className="new-badge">+{week.new_pairs_count} new</span>
                )}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## Visual Hierarchy Priority

**Most Important** (largest/prominent):

1. `total_xp` (overall)
2. `total_xp` (per week)
3. `league` badge

**Secondary**: 4. `swap_xp_decayed` and `pair_bonus_xp` 5. `eligible_volume`

**Tertiary** (smaller text): 6. `total_swaps`, `unique_pairs_count`, `total_fees` 7. `week_start/week_end` dates

---

## Quick Reference

| Field                    | Description                       | Display Format   |
| ------------------------ | --------------------------------- | ---------------- |
| `total_xp`               | Overall XP                        | `1,250.5 XP`     |
| `weekly_data[].total_xp` | Week's total XP                   | `750.25 XP`      |
| `league`                 | Tier (bronze/silver/gold/diamond) | Badge with color |
| `eligible_volume`        | Trading volume                    | `$15,000.50`     |
| `total_fees`             | Fees paid                         | `$45.15`         |
| `total_swaps`            | Number of swaps                   | `42 swaps`       |
| `unique_pairs_count`     | Unique pairs traded               | `5 pairs`        |
| `new_pairs_count`        | New pairs this week               | `+1 new` badge   |
| `swap_xp_raw`            | XP before decay                   | Reference only   |
| `swap_xp_decayed`        | XP after decay                    | Display value    |
| `pair_bonus_xp`          | Bonus from pairs                  | `+25.00`         |
