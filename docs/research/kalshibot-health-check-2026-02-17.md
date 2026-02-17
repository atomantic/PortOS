# Kalshibot Health Check Analysis — 2026-02-17

## Summary

**Status: DEGRADED** — 0% win rate across 3 trades, -$148.14 total loss on 2026-02-16. All 3 live trades settled at $0 (complete loss of cost basis). Shadow gamma-scalper posted +$46 on 1 trade (100% win rate). Current balance: $1,024.51.

---

## Trade-by-Trade Analysis

### Trade 1: Settlement Sniper — KXBTC-26FEB1611-B67375 (-$42.77)

- **Ticker**: B67375 bracket ($67,250-$67,500)
- **Side**: YES (betting BTC settles in this bracket)
- **Entry**: 200 contracts @ 21c ($42.77 + $1.69 fee) at 15:54 UTC
- **Settlement**: YES = $0 at 16:00 UTC (BTC was NOT in this bracket)
- **Loss**: -$42.77 (100% of cost basis, 4.2% of balance)

**Root cause**: The model estimated >33% fair probability for this bracket (21c + 12% edge). With 200 contracts (the configured max), Kelly sizing put $42 at risk on a single binary outcome. BTC settled outside this range, zeroing the position.

**Key issue**: `settlementRideThreshold: 0.40` may have prevented the 60s exit window from triggering. If the model still showed 40%+ edge at t-60s, the position rode to $0 instead of exiting with a partial loss.

### Trade 2: Coinbase Fair Value — KXBTC-26FEB1611-B67625 (-$52.79)

- **Ticker**: B67625 bracket ($67,500-$67,750)
- **Side**: NO (betting BTC does NOT settle in this bracket)
- **Entry**: 186 contracts @ 28c ($52.79 + $2.57 fee) at 15:56 UTC
- **Settlement**: NO = $0 at 16:00 UTC (BTC WAS in this bracket — NO bet lost)
- **Loss**: -$52.79 (100% of cost basis, 5.2% of balance)

**Root cause**: The strategy used a lowered `edgeThreshold: 0.20` (default is 0.25) and wider `maxSecondsToSettlement: 300` (default is 180). Entry at 3m35s before settlement with a 20% edge threshold allowed a signal that wouldn't have passed at the default 25% threshold. The NO side was wrong — BTC landed in this bracket.

**Position sizing note**: 186 contracts @ 28c = $52, exceeding the 3% `maxBetPct` of ~$30. The `calculatePositionSize` method may not be correctly capping by `maxBetPct`.

### Trade 3: Coinbase Fair Value — KXBTC-26FEB1612-B67625 (-$52.58)

- **Ticker**: B67625 bracket ($67,500-$67,750), next hour
- **Side**: YES (betting BTC settles in this bracket)
- **Entry**: 141 contracts across 3 fills @ 37-38c ($52.58 + $2.32 fee) at 16:56 UTC
- **Settlement**: YES = $0 at 17:00 UTC (BTC was NOT in this bracket)
- **Loss**: -$52.58 (100% of cost basis, 5.1% of balance)

**Root cause**: Same bracket, opposite side, next hour. BTC moved away from $67,500-$67,750 between 16:00 and 17:00. Higher entry price (37-38c) indicates greater model confidence, but the thesis was still wrong.

### Shadow Trade: Gamma Scalper — KXBTC-26FEB1612-B67875 (+$46.00)

- **Ticker**: B67875 bracket ($67,750-$68,000)
- **Side**: NO (betting BTC does NOT settle in this bracket)
- **Entry**: 50 contracts @ 8c ($4.00 + $0.26 fee) at 16:57 UTC
- **Settlement**: NO = $1.00 at 17:00 UTC ($50 proceeds, +$46 profit)
- **Edge reported**: 77.1%

**Why it outperformed**:
1. Tiny risk: $4 total cost vs $42-52 for live strategies
2. Asymmetric payoff: 8c entry for $1 payout = 12.5x return
3. Strong signal: 77.1% edge vs 12-20% threshold for live strategies
4. Correct thesis: BTC was not in the $67,750-$68,000 range

---

## Systemic Issues Identified

### 1. Position Sizing Too Aggressive for Binary Bracket Outcomes

All 3 live trades risked $42-52 each (4-5% of balance). Bracket markets settle at $0 or $1 — there's no partial recovery. Current `maxBetPct` settings (5% sniper, 3% fair-value) allow catastrophic per-trade losses.

### 2. Coinbase Fair Value Config Deviates from Safer Defaults

| Parameter | Current | Default | Risk Impact |
|-----------|---------|---------|-------------|
| `edgeThreshold` | 0.20 | 0.25 | Allows noisier signals |
| `maxSecondsToSettlement` | 300 | 180 | Enters too early, less certain |
| `exitEdgeThreshold` | 0.08 | 0.10 | Holds losing positions longer |
| `maxPositions` | 3 | 2 | More concurrent risk |

### 3. No Per-Window Exposure Cap

Trades 1 and 2 both targeted the 16:00 UTC settlement window. Combined exposure: $95 (9.3% of balance) on a single 15-minute interval. No mechanism caps aggregate risk per settlement window.

### 4. Settlement Ride Exception May Amplify Losses

The sniper's `settlementRideThreshold: 0.40` can override the forced exit at t-60s. In bracket markets where the probability model can be persistently wrong (model shows 40% edge but the bracket misses), this turns a possible small-loss exit into a guaranteed 100% loss.

### 5. Gamma-Scalper Live Execution Gap

Gamma-scalper is `enabled: true` in config but its shadow trade on B67875 suggests it didn't fire a live signal for the same market. Possible reasons:
- The fair-value strategy consumed the position slot first (both target the same settlement window)
- The B67875 bracket was only OTM-priced after the live strategies had already deployed capital
- No cross-strategy priority system exists to prefer smaller-risk trades

---

## Recommended Parameter Changes

### Immediate (config.json changes only)

```json
{
  "strategies": {
    "settlement-sniper": {
      "params": {
        "maxBetPct": 0.03,
        "maxContracts": 100,
        "settlementRideThreshold": 1.0
      }
    },
    "coinbase-fair-value": {
      "params": {
        "edgeThreshold": 0.25,
        "exitEdgeThreshold": 0.10,
        "maxSecondsToSettlement": 180,
        "maxPositions": 2
      }
    },
    "gamma-scalper": {
      "params": {
        "maxPositions": 3
      }
    }
  }
}
```

**Rationale per change**:

1. **sniper `maxBetPct` 0.05 -> 0.03**: Cap single-trade risk at 3%. Trade 1 would have risked ~$21 instead of $42.
2. **sniper `maxContracts` 200 -> 100**: Hard cap on position size. Combined with lower `maxBetPct`, prevents outsized bracket bets.
3. **sniper `settlementRideThreshold` 0.40 -> 1.0**: Effectively disables settlement riding. Forces positions to exit at t-60s instead of riding to $0. Can be re-enabled after more shadow testing validates the feature.
4. **fair-value `edgeThreshold` 0.20 -> 0.25**: Restore default. Requires 25% divergence before entry, filtering out Trade 2's 20% signal.
5. **fair-value `exitEdgeThreshold` 0.08 -> 0.10**: Exit sooner when thesis weakens.
6. **fair-value `maxSecondsToSettlement` 300 -> 180**: Restore default. Prevents entries at 3m+ before settlement where vol estimates are noisier.
7. **fair-value `maxPositions` 3 -> 2**: Reduce concurrent risk exposure.
8. **gamma-scalper `maxPositions` 2 -> 3**: Give the proven low-risk strategy more room to deploy.

### Code Changes Needed (Future)

1. **Per-window exposure cap**: In `simulation-engine.js`, add risk check capping total $ deployed per settlement window across all strategies (e.g., 5% of balance per window)
2. **Strategy priority by risk**: When multiple strategies signal for the same window, prefer lower cost-per-trade strategies (gamma-scalper $4 vs fair-value $50)
3. **Position size audit**: Verify `calculatePositionSize` in `base-strategy.js` correctly enforces `maxBetPct` — Trade 2's $52 cost exceeded the 3% cap of ~$30

---

## Impact Estimate

If these parameter changes had been active on 2026-02-16:
- **Trade 1**: ~$21 loss instead of $42 (maxContracts: 100, maxBetPct: 0.03)
- **Trade 2**: Likely filtered out (edgeThreshold 0.25 instead of 0.20)
- **Trade 3**: Would still have occurred (edge may have exceeded 0.25) but with lower maxPositions might have been blocked
- **Gamma-scalper**: More likely to fire live trades with maxPositions: 3
- **Estimated day**: -$21 to -$73 instead of -$148, potentially positive with gamma-scalper live trades
