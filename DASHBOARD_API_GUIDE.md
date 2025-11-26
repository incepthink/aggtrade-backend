# SushiSwap Dashboard API - Frontend Guide

## Base URL
```
/tracking/sushiswap/dashboard
```

---

## 1. Main Dashboard Data
**GET** `/tracking/sushiswap/dashboard`

### Query Params
| Param | Type | Description |
|-------|------|-------------|
| `swap_type` | `CLASSIC` \| `LIMIT_ORDER` | Filter by swap type (optional) |
| `wallet_address` | string | Filter by wallet |
| `start_date` | ISO date | Date range start |
| `end_date` | ISO date | Date range end |
| `token_address` | string | Filter swaps with this token |
| `status` | string | Default: `success` |
| `sort_by` | string | Default: `timestamp` |
| `sort_order` | `ASC` \| `DESC` | Default: `DESC` |
| `limit` | number | Default: 50 |
| `offset` | number | Default: 0 |

### Response
```json
{
  "swaps": [...],
  "statistics": {
    "total_swaps": 1250,
    "total_volume_usd": 45000.50,
    "classic_swaps": 800,
    "classic_volume_usd": 30000.25,
    "limit_order_swaps": 450,
    "limit_order_volume_usd": 15000.25,
    "unique_wallets": 120
  },
  "pagination": { "limit": 50, "offset": 0, "returned": 50 }
}
```

### Examples
```js
// All swaps (both types)
GET /tracking/sushiswap/dashboard

// Only classic swaps
GET /tracking/sushiswap/dashboard?swap_type=CLASSIC

// Only limit orders
GET /tracking/sushiswap/dashboard?swap_type=LIMIT_ORDER

// Specific wallet
GET /tracking/sushiswap/dashboard?wallet_address=0xabc...

// Date range
GET /tracking/sushiswap/dashboard?start_date=2025-01-01&end_date=2025-01-31

// Pagination
GET /tracking/sushiswap/dashboard?limit=100&offset=0
```

---

## 2. Volume Over Time (Charts)
**GET** `/tracking/sushiswap/dashboard/volume-over-time`

### Query Params
| Param | Required | Description |
|-------|----------|-------------|
| `interval` | No | `hour` \| `day` \| `week` (default: `day`) |
| `swap_type` | No | Filter by type |
| `wallet_address` | No | Filter by wallet |
| `start_date` | No | Date range |
| `end_date` | No | Date range |

### Response
```json
{
  "interval": "day",
  "data": [
    { "period": "2025-01-15", "volume": 12500.50, "swap_count": 45 },
    { "period": "2025-01-16", "volume": 15300.75, "swap_count": 52 }
  ]
}
```

### Example
```js
// Daily volume for last 30 days
GET /tracking/sushiswap/dashboard/volume-over-time?interval=day&start_date=2025-01-01&end_date=2025-01-31
```

---

## 3. Top Tokens
**GET** `/tracking/sushiswap/dashboard/top-tokens`

### Query Params
| Param | Description |
|-------|-------------|
| `swap_type` | Filter by swap type |
| `start_date` | Date range |
| `end_date` | Date range |
| `limit` | Default: 10 |

### Response
```json
{
  "tokens": [
    {
      "address": "0x...",
      "symbol": "WETH",
      "volume": 125000.50,
      "swap_count": 450
    }
  ]
}
```

---

## 4. Top Wallets (Leaderboard)
**GET** `/tracking/sushiswap/dashboard/top-wallets`

### Query Params
Same as top-tokens

### Response
```json
{
  "wallets": [
    {
      "wallet_address": "0x...",
      "total_volume": 50000.25,
      "swap_count": 125,
      "classic_count": 80,
      "limit_order_count": 45
    }
  ]
}
```

---

## Quick Frontend Integration

### React Example
```jsx
const Dashboard = () => {
  const [data, setData] = useState(null)
  const [filter, setFilter] = useState('ALL') // ALL, CLASSIC, LIMIT_ORDER

  useEffect(() => {
    const params = new URLSearchParams()
    if (filter !== 'ALL') params.append('swap_type', filter)
    params.append('limit', '100')

    fetch(`/tracking/sushiswap/dashboard?${params}`)
      .then(r => r.json())
      .then(setData)
  }, [filter])

  return (
    <div>
      <button onClick={() => setFilter('ALL')}>All Swaps</button>
      <button onClick={() => setFilter('CLASSIC')}>Classic Only</button>
      <button onClick={() => setFilter('LIMIT_ORDER')}>Limit Orders</button>

      <Stats data={data?.statistics} />
      <SwapTable swaps={data?.swaps} />
    </div>
  )
}
```

---

## Common Use Cases

**Show all activity:**
```
GET /tracking/sushiswap/dashboard
```

**Classic swaps only:**
```
GET /tracking/sushiswap/dashboard?swap_type=CLASSIC
```

**User's limit orders:**
```
GET /tracking/sushiswap/dashboard?wallet_address=0x...&swap_type=LIMIT_ORDER
```

**Volume chart (7 days):**
```
GET /tracking/sushiswap/dashboard/volume-over-time?start_date=2025-01-20&end_date=2025-01-26
```

**Top 20 traders:**
```
GET /tracking/sushiswap/dashboard/top-wallets?limit=20
```
