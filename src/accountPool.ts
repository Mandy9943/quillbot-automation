import { performance } from "node:perf_hooks";
import {
  AccountConfig,
  AccountWorker,
  AccountWorkerResult,
  TimeoutError,
} from "./accountWorker";

// Timeout configuration for small texts
const SMALL_TEXT_MAX_WORDS = 300;
const SMALL_TEXT_TIMEOUT_MS = 50000; // 50 seconds

/**
 * Count words in a text string
 */
function getWordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

export type ParaphraseMode = "dual" | "standard";

export interface BatchRequest {
  acc1?: string;
  acc2?: string;
  acc3?: string;
  /** Mode: "dual" for Simple→Shorten (default), "standard" for Standard mode only */
  mode?: ParaphraseMode;
}

export interface BatchResponse {
  acc1?: AccountWorkerResult;
  acc2?: AccountWorkerResult;
  acc3?: AccountWorkerResult;
}

export interface PoolStatus {
  acc1: { status: string; lastError?: string };
  acc2: { status: string; lastError?: string };
  acc3: { status: string; lastError?: string };
  ready: boolean;
}

export class AccountPool {
  private workers: Map<string, AccountWorker> = new Map();
  private accountIds = ["acc1", "acc2", "acc3"] as const;
  private _isReady = false;

  constructor(
    private readonly accounts: AccountConfig[],
    private readonly headless: boolean = true,
  ) {
    if (accounts.length !== 3) {
      throw new Error("AccountPool requires exactly 3 accounts");
    }

    // Create workers for each account
    for (let i = 0; i < 3; i++) {
      const accountId = this.accountIds[i];
      const worker = new AccountWorker(accountId, accounts[i], headless);
      this.workers.set(accountId, worker);
    }
  }

  get isReady(): boolean {
    return this._isReady;
  }

  /**
   * Initialize all workers in parallel (login all accounts at startup)
   * Continues with available accounts if some fail
   */
  async initAll(): Promise<void> {
    console.log("Initializing all account workers in parallel...");

    const initPromises = Array.from(this.workers.entries()).map(
      async ([accountId, worker]) => {
        try {
          await worker.init();
          return { accountId, success: true };
        } catch (error) {
          console.error(`Failed to initialize ${accountId}:`, error);
          return { accountId, success: false, error };
        }
      },
    );

    const results = await Promise.all(initPromises);
    const successCount = results.filter((r) => r.success).length;

    if (successCount === 0) {
      throw new Error("All account workers failed to initialize");
    }

    console.log(`Account pool ready: ${successCount}/3 workers initialized`);
    this._isReady = true;
  }

  /**
   * Dispose all workers
   */
  async disposeAll(): Promise<void> {
    console.log("Disposing all account workers...");
    const disposePromises = Array.from(this.workers.values()).map((worker) =>
      worker.dispose(),
    );
    await Promise.all(disposePromises);
    this._isReady = false;
    console.log("All workers disposed");
  }

  /**
   * Save cookies for all workers
   */
  async saveAllCookies(): Promise<void> {
    const savePromises = Array.from(this.workers.values()).map((worker) =>
      worker.saveCookies().catch((err) => {
        console.error(`Failed to save cookies for ${worker.accountId}:`, err);
      }),
    );
    await Promise.all(savePromises);
  }

  /**
   * Get status of all workers
   */
  getStatus(): PoolStatus {
    const acc1 = this.workers.get("acc1")!;
    const acc2 = this.workers.get("acc2")!;
    const acc3 = this.workers.get("acc3")!;

    return {
      acc1: { status: acc1.status, lastError: acc1.lastError },
      acc2: { status: acc2.status, lastError: acc2.lastError },
      acc3: { status: acc3.status, lastError: acc3.lastError },
      ready: this._isReady,
    };
  }

  /**
   * Get other available workers excluding the specified one, sorted by account order
   */
  private getOtherWorkers(excludeId: string): AccountWorker[] {
    return this.accountIds
      .filter((id) => id !== excludeId)
      .map((id) => this.workers.get(id)!)
      .filter((worker) => worker.status === "ready");
  }

  /**
   * Process a single account's text with fallback to other workers on failure
   * Uses FIFO queue for fallback - waits for a healthy worker to become available
   * For small texts (<=300 words), applies a 50s timeout and only uses immediately available fallbacks
   */
  private async processWithFallback(
    accountId: string,
    text: string,
    requestId: string,
    mode: ParaphraseMode = "dual",
  ): Promise<AccountWorkerResult> {
    const startTime = performance.now();
    const worker = this.workers.get(accountId);
    const wordCount = getWordCount(text);
    const isSmallText = wordCount <= SMALL_TEXT_MAX_WORDS;

    if (!worker) {
      return {
        durationMs: Math.round(performance.now() - startTime),
        error: `Account ${accountId} not found`,
      };
    }

    // Check if primary worker is available
    if (worker.status !== "ready") {
      return {
        durationMs: Math.round(performance.now() - startTime),
        error: `Account ${accountId} is not ready: ${worker.lastError || worker.status}`,
      };
    }

    // Try primary worker first
    let primaryError: Error | null = null;
    let isTimeoutError = false;

    try {
      if (mode === "standard") {
        const result = await worker.paraphraseStandardMode(text, requestId);
        return {
          result,
          durationMs: Math.round(performance.now() - startTime),
        };
      } else {
        // For small texts, use timeout version
        if (isSmallText) {
          console.log(
            `[${accountId}] Small text (${wordCount} words), using ${SMALL_TEXT_TIMEOUT_MS}ms timeout`,
          );
          const result = await worker.paraphraseWithTimeout(
            text,
            SMALL_TEXT_TIMEOUT_MS,
            requestId,
          );
          return {
            firstMode: result.firstMode,
            secondMode: result.secondMode,
            durationMs: Math.round(performance.now() - startTime),
          };
        } else {
          const result = await worker.paraphrase(text, requestId);
          return {
            firstMode: result.firstMode,
            secondMode: result.secondMode,
            durationMs: Math.round(performance.now() - startTime),
          };
        }
      }
    } catch (error) {
      primaryError = error instanceof Error ? error : new Error(String(error));
      isTimeoutError = error instanceof TimeoutError;

      console.log(
        `[${accountId}] Primary attempt failed${isTimeoutError ? " (TIMEOUT)" : ""}: ${primaryError.message}, trying fallback...`,
      );
    }

    // Get fallback workers
    const fallbackWorkers = this.getOtherWorkers(accountId);

    // For small texts with timeout, only try immediately available workers (no FIFO waiting)
    if (isSmallText) {
      const availableFallbacks = fallbackWorkers.filter((w) => w.isAvailable);

      if (availableFallbacks.length === 0) {
        console.log(
          `[${accountId}] No immediately available fallback workers for small text`,
        );
        return {
          durationMs: Math.round(performance.now() - startTime),
          error: isTimeoutError
            ? "All accounts busy or timed out, please retry later"
            : primaryError?.message || "Unknown error",
        };
      }

      // Try each available fallback with timeout
      for (const fallbackWorker of availableFallbacks) {
        try {
          console.log(
            `[${accountId}] Using available fallback worker ${fallbackWorker.accountId} (with timeout)`,
          );

          if (mode === "standard") {
            const result = await fallbackWorker.paraphraseStandardMode(
              text,
              `${requestId}-fallback-${fallbackWorker.accountId}`,
            );
            return {
              result,
              durationMs: Math.round(performance.now() - startTime),
              fallbackUsed: fallbackWorker.accountId,
              error: primaryError?.message,
            };
          } else {
            const result = await fallbackWorker.paraphraseWithTimeout(
              text,
              SMALL_TEXT_TIMEOUT_MS,
              `${requestId}-fallback-${fallbackWorker.accountId}`,
            );
            return {
              firstMode: result.firstMode,
              secondMode: result.secondMode,
              durationMs: Math.round(performance.now() - startTime),
              fallbackUsed: fallbackWorker.accountId,
              error: primaryError?.message,
            };
          }
        } catch (fallbackError) {
          const fallbackErrorMsg =
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError);
          const isFallbackTimeout = fallbackError instanceof TimeoutError;
          console.log(
            `[${accountId}] Fallback ${fallbackWorker.accountId} also failed${isFallbackTimeout ? " (TIMEOUT)" : ""}: ${fallbackErrorMsg}`,
          );
          // Continue to next available fallback
        }
      }

      // All available fallbacks failed for small text
      return {
        durationMs: Math.round(performance.now() - startTime),
        error: "All accounts busy or timed out, please retry later",
      };
    }

    // For large texts, use original FIFO fallback logic (no timeout)
    for (const fallbackWorker of fallbackWorkers) {
      try {
        // Wait for fallback worker to become available (FIFO queue)
        console.log(
          `[${accountId}] Waiting for fallback worker ${fallbackWorker.accountId}...`,
        );
        await fallbackWorker.waitForAvailable();

        console.log(
          `[${accountId}] Using fallback worker ${fallbackWorker.accountId}`,
        );

        if (mode === "standard") {
          const result = await fallbackWorker.paraphraseStandardMode(
            text,
            `${requestId}-fallback-${fallbackWorker.accountId}`,
          );
          return {
            result,
            durationMs: Math.round(performance.now() - startTime),
            fallbackUsed: fallbackWorker.accountId,
            error: primaryError?.message,
          };
        } else {
          const result = await fallbackWorker.paraphrase(
            text,
            `${requestId}-fallback-${fallbackWorker.accountId}`,
          );
          return {
            firstMode: result.firstMode,
            secondMode: result.secondMode,
            durationMs: Math.round(performance.now() - startTime),
            fallbackUsed: fallbackWorker.accountId,
            error: primaryError?.message,
          };
        }
      } catch (fallbackError) {
        const fallbackErrorMsg =
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
        console.log(
          `[${accountId}] Fallback ${fallbackWorker.accountId} also failed: ${fallbackErrorMsg}`,
        );
        // Continue to next fallback
      }
    }

    // All workers failed
    return {
      durationMs: Math.round(performance.now() - startTime),
      error: primaryError?.message || "Unknown error",
    };
  }

  /**
   * Process batch request - run all requested accounts in parallel
   * Frontend decides which account handles which text
   *
   * @param request Object with acc1, acc2, acc3 text assignments (any can be omitted)
   * @param request.mode "dual" for Simple→Shorten (default), "standard" for Standard mode only
   * @returns Object with results for each requested account
   */
  async processBatch(request: BatchRequest): Promise<BatchResponse> {
    const requestId = `batch-${Date.now()}`;
    const mode = request.mode || "dual";
    const tasks: Array<{
      accountId: "acc1" | "acc2" | "acc3";
      promise: Promise<AccountWorkerResult>;
    }> = [];

    // Create tasks for each requested account
    if (request.acc1) {
      tasks.push({
        accountId: "acc1",
        promise: this.processWithFallback(
          "acc1",
          request.acc1,
          `${requestId}-acc1`,
          mode,
        ),
      });
    }
    if (request.acc2) {
      tasks.push({
        accountId: "acc2",
        promise: this.processWithFallback(
          "acc2",
          request.acc2,
          `${requestId}-acc2`,
          mode,
        ),
      });
    }
    if (request.acc3) {
      tasks.push({
        accountId: "acc3",
        promise: this.processWithFallback(
          "acc3",
          request.acc3,
          `${requestId}-acc3`,
          mode,
        ),
      });
    }

    if (tasks.length === 0) {
      throw new Error("At least one account text must be provided");
    }

    // Execute all tasks in parallel
    const results = await Promise.all(
      tasks.map(async (task) => ({
        accountId: task.accountId,
        result: await task.promise,
      })),
    );

    // Build response object
    const response: BatchResponse = {};
    for (const { accountId, result } of results) {
      response[accountId] = result;
    }

    return response;
  }

  /**
   * Restart a specific worker
   */
  async restartWorker(accountId: string): Promise<void> {
    const worker = this.workers.get(accountId);
    if (!worker) {
      throw new Error(`Account ${accountId} not found`);
    }
    await worker.restart();
  }

  /**
   * Restart all workers
   */
  async restartAll(): Promise<void> {
    console.log("Restarting all workers...");
    const restartPromises = Array.from(this.workers.entries()).map(
      async ([accountId, worker]) => {
        try {
          await worker.restart();
          return { accountId, success: true };
        } catch (error) {
          console.error(`Failed to restart ${accountId}:`, error);
          return { accountId, success: false };
        }
      },
    );

    const results = await Promise.all(restartPromises);
    const successCount = results.filter((r) => r.success).length;
    console.log(`Restart complete: ${successCount}/3 workers restarted`);
  }
}
