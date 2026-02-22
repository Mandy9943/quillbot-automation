# QuillBot Multi-Account API Documentation

## Overview

This service consolidates **3 QuillBot accounts** into a **single service instance**, replacing the previous architecture where you needed to run 3 separate service instances.

### Before (Old Architecture)

```
┌─────────────────┐     ┌────────────────────────────────────┐
│   Your App      │────►│ Instance 1: analizeai.com          │  → Account 1
│                 │────►│ Instance 2: v2.analizeai.com       │  → Account 2
│                 │────►│ Instance 3: v3.analizeai.com       │  → Account 3
└─────────────────┘     └────────────────────────────────────┘
```

- Required 3 separate Docker containers/services
- Each instance used ~400MB RAM
- Manual load balancing in your frontend
- No built-in fallback between accounts

### After (New Architecture)

```
┌─────────────────┐     ┌────────────────────────────────────┐
│   Your App      │────►│  Single Instance                   │  → Account 1 (acc1)
│                 │     │  (your-domain.com or localhost)    │  → Account 2 (acc2)
│                 │     │                                    │  → Account 3 (acc3)
└─────────────────┘     └────────────────────────────────────┘
```

- Single service, single port
- All 3 accounts login at startup
- Built-in parallel processing
- Automatic FIFO fallback on failure

### Latest Additions

- Adaptive scheduler and per-account pacing
- Health-state routing (`healthy`, `degraded`, `tripped`)
- Optional strict mode (`strict=true`) for all-or-nothing batch behavior
- Caller trace id support (`requestId`)
- Batch-level `meta` and per-slot telemetry fields:
  - `accountUsed`
  - `attempts`
  - `queueWaitMs`
  - `processingMs`
  - `errorCode`
  - `fallbackChain`

---

## Configuration

### Environment Variables (.env)

```env
# JSON array with exactly 3 accounts
QUILLBOT_ACCOUNTS=[{"email":"account1@example.com","password":"pass1"},{"email":"account2@example.com","password":"pass2"},{"email":"account3@example.com","password":"pass3"}]

PORT=3090
HEADLESS=true
INIT_RETRY_MS=30000

# Scheduler controls
SCHEDULER_ADAPTIVE=true
STRICT_MODE_DEFAULT=false
COOLDOWN_PROFILE=balanced
```

---

## API Endpoints

### 1. Health Check

**Endpoint:** `GET /health`

**Description:** Check if the service is running and all accounts are ready.

**Response:**

```json
{
  "status": "ok",
  "acc1": { "status": "ready" },
  "acc2": { "status": "ready" },
  "acc3": { "status": "ready" },
  "ready": true
}
```

---

### 2. Account Status

**Endpoint:** `GET /status`

**Description:** Get detailed status of each account worker.

**Response:**

```json
{
  "acc1": { "status": "ready", "lastError": null },
  "acc2": { "status": "busy", "lastError": null },
  "acc3": { "status": "error", "lastError": "Session expired" },
  "ready": true,
  "scheduler": {
    "adaptiveEnabled": true,
    "cooldownProfile": "balanced",
    "recommendedBudgets": {
      "dual": 540,
      "standard": 990,
      "ludicrous": 1260
    },
    "rolling": {
      "throughputWordsPerMinute": 4120,
      "successRatio": 0.98,
      "p50DurationMs": 12100,
      "p95DurationMs": 29400,
      "fallbackRate": 0.06,
      "restartRatePerMinute": 0
    }
  }
}
```

**Possible status values:**

- `initializing` - Account is logging in
- `ready` - Account is available for requests
- `busy` - Account is currently processing a request
- `error` - Account encountered an error (see `lastError`)

---

### 3. Batch Paraphrase (Main Endpoint)

**Endpoint:** `POST /paraphrase-batch`

**Description:** Process up to 3 texts in parallel, one per account. This is the **primary endpoint** that replaces calling 3 separate instances.

#### Request Body

```json
{
  "acc1": "Text to paraphrase using account 1...",
  "acc2": "Text to paraphrase using account 2...",
  "acc3": "Text to paraphrase using account 3...",
  "mode": "dual",
  "strict": false,
  "requestId": "client-job-123"
}
```

| Field       | Type    | Required | Description                                                                   |
| ----------- | ------- | -------- | ----------------------------------------------------------------------------- |
| `acc1`      | string  | No\*     | Text for account 1 slot                                                       |
| `acc2`      | string  | No\*     | Text for account 2 slot                                                       |
| `acc3`      | string  | No\*     | Text for account 3 slot                                                       |
| `mode`      | string  | No       | `"dual"` (default), `"standard"`, or `"ludicrous"`                            |
| `strict`    | boolean | No       | `true` = all-or-nothing (any failed slot fails full batch with HTTP `502`)   |
| `requestId` | string  | No       | Client trace/idempotency id echoed back in `meta.requestId`                   |

\* At least one of `acc1`, `acc2`, or `acc3` must be provided.

#### Modes Explained

| Mode       | Description        | Passes | Speed   | Response Fields           |
| ---------- | ------------------ | ------ | ------- | ------------------------- |
| `dual`     | Simple → Shorten   | 2      | ~15-16s | `firstMode`, `secondMode` |
| `standard` | Standard mode only | 1      | ~5-6s   | `result`                  |
| `ludicrous` | Simple → Shorten (faster scheduler profile) | 2 | ~12-16s | `result` (plus optional `firstMode`/`secondMode`) |

---

#### Response - Dual Mode (default)

```json
{
  "acc1": {
    "firstMode": "First pass paraphrased text (Simple mode)",
    "secondMode": "Second pass paraphrased text (Shorten mode)",
    "durationMs": 15234,
    "accountUsed": "acc1",
    "attempts": 1,
    "queueWaitMs": 243,
    "processingMs": 14890
  },
  "acc2": {
    "firstMode": "First pass paraphrased text",
    "secondMode": "Second pass paraphrased text",
    "durationMs": 15456,
    "accountUsed": "acc3",
    "fallbackUsed": "acc3",
    "fallbackChain": ["acc3"],
    "attempts": 2,
    "queueWaitMs": 421,
    "processingMs": 15002,
    "errorCode": "E_THROTTLED"
  },
  "acc3": {
    "firstMode": "First pass paraphrased text",
    "secondMode": "Second pass paraphrased text",
    "durationMs": 15123,
    "accountUsed": "acc2",
    "attempts": 1,
    "queueWaitMs": 205,
    "processingMs": 14670
  },
  "meta": {
    "requestId": "client-job-123",
    "mode": "dual",
    "strict": false,
    "totalSlots": 3,
    "successSlots": 3,
    "failedSlots": 0,
    "fallbackSlots": 1,
    "totalAttempts": 4,
    "totalWords": 1360,
    "durationMs": 17789
  }
}
```

---

#### Response - Standard Mode

```json
{
  "acc1": {
    "result": "Paraphrased text using Standard mode",
    "durationMs": 5234
  },
  "acc2": {
    "result": "Paraphrased text using Standard mode",
    "durationMs": 5456
  },
  "acc3": {
    "result": "Paraphrased text using Standard mode",
    "durationMs": 5123
  }
}
```

---

#### Response - With Fallback (when primary account fails)

If an account fails, the service automatically uses another available account as fallback:

```json
{
  "acc1": {
    "firstMode": "...",
    "secondMode": "...",
    "durationMs": 15234
  },
  "acc2": {
    "firstMode": "...",
    "secondMode": "...",
    "durationMs": 15456
  },
  "acc3": {
    "firstMode": "...",
    "secondMode": "...",
    "durationMs": 25000,
    "fallbackUsed": "acc1",
    "error": "Session expired - browser restarted"
  }
}
```

| Field          | Description                                         |
| -------------- | --------------------------------------------------- |
| `fallbackUsed` | Which account was used as fallback (e.g., `"acc1"`) |
| `error`        | The original error from the primary account         |

---

#### Response - All Accounts Failed

If all 3 accounts fail, you get error details for each:

```json
{
  "acc1": {
    "durationMs": 30000,
    "error": "Timeout waiting for paraphrase"
  },
  "acc2": {
    "durationMs": 28000,
    "error": "Session expired"
  },
  "acc3": {
    "durationMs": 25000,
    "error": "Browser crashed"
  }
}
```

---

### 4. Restart All Workers

**Endpoint:** `POST /restart`

**Description:** Force restart all 3 browser sessions.

**Response:**

```json
{
  "status": "ok",
  "message": "All workers restarted successfully"
}
```

---

### 5. Restart Specific Worker

**Endpoint:** `POST /restart/:accountId`

**Description:** Restart a specific account's browser session.

**Parameters:**

- `accountId`: One of `acc1`, `acc2`, or `acc3`

**Example:** `POST /restart/acc2`

**Response:**

```json
{
  "status": "ok",
  "message": "Worker acc2 restarted successfully"
}
```

---

## Migration Guide: From 3 Instances to 1

### Old Way (3 separate service instances)

```javascript
// Before: 3 separate services on different domains
const [result1, result2, result3] = await Promise.all([
  // Instance 1: analizeai.com
  fetch("https://analizeai.com/paraphrase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text1 }),
  }),
  // Instance 2: v2.analizeai.com
  fetch("https://v2.analizeai.com/paraphrase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text2 }),
  }),
  // Instance 3: v3.analizeai.com
  fetch("https://v3.analizeai.com/paraphrase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text3 }),
  }),
]);
```

### New Way (1 batch call to single service)

```javascript
// After: Single batch call to one service
const response = await fetch("https://your-new-domain.com/paraphrase-batch", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    acc1: text1, // Previously handled by analizeai.com
    acc2: text2, // Previously handled by v2.analizeai.com
    acc3: text3, // Previously handled by v3.analizeai.com
    mode: "dual", // or 'standard' / 'ludicrous'
  }),
});

const { acc1, acc2, acc3 } = await response.json();

// Dual mode results:
console.log(acc1.firstMode, acc1.secondMode);
console.log(acc2.firstMode, acc2.secondMode);
console.log(acc3.firstMode, acc3.secondMode);

// Standard mode results:
// console.log(acc1.result, acc2.result, acc3.result);
```

---

## Usage Examples

### Example 1: Process 3 texts in parallel (Dual Mode)

```bash
curl -X POST http://localhost:3090/paraphrase-batch \
  -H "Content-Type: application/json" \
  -d '{
    "acc1": "Artificial intelligence is revolutionizing technology.",
    "acc2": "Climate change affects weather patterns globally.",
    "acc3": "Education plays a crucial role in development.",
    "mode": "dual"
  }'
```

**Response:**

```json
{
  "acc1": {
    "firstMode": "Technology is being revolutionized by artificial intelligence.",
    "secondMode": "AI is transforming technology.",
    "durationMs": 15234
  },
  "acc2": {
    "firstMode": "Weather patterns are changing worldwide due to climate change.",
    "secondMode": "Climate change alters global weather.",
    "durationMs": 15456
  },
  "acc3": {
    "firstMode": "Development depends heavily on education.",
    "secondMode": "Education is vital for development.",
    "durationMs": 15123
  }
}
```

---

### Example 2: Process 3 texts in parallel (Standard Mode - Faster)

```bash
curl -X POST http://localhost:3090/paraphrase-batch \
  -H "Content-Type: application/json" \
  -d '{
    "acc1": "Hello world, this is a test.",
    "acc2": "The quick brown fox jumps.",
    "acc3": "Technology changes everything.",
    "mode": "standard"
  }'
```

**Response:**

```json
{
  "acc1": { "result": "This is a test, hello world.", "durationMs": 5234 },
  "acc2": { "result": "The fast brown fox leaps.", "durationMs": 5456 },
  "acc3": {
    "result": "Everything is changed by technology.",
    "durationMs": 5123
  }
}
```

---

### Example 3: Process only 1 or 2 texts

You don't need to use all 3 accounts:

```bash
curl -X POST http://localhost:3090/paraphrase-batch \
  -H "Content-Type: application/json" \
  -d '{
    "acc1": "Just one text to process.",
    "mode": "standard"
  }'
```

**Response:**

```json
{
  "acc1": { "result": "Only one text for processing.", "durationMs": 5234 }
}
```

---

### Example 4: Check status before sending requests

```bash
curl http://localhost:3090/status
```

**Response:**

```json
{
  "acc1": { "status": "ready" },
  "acc2": { "status": "ready" },
  "acc3": { "status": "ready" },
  "ready": true
}
```

---

## Error Handling

### HTTP Status Codes

| Code | Meaning                                               |
| ---- | ----------------------------------------------------- |
| 200  | Success (check individual account results for errors) |
| 400  | Bad request (invalid mode, no texts provided)         |
| 503  | Service not ready (still initializing)                |
| 500  | Internal server error                                 |

### Handling Individual Account Errors

Always check each account's result for the `error` field:

```javascript
const response = await fetch("http://localhost:3090/paraphrase-batch", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ acc1: text1, acc2: text2, acc3: text3 }),
});

const data = await response.json();

for (const [account, result] of Object.entries(data)) {
  if (result.error) {
    console.log(`${account} failed: ${result.error}`);
    if (result.fallbackUsed) {
      console.log(`  Used fallback: ${result.fallbackUsed}`);
    }
  } else {
    console.log(`${account} success: ${result.firstMode || result.result}`);
  }
}
```

---

## Performance Comparison

| Scenario                | Old (3 instances)  | New (1 instance)           |
| ----------------------- | ------------------ | -------------------------- |
| **Memory usage**        | ~1.2GB (400MB × 3) | ~1.2GB (single process)    |
| **Startup time**        | 3 separate logins  | 3 parallel logins (faster) |
| **3 texts (dual)**      | ~15s parallel      | ~15s parallel              |
| **3 texts (standard)**  | ~5s parallel       | ~5s parallel               |
| **Fallback on failure** | Manual in frontend | Automatic FIFO             |
| **Port management**     | 3 ports            | 1 port                     |

---

## Summary

### Endpoint Mapping: Old → New

| Old Endpoint (Separate Instances)                   | New Equivalent (Single Instance)                          |
| --------------------------------------------------- | --------------------------------------------------------- |
| `POST https://analizeai.com/paraphrase`             | `POST /paraphrase-batch` with `acc1`                      |
| `POST https://v2.analizeai.com/paraphrase`          | `POST /paraphrase-batch` with `acc2`                      |
| `POST https://v3.analizeai.com/paraphrase`          | `POST /paraphrase-batch` with `acc3`                      |
| `POST https://analizeai.com/paraphrase-standard`    | `POST /paraphrase-batch` with `acc1` + `mode: "standard"` |
| `POST https://v2.analizeai.com/paraphrase-standard` | `POST /paraphrase-batch` with `acc2` + `mode: "standard"` |
| `POST https://v3.analizeai.com/paraphrase-standard` | `POST /paraphrase-batch` with `acc3` + `mode: "standard"` |
| `GET https://analizeai.com/health`                  | `GET /health` or `GET /status`                            |
| `GET https://v2.analizeai.com/health`               | `GET /health` or `GET /status`                            |
| `GET https://v3.analizeai.com/health`               | `GET /health` or `GET /status`                            |
| `POST https://analizeai.com/restart`                | `POST /restart/acc1`                                      |
| `POST https://v2.analizeai.com/restart`             | `POST /restart/acc2`                                      |
| `POST https://v3.analizeai.com/restart`             | `POST /restart/acc3`                                      |

### Account Mapping

| Old Instance                    | New Account ID | Description                               |
| ------------------------------- | -------------- | ----------------------------------------- |
| `analizeai.com` (Instance 1)    | `acc1`         | First account in QUILLBOT_ACCOUNTS array  |
| `v2.analizeai.com` (Instance 2) | `acc2`         | Second account in QUILLBOT_ACCOUNTS array |
| `v3.analizeai.com` (Instance 3) | `acc3`         | Third account in QUILLBOT_ACCOUNTS array  |

**You no longer need:**

- 3 separate Docker containers/deployments
- 3 separate domains (analizeai.com, v2.analizeai.com, v3.analizeai.com)
- 3 separate environment configurations
- Load balancing logic in your frontend
- Manual retry/fallback logic between instances
