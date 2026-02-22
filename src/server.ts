import cors from "cors";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import * as fs from "fs";
import * as path from "path";

import {
  AccountPool,
  AccountPoolOptions,
  BatchRequest,
  StrictBatchError,
} from "./accountPool";
import { AccountConfig } from "./accountWorker";

dotenv.config();

const VALID_MODES = ["dual", "standard", "ludicrous"] as const;
const VALID_MODE_SET = new Set<string>(VALID_MODES);
const VALID_ACCOUNT_IDS = ["acc1", "acc2", "acc3"] as const;
const VALID_ACCOUNT_ID_SET = new Set<string>(VALID_ACCOUNT_IDS);
const VALID_COOLDOWN_PROFILES = [
  "balanced",
  "max_speed",
  "max_stability",
] as const;
const VALID_COOLDOWN_PROFILE_SET = new Set<string>(VALID_COOLDOWN_PROFILES);

interface BatchRequestBody {
  acc1?: unknown;
  acc2?: unknown;
  acc3?: unknown;
  mode?: unknown;
  strict?: unknown;
  requestId?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDebugScreenshotName(file: string): boolean {
  return (
    (file.startsWith("error_") || file.startsWith("debug_")) &&
    file.endsWith(".png")
  );
}

function isValidDebugViewFilename(file: string): boolean {
  return isDebugScreenshotName(file) && !file.includes("..");
}

// Parse accounts from environment variable
let accountsJson = process.env.QUILLBOT_ACCOUNTS;

// Support base64-encoded JSON to avoid shell escaping issues
if (process.env.QUILLBOT_ACCOUNTS_BASE64) {
  try {
    accountsJson = Buffer.from(
      process.env.QUILLBOT_ACCOUNTS_BASE64,
      "base64",
    ).toString("utf-8");
    console.log("Using base64-decoded QUILLBOT_ACCOUNTS_BASE64");
  } catch (e) {
    console.error("Failed to decode QUILLBOT_ACCOUNTS_BASE64:", e);
  }
}

if (!accountsJson) {
  console.error(
    "QUILLBOT_ACCOUNTS (or QUILLBOT_ACCOUNTS_BASE64) must be set as a JSON array in environment variables.",
  );
  console.error(
    'Example: QUILLBOT_ACCOUNTS=[{"email":"a@x.com","password":"pass1"},{"email":"b@x.com","password":"pass2"},{"email":"c@x.com","password":"pass3"}]',
  );
  console.error(
    "Or use QUILLBOT_ACCOUNTS_BASE64 with base64-encoded JSON to avoid escaping issues.",
  );
  process.exit(1);
}

let accounts: AccountConfig[];
try {
  console.log("Parsing QUILLBOT_ACCOUNTS, length:", accountsJson.length);
  console.log("First 100 chars:", accountsJson.substring(0, 100));
  accounts = JSON.parse(accountsJson);
  if (!Array.isArray(accounts) || accounts.length !== 3) {
    throw new Error("QUILLBOT_ACCOUNTS must contain exactly 3 accounts");
  }

  for (let i = 0; i < accounts.length; i++) {
    if (!accounts[i].email || !accounts[i].password) {
      throw new Error(`Account ${i + 1} is missing email or password`);
    }
  }
} catch (error) {
  console.error("Failed to parse QUILLBOT_ACCOUNTS:", error);
  console.error("Raw value received:", accountsJson);
  process.exit(1);
}

const headless = process.env.HEADLESS !== "false";
const port = Number(process.env.PORT ?? 3000);
const initRetryMs = Number(process.env.INIT_RETRY_MS ?? 30000);
const schedulerAdaptive = process.env.SCHEDULER_ADAPTIVE !== "false";
const strictModeDefault = process.env.STRICT_MODE_DEFAULT === "true";
const rawCooldownProfile = (process.env.COOLDOWN_PROFILE ?? "balanced").trim();
const cooldownProfile = VALID_COOLDOWN_PROFILE_SET.has(rawCooldownProfile)
  ? (rawCooldownProfile as AccountPoolOptions["cooldownProfile"])
  : "balanced";

console.log(`Configured accounts: ${accounts.map((a) => a.email).join(", ")}`);
console.log(`Headless mode: ${headless}`);
console.log(
  `Scheduler adaptive: ${schedulerAdaptive}, strict default: ${strictModeDefault}, cooldown profile: ${cooldownProfile}`,
);

const pool = new AccountPool(accounts, headless, {
  schedulerAdaptive,
  strictModeDefault,
  cooldownProfile,
});

let isInitializingPool = false;
let initRetryTimer: ReturnType<typeof setTimeout> | null = null;

const schedulePoolInitRetry = () => {
  if (pool.isReady || initRetryTimer) {
    return;
  }

  console.log(`Retrying account pool initialization in ${initRetryMs}ms...`);
  initRetryTimer = setTimeout(() => {
    initRetryTimer = null;
    void initializePool();
  }, initRetryMs);
};

const initializePool = async () => {
  if (pool.isReady || isInitializingPool) {
    return;
  }

  isInitializingPool = true;
  try {
    await pool.initAll();
    console.log("Account pool initialized and ready to accept requests.");
  } catch (error) {
    console.error("Unable to initialize account pool:", error);
    schedulePoolInitRetry();
  } finally {
    isInitializingPool = false;
  }
};

void initializePool();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Health check
app.get("/health", (_req: Request, res: Response) => {
  const status = pool.getStatus();
  res.json({ status: "ok", ...status });
});

// Status endpoint - shows state of each account
app.get("/status", (_req: Request, res: Response) => {
  res.json(pool.getStatus());
});

// Debug endpoints
app.get("/debug/screenshot", (_req: Request, res: Response) => {
  const screenshotPath = path.resolve("error_screenshot.png");

  if (fs.existsSync(screenshotPath)) {
    res.sendFile(screenshotPath);
  } else {
    res.status(404).send("No error screenshot available");
  }
});

app.get("/debug/list-screenshots", (_req: Request, res: Response) => {
  const dir = process.cwd();

  try {
    const dirEntries = fs.readdirSync(dir);
    const files: Array<{ name: string; url: string; time: Date }> = [];

    for (const file of dirEntries) {
      if (!isDebugScreenshotName(file)) {
        continue;
      }

      files.push({
        name: file,
        url: `/debug/view/${file}`,
        time: fs.statSync(path.join(dir, file)).mtime,
      });
    }

    files.sort((a, b) => b.time.getTime() - a.time.getTime());
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get(
  "/debug/view/:filename",
  (req: Request<{ filename: string }>, res: Response) => {
    const filename = req.params.filename;

    if (typeof filename !== "string") {
      return res.status(400).send("Invalid filename");
    }

    // Basic security check
    if (!isValidDebugViewFilename(filename)) {
      return res.status(400).send("Invalid filename");
    }

    const filePath = path.resolve(filename);
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).send("File not found");
    }
  },
);

/**
 * Batch paraphrase endpoint
 *
 * Request body: {
 *   acc1?: string,
 *   acc2?: string,
 *   acc3?: string,
 *   mode?: "dual" | "standard" | "ludicrous"
 *   // "dual" = Simple→Shorten (default), "standard" = Standard mode only
 *   // "ludicrous" = Simple→Shorten with faster scheduler profile
 * }
 * At least one account text must be provided.
 *
 * Response: {
 *   acc1?: { result?: string, firstMode?: string, secondMode?: string, durationMs: number, error?: string, fallbackUsed?: string },
 *   acc2?: { ... },
 *   acc3?: { ... }
 * }
 *
 * For mode="dual": Returns firstMode and secondMode
 * For mode="standard": Returns result
 * For mode="ludicrous": Returns result (second pass) and may also include firstMode/secondMode
 */
app.post("/paraphrase-batch", async (req: Request, res: Response) => {
  if (!pool.isReady) {
    void initializePool();
    return res.status(503).json({
      error: "Account pool is not ready. Please wait for initialization.",
      ...pool.getStatus(),
    });
  }

  const body = (req.body ?? {}) as BatchRequestBody;
  const { acc1, acc2, acc3, mode, strict, requestId } = body;

  // Validate mode
  if (mode && (typeof mode !== "string" || !VALID_MODE_SET.has(mode))) {
    return res.status(400).json({
      error: `Invalid mode. Must be one of: ${VALID_MODES.join(", ")}`,
    });
  }

  const resolvedMode = (mode || "dual") as BatchRequest["mode"];

  if (strict !== undefined && typeof strict !== "boolean") {
    return res.status(400).json({
      error: "Invalid strict flag. Must be boolean.",
    });
  }

  if (
    requestId !== undefined &&
    (typeof requestId !== "string" || requestId.trim().length === 0)
  ) {
    return res.status(400).json({
      error: "Invalid requestId. Must be a non-empty string.",
    });
  }

  // Validate input
  const hasAcc1 = isNonEmptyString(acc1);
  const hasAcc2 = isNonEmptyString(acc2);
  const hasAcc3 = isNonEmptyString(acc3);

  if (!hasAcc1 && !hasAcc2 && !hasAcc3) {
    return res.status(400).json({
      error: "At least one of acc1, acc2, or acc3 must be a non-empty string.",
    });
  }

  const request: BatchRequest = { mode: resolvedMode };
  if (hasAcc1) request.acc1 = acc1;
  if (hasAcc2) request.acc2 = acc2;
  if (hasAcc3) request.acc3 = acc3;
  if (typeof strict === "boolean") request.strict = strict;
  if (typeof requestId === "string") request.requestId = requestId.trim();

  console.log(
    `Received batch request (mode=${resolvedMode}, strict=${
      request.strict ?? strictModeDefault
    }, requestId=${request.requestId || "auto"}): acc1=${
      hasAcc1 ? acc1.length + " chars" : "none"
    }, acc2=${hasAcc2 ? acc2.length + " chars" : "none"}, acc3=${
      hasAcc3 ? acc3.length + " chars" : "none"
    }`,
  );

  try {
    const response = await pool.processBatch(request);
    console.log("Batch request completed");
    res.json(response);
  } catch (error) {
    if (error instanceof StrictBatchError) {
      console.error("Batch request failed in strict mode");
      return res.status(502).json({
        error: "Strict batch failed: one or more slots failed",
        ...error.payload,
      });
    }

    console.error("Batch request failed:", error);
    res.status(500).json({
      error: "Failed to process batch request.",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Restart all workers
app.post("/restart", async (_req: Request, res: Response) => {
  console.log("Restart requested for all workers...");

  try {
    await pool.restartAll();
    res.json({ status: "ok", message: "All workers restarted successfully" });
  } catch (error) {
    console.error("Restart failed:", error);
    res.status(500).json({
      error: "Failed to restart workers",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Restart specific worker
app.post("/restart/:accountId", async (req: Request<{ accountId: string }>, res: Response) => {
  const accountId = req.params.accountId;

  if (typeof accountId !== "string" || !VALID_ACCOUNT_ID_SET.has(accountId)) {
    return res.status(400).json({
      error: "Invalid accountId. Must be acc1, acc2, or acc3.",
    });
  }

  console.log(`Restart requested for ${accountId}...`);

  try {
    await pool.restartWorker(accountId);
    res.json({
      status: "ok",
      message: `Worker ${accountId} restarted successfully`,
    });
  } catch (error) {
    console.error(`Restart of ${accountId} failed:`, error);
    res.status(500).json({
      error: `Failed to restart worker ${accountId}`,
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

const server = app.listen(port, () => {
  console.log(`Express API listening on http://localhost:${port}`);
});

const shutdown = async () => {
  console.log("Shutting down server...");

  if (initRetryTimer) {
    clearTimeout(initRetryTimer);
    initRetryTimer = null;
  }

  // Save cookies before disposing to preserve session for next startup
  try {
    console.log("Saving session cookies before shutdown...");
    await pool.saveAllCookies();
  } catch (error) {
    console.error("Failed to save cookies on shutdown:", error);
  }

  server.close();
  await pool.disposeAll();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
