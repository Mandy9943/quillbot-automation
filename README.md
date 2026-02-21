# QuillBot Automation API

Multi-account QuillBot browser-automation service (3 accounts, 3 browsers) with adaptive scheduling, fallback routing, and strict-mode batch control.

## What It Does
- Runs 3 persistent Puppeteer workers (`acc1`, `acc2`, `acc3`).
- Exposes one API endpoint (`POST /paraphrase-batch`) for parallel paraphrasing.
- Supports:
  - `dual` mode (Simple -> Shorten)
  - `standard` mode
  - `ludicrous` mode (single-pass fastest profile)
- Keeps QuillBot UI action flow intact (same selectors/button order), while improving reliability and throughput around scheduling/retries/recovery.

## Key Reliability/Speed Features
- Adaptive account scheduler (score-based account selection)
- Per-account pacing with cooldown + jitter
- Health state machine (`healthy`, `degraded`, `tripped`)
- Local retry + cross-account fallback chain
- Optional strict all-or-nothing response mode (`strict=true`)
- Structured per-slot telemetry + rolling performance metrics
- Recommended word budgets exposed in `/status`

## Requirements
- Node.js 18+
- 3 QuillBot accounts (no forced MFA/CAPTCHA blockers)
- Chromium-compatible runtime (Docker image includes required deps)

## Setup
```bash
npm install
cp .env.example .env
```

Required env:
- `QUILLBOT_ACCOUNTS` JSON array with exactly 3 accounts

Optional env:
- `QUILLBOT_ACCOUNTS_BASE64`
- `PORT` (default `3000`)
- `HEADLESS` (default `true`)
- `INIT_RETRY_MS` (default `30000`)
- `SCHEDULER_ADAPTIVE` (`true` by default)
- `STRICT_MODE_DEFAULT` (`false` by default)
- `COOLDOWN_PROFILE` (`balanced`, `max_speed`, `max_stability`)

## Run
```bash
npm run dev
```

```bash
npm run build
npm start
```

## API
### `GET /health`
Basic liveness + pool status.

### `GET /status`
Detailed worker + scheduler state, including:
- per-account health/cooldown/ewma rates
- rolling throughput/success/fallback/restart stats
- recommended budgets (`dual`, `standard`, `ludicrous`, and per-account)

### `POST /paraphrase-batch`
Request body:
```json
{
  "acc1": "text...",
  "acc2": "text...",
  "acc3": "text...",
  "mode": "dual",
  "strict": false,
  "requestId": "client-job-123"
}
```

Notes:
- At least one of `acc1`, `acc2`, `acc3` is required.
- `mode`: `dual` (default), `standard`, or `ludicrous`.
- `strict`:
  - `false` (default): partial success allowed.
  - `true`: any failed slot returns full batch failure (HTTP 502).

Success response includes per-slot results plus:
```json
{
  "meta": {
    "requestId": "...",
    "mode": "dual",
    "strict": false,
    "totalSlots": 3,
    "successSlots": 3,
    "failedSlots": 0,
    "fallbackSlots": 1,
    "totalAttempts": 4,
    "totalWords": 1320,
    "durationMs": 18123
  }
}
```

Per-slot telemetry fields:
- `accountUsed`
- `attempts`
- `queueWaitMs`
- `processingMs`
- `errorCode`
- `fallbackUsed`
- `fallbackChain`

## Docker
```bash
docker-compose up --build
```

## Notes
- This service intentionally does not use QuillBot private APIs.
- Browser interaction sequence is preserved; optimizations are scheduler/recovery/telemetry-side.
