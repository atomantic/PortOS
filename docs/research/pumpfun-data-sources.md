# Pump.fun Launch Tracking Engine: Data Source Evaluation

**Brain Project**: 467fbe07 — Pump.fun Launch Tracking Engine
**Date**: 2026-02-16
**Deadline**: 2026-02-20
**Objective**: Evaluate Helius, Birdeye, and pump.fun APIs for rate limits, auth, and schemas

---

## Executive Summary

Three primary data source categories were evaluated for the Pump.fun Launch Tracking Engine:

1. **Helius** — Solana-native RPC/infrastructure with Enhanced APIs, webhooks, and gRPC streaming
2. **Birdeye** — DeFi analytics platform with rich token/price/trade REST APIs
3. **pump.fun Direct + Third-Party Indexers** — pump.fun's own frontend APIs plus Bitquery/bloXroute GraphQL indexers

**Recommendation**: Use Helius (Developer tier, $49/mo) as the primary real-time data source for new token detection and transaction monitoring. Supplement with Birdeye (Starter tier, $99/mo) for enriched token analytics, price history, and holder data. Use pump.fun direct APIs sparingly for metadata not available elsewhere.

---

## 1. Helius

### Overview
Solana-native RPC and API platform. Best-in-class for raw blockchain data, real-time streaming, and transaction parsing on Solana.

### Authentication
- API key appended as query parameter: `?api-key=YOUR_KEY`
- Keys managed via [Helius Dashboard](https://dashboard.helius.dev)
- SDK available: `@helius-labs/helius-sdk` (npm)

### Pricing & Rate Limits

| Plan | Cost/mo | Credits/mo | RPC RPS | DAS API RPS | Enhanced API RPS | WebSockets |
|------|---------|-----------|---------|-------------|-----------------|------------|
| Free | $0 | 1M | 10 | 2 | 2 | Standard only |
| Developer | $49 | 10M | 50 | 10 | 10 | Standard only |
| Business | $499 | 100M | 200 | 50 | 50 | Enhanced |
| Professional | $999 | 200M | 500 | 100 | 100 | Enhanced + LaserStream |

### Key APIs for Pump.fun Tracking

**Enhanced Transactions API**
- `POST https://api-mainnet.helius-rpc.com/v0/transactions?api-key=KEY` — parse up to 100 signatures per request
- `GET https://api-mainnet.helius-rpc.com/v0/addresses/{address}/transactions?api-key=KEY` — address history with pagination
- Parses raw Solana transactions into human-readable format
- Decodes instruction data, token transfers, balance changes
- Response includes: `description`, `type`, `source`, `fee`, `feePayer`, `signature`, `slot`, `timestamp`, `nativeTransfers`, `tokenTransfers`, `accountData`, `events`
- Filter by pump.fun program ID: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- Commitment levels: `finalized` (default) or `confirmed`
- Error responses: 400 (bad request), 401 (auth), 429 (rate limit), 500/503/504 (server)

**Webhooks**
- Push-based event delivery for on-chain events
- Configurable filters: `TOKEN_MINT`, account-specific, program-specific
- Can monitor pump.fun program for new token creates and trades
- Eliminates polling — server receives events as they happen

**gRPC Streaming (LaserStream)**
- Real-time account and transaction streams
- Filter by program owner for pump.fun bonding curve accounts
- Commitment level: `CONFIRMED`
- Tracks: operation type, user/fee payer, signatures, timestamps, balance changes
- **Note**: Professional plan only for mainnet gRPC

**DAS (Digital Asset Standard) API**
- Token metadata, ownership, and collection queries
- Useful for enriching token data post-detection

### Response Schema (Enhanced Transaction)
```json
{
  "description": "string",
  "type": "SWAP|TOKEN_MINT|TRANSFER|...",
  "source": "PUMP_FUN|RAYDIUM|...",
  "fee": 5000,
  "feePayer": "pubkey",
  "signature": "txid",
  "timestamp": 1700000000,
  "nativeTransfers": [{ "fromUserAccount": "...", "toUserAccount": "...", "amount": 1000000 }],
  "tokenTransfers": [{ "fromTokenAccount": "...", "toTokenAccount": "...", "tokenAmount": 1000, "mint": "..." }],
  "accountData": [{ "account": "...", "nativeBalanceChange": -5000, "tokenBalanceChanges": [...] }]
}
```

### Strengths
- Lowest latency for new token detection (webhooks + gRPC)
- Native pump.fun program filtering
- Enhanced transaction parsing reduces client-side logic
- Staked connections on all paid plans for high tx success
- Well-documented SDK

### Limitations
- gRPC/LaserStream requires Professional ($999/mo) for mainnet
- Enhanced WebSocket metering (3 credits/0.1MB) for new users
- Raw blockchain data — no pre-built analytics (no OHLCV, no market cap aggregation)

---

## 2. Birdeye

### Overview
DeFi analytics platform with comprehensive REST APIs for token data, pricing, trades, OHLCV, and wallet analytics. Covers Solana and 30+ other chains.

### Authentication
- API key via header: `X-API-KEY: YOUR_KEY`
- Keys managed via [Birdeye Dashboard](https://bds.birdeye.so)
- Optional `chain` parameter defaults to Solana

### Pricing & Rate Limits

| Plan | Cost/mo | Compute Units | Global RPS | WebSockets |
|------|---------|--------------|-----------|------------|
| Standard (Free) | $0 | 30K | 1 | No |
| Lite | $39 | 1.5M | 15 | No |
| Starter | $99 | 5M | 15 | No |
| Premium | $199 | 15M | 50 | No |
| Premium Plus | $250 | 20M | 50 | 500 conns |
| Business (B-05) | $499 | 50M | 100 | 2000 conns |
| Business | $699 | 100M | 100 | Yes |

**Per-Endpoint Rate Limits** (within global account limit):

| Endpoint | Path | Max RPS |
|----------|------|---------|
| Price (single) | `/defi/price` | 300 |
| Price (multi) | `/defi/multi_price` | 300 |
| Price (historical) | `/defi/history_price` | 100 |
| Token Overview | `/defi/token_overview` | 300 |
| Token Security | `/defi/token_security` | 150 |
| Token List v3 | `/defi/v3/token/list` | 100 |
| Trades (token) | `/defi/txs/token` | 100 |
| Trades (pair) | `/defi/txs/pair` | 100 |
| OHLCV | `/defi/ohlcv` | 100 |
| Wallet Portfolio | varies | 30 rpm |

### Key APIs for Pump.fun Tracking

**Token Overview** (`/defi/token_overview`)
- Market cap, liquidity, volume, price change, holder count
- Single call returns comprehensive token analytics

**Token Security** (`/defi/token_security`)
- Rug-pull risk indicators, mint authority, freeze authority
- Critical for filtering high-risk launches

**Price APIs** (`/defi/price`, `/defi/history_price`)
- Real-time and historical pricing in SOL/USD
- Multi-token batch pricing supported

**Trade APIs** (`/defi/txs/token`)
- Recent trades with buy/sell side, amounts, timestamps
- Pair-level trade history

**OHLCV** (`/defi/ohlcv`)
- Candlestick data at configurable intervals
- Useful for charting and trend detection

**Token List** (`/defi/v3/token/list`)
- Sortable by volume, market cap, price change
- Filter by timeframe for trending tokens

### Response Schema (Token Overview)
```json
{
  "address": "mint_address",
  "name": "Token Name",
  "symbol": "TKN",
  "decimals": 9,
  "price": 0.00123,
  "priceChange24hPercent": 150.5,
  "volume24h": 500000,
  "marketCap": 1200000,
  "liquidity": 50000,
  "holder": 2500,
  "supply": 1000000000,
  "logoURI": "https://...",
  "extensions": { "website": "...", "twitter": "..." }
}
```

### Response Schema (Price API — `GET /defi/price?address=MINT`)
```json
{
  "success": true,
  "data": {
    "value": 0.38622,
    "updateUnixTime": 1745058945,
    "updateHumanTime": "2025-04-19T10:35:45",
    "priceChange24h": 1.93,
    "priceInNative": 0.00277,
    "liquidity": 10854103.37
  }
}
```

### Strengths
- Richest analytics out of the box (market cap, liquidity, security scores)
- Pre-computed OHLCV eliminates aggregation logic
- Token security endpoint critical for filtering scams
- Batch pricing for monitoring multiple tokens
- Clean REST API, easy to integrate

### WebSocket: New Token Listing Stream

Available on Premium Plus ($250/mo) and above. Directly relevant for pump.fun launch detection.

- **URL**: `wss://public-api.birdeye.so/socket/solana?x-api-key=YOUR_KEY`
- **Headers**: `Origin: ws://public-api.birdeye.so`, `Sec-WebSocket-Protocol: echo-protocol`
- **Subscribe**: `{ "type": "SUBSCRIBE_TOKEN_NEW_LISTING", "meme_platform_enabled": true, "sources": ["pump_dot_fun"] }`
- **CU cost**: 0.08 CU per byte

Response schema:
```json
{
  "type": "TOKEN_NEW_LISTING_DATA",
  "data": {
    "address": "BkQfwVktcbWmxePJN5weHWJZgReWbiz8gzTdFa2w7Uds",
    "decimals": 6,
    "name": "Worker Cat",
    "symbol": "$MCDCAT",
    "liquidity": "12120.155172280874",
    "liquidityAddedAt": 1720155863
  }
}
```

Supports `min_liquidity`/`max_liquidity` filters and 100+ DEX source filters including Raydium, Orca, Meteora, and pump.fun.

### Compute Unit Costs (Key Endpoints)

| Endpoint | CU Cost | Notes |
|----------|---------|-------|
| Token Price | 10 | Cheapest price check |
| Token Metadata | 5 | Very low cost |
| Token List v3 | 100 | Higher cost for list queries |
| Trades (token) | 10 | Affordable for trade monitoring |
| OHLCV | 40 | Moderate |
| Token New Listing (REST) | 80 | One-shot listing check |
| WS: New Listing | 0.08/byte | Streaming cost scales with data |
| WS: Price | 0.003/byte | Very affordable streaming |
| WS: Transactions | 0.0004/byte | Cheapest stream |

### Limitations
- No push-based event delivery on tiers below Premium Plus (polling only)
- WebSocket access requires Premium Plus ($250/mo) minimum
- New token detection via REST has inherent latency — tokens must be indexed first
- Wallet endpoints severely rate-limited (30 rpm)
- Compute unit costs can escalate with heavy usage
- CU costs subject to change without notice

---

## 3. pump.fun Direct APIs + Third-Party Indexers

### 3a. pump.fun Frontend API (Direct)

### Overview
pump.fun exposes several undocumented/semi-official API services. These are reverse-engineered from the frontend and may change without notice.

### Base URLs

| Service | URL | Purpose |
|---------|-----|---------|
| Frontend API v3 | `https://frontend-api-v3.pump.fun` | Token data, listings |
| Advanced Analytics v2 | `https://advanced-api-v2.pump.fun` | Analytics, rankings |
| Market API | `https://market-api.pump.fun` | Market data |
| Profile API | `https://profile-api.pump.fun` | User profiles |
| Swap API | `https://swap-api.pump.fun` | Token swaps |
| Volatility API v2 | `https://volatility-api-v2.pump.fun` | Volatility metrics |

### Authentication
- JWT Bearer token: `Authorization: Bearer <JWT>`
- Required headers: `Origin: https://pump.fun`, `Accept: application/json`
- Rate limit headers in responses: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`

### Key Capabilities
- **483 documented endpoints** across all API versions
- Token creation details, bonding curve status, graduation tracking
- Direct access to pump.fun-specific metadata not available elsewhere
- Creator profiles and reputation data

### Key V3 Endpoints
- `GET /coins/latest` — latest token launches
- `GET /coins/{mint}` — token details by mint address
- `GET /trades/latest` — latest trades across all tokens
- `GET /trades/token/{mint}` — trades for specific token

### Observed Rate Limits
- ~20 requests per minute (RPM) across all endpoints
- Rate limit headers in responses: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`
- HTTP 429 on exceeded limits
- Recommended: exponential backoff with max 3 retries

### Limitations
- **Undocumented/unofficial** — endpoints can break without warning
- JWT auth requires mimicking browser authentication flow
- Rate limits are restrictive (~20 RPM) and undocumented officially
- No SLA or support
- Legal gray area for automated access
- WebSocket support listed as "coming soon" — not yet available

---

### 3b. Bitquery (GraphQL Indexer)

### Overview
Third-party GraphQL indexer with dedicated pump.fun query support. Real-time subscriptions for new tokens, trades, and bonding curve events.

### Authentication
- API key via header or query parameter
- Free tier available via [Bitquery IDE](https://ide.bitquery.io)

### Pricing

| Plan | Cost | Points | RPS | Streams |
|------|------|--------|-----|---------|
| Developer (Free) | $0 | 1,000 | 10 req/min | 2 |
| Commercial | Custom | Custom | Custom | Custom |

### Key APIs for Pump.fun Tracking
- **Token creation subscriptions** — real-time stream of new pump.fun launches
- **Trade subscriptions** — buy/sell with amounts and prices
- **Bonding curve status** — track graduation progress
- **ATH market cap** — all-time high calculations
- **Top traders/holders** — wallet analytics
- **Creator reputation** — all tokens by a creator address

### GraphQL Query Example (New Token Subscription)
```graphql
subscription {
  Solana {
    Instructions(
      where: {
        Instruction: {
          Program: {
            Address: { is: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" }
          }
        }
        Transaction: { Result: { Success: true } }
      }
    ) {
      Transaction { Signature }
      Instruction {
        Accounts { Address Token { Mint Owner } }
        Program { Method }
      }
      Block { Time }
    }
  }
}
```

### Limitations
- Free tier extremely limited (1,000 points, 10 req/min, 2 streams)
- Commercial pricing requires sales contact — no self-serve
- Points-based billing is opaque — hard to predict costs
- GraphQL complexity can lead to unexpected point consumption

---

### 3c. bloXroute (Streaming)

### Overview
Specializes in low-latency Solana data streaming with dedicated pump.fun channels.

### Key Endpoints
- `GetPumpFunNewTokensStream` — real-time new token events
- `GetPumpFunSwapsStream` — real-time swap monitoring
- `GetPumpFunAMMSwapsStream` — AMM swap events post-graduation

### Limitations
- Pricing not publicly documented
- Primarily targets high-frequency trading use cases
- Overkill for analytics/tracking use case

---

## Comparison Matrix

| Criteria | Helius | Birdeye | pump.fun Direct | Bitquery |
|----------|--------|---------|-----------------|----------|
| **New token detection latency** | ~1s (webhook/gRPC) | 5-30s (REST) / ~2s (WS) | Unknown | ~2-5s (subscription) |
| **Real-time streaming** | gRPC + WebSocket | WS w/ pump.fun filter ($250+) | No | GraphQL subscriptions |
| **Token analytics** | Raw tx data only | Rich (mcap, vol, security) | Basic metadata | Rich (GraphQL) |
| **OHLCV / Charts** | No | Yes | No | Yes |
| **Security scoring** | No | Yes | No | Partial |
| **Holder data** | Via DAS API | Via token overview | No | Yes (top 10) |
| **Auth complexity** | API key (simple) | API key (simple) | JWT (complex) | API key (simple) |
| **Stability / SLA** | Production-grade | Production-grade | No SLA, may break | Production-grade |
| **Min. useful tier** | Developer ($49) | Starter ($99) | Free (risky) | Commercial ($$?) |
| **Pump.fun specific** | Program filter | General DeFi | Native | Dedicated queries |
| **SDK / DX** | Excellent (npm SDK) | REST (straightforward) | None | GraphQL IDE |

---

## Recommended Architecture

```
                    +------------------+
                    |   Helius ($49)   |
                    |   Webhooks/WS    |
                    +--------+---------+
                             |
                     New token events
                     Raw transactions
                             |
                             v
                    +------------------+
                    | Tracking Engine  |
                    |   (PortOS app)   |
                    +--------+---------+
                             |
                    Token enrichment
                    Analytics queries
                             |
                             v
                    +------------------+
                    | Birdeye ($99)    |
                    | REST API         |
                    +------------------+
                    - Market cap, volume
                    - Security scores
                    - OHLCV data
                    - Holder counts
```

### Phase 1 (MVP): Helius Developer ($49/mo)
- Webhook listening for pump.fun program transactions
- Detect new token creates via `TOKEN_MINT` events
- Parse creator address, token mint, initial supply
- Store in PortOS data layer

### Phase 2 (Enrichment): Add Birdeye Starter ($99/mo)
- Enrich detected tokens with market data
- Token security scoring for scam filtering
- OHLCV data for trend detection
- Track high-performing tokens over time

### Phase 3 (Analytics): Evaluate Bitquery or pump.fun direct
- Creator reputation analysis
- Sniper account inventory
- Launch prediction model inputs

**Total estimated cost**: $148/mo for Phase 1+2

---

## Next Steps

1. **Create Helius account** and generate API key
2. **Set up webhook** for pump.fun program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`)
3. **Create Birdeye account** and generate API key
4. **Build proof-of-concept** endpoint in PortOS that:
   - Receives Helius webhook events
   - Extracts new token mint + creator
   - Enriches via Birdeye token overview
   - Persists to `data/pumpfun/tokens.json`
5. **Validate latency** — measure time from on-chain creation to detection
