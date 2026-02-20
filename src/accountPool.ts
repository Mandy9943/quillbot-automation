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
const ACCOUNT_IDS = ["acc1", "acc2", "acc3"] as const;
type AccountId = (typeof ACCOUNT_IDS)[number];

interface WorkerOutput {
  result?: string;
  firstMode?: string;
  secondMode?: string;
}

/**
 * Count words in a text string without allocating split/filter arrays.
 */
function getWordCount(text: string): number {
  const matcher = /\S+/g;
  let count = 0;
  while (matcher.exec(text) !== null) {
    count += 1;
  }
  return count;
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
  private readonly workers: Record<AccountId, AccountWorker>;
  private _isReady = false;

  constructor(
    private readonly accounts: AccountConfig[],
    private readonly headless: boolean = true,
  ) {
    if (accounts.length !== ACCOUNT_IDS.length) {
      throw new Error("AccountPool requires exactly 3 accounts");
    }

    this.workers = {
      acc1: new AccountWorker("acc1", accounts[0], headless),
      acc2: new AccountWorker("acc2", accounts[1], headless),
      acc3: new AccountWorker("acc3", accounts[2], headless),
    };
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

    const initPromises: Array<Promise<{ accountId: AccountId; success: boolean }>> =
      [];

    for (const accountId of ACCOUNT_IDS) {
      const worker = this.workers[accountId];
      initPromises.push(
        worker
          .init()
          .then(() => ({ accountId, success: true }))
          .catch((error) => {
            console.error(`Failed to initialize ${accountId}:`, error);
            return { accountId, success: false };
          }),
      );
    }

    const results = await Promise.all(initPromises);
    let successCount = 0;
    for (const result of results) {
      if (result.success) {
        successCount += 1;
      }
    }

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
    const disposePromises: Array<Promise<void>> = [];

    for (const accountId of ACCOUNT_IDS) {
      disposePromises.push(this.workers[accountId].dispose());
    }

    await Promise.all(disposePromises);
    this._isReady = false;
    console.log("All workers disposed");
  }

  /**
   * Save cookies for all workers
   */
  async saveAllCookies(): Promise<void> {
    const savePromises: Array<Promise<void>> = [];

    for (const accountId of ACCOUNT_IDS) {
      const worker = this.workers[accountId];
      savePromises.push(
        worker.saveCookies().catch((err) => {
          console.error(`Failed to save cookies for ${worker.accountId}:`, err);
        }),
      );
    }

    await Promise.all(savePromises);
  }

  /**
   * Get status of all workers
   */
  getStatus(): PoolStatus {
    const acc1 = this.workers.acc1;
    const acc2 = this.workers.acc2;
    const acc3 = this.workers.acc3;

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
  private getOtherWorkers(excludeId: AccountId): AccountWorker[] {
    const workers: AccountWorker[] = [];

    for (const accountId of ACCOUNT_IDS) {
      if (accountId === excludeId) {
        continue;
      }

      const worker = this.workers[accountId];
      if (worker.status === "ready") {
        workers.push(worker);
      }
    }

    return workers;
  }

  private durationSince(startTime: number): number {
    return Math.round(performance.now() - startTime);
  }

  private toWorkerResult(
    startTime: number,
    output: WorkerOutput,
    fallbackUsed?: string,
    primaryError?: string,
  ): AccountWorkerResult {
    const response: AccountWorkerResult = {
      durationMs: this.durationSince(startTime),
    };

    if (output.result !== undefined) {
      response.result = output.result;
    }

    if (output.firstMode !== undefined) {
      response.firstMode = output.firstMode;
    }

    if (output.secondMode !== undefined) {
      response.secondMode = output.secondMode;
    }

    if (fallbackUsed) {
      response.fallbackUsed = fallbackUsed;
    }

    if (primaryError) {
      response.error = primaryError;
    }

    return response;
  }

  private async invokeWorker(
    worker: AccountWorker,
    text: string,
    mode: ParaphraseMode,
    requestId: string,
    useTimeout: boolean,
  ): Promise<WorkerOutput> {
    if (mode === "standard") {
      return {
        result: await worker.paraphraseStandardMode(text, requestId),
      };
    }

    const result = useTimeout
      ? await worker.paraphraseWithTimeout(text, SMALL_TEXT_TIMEOUT_MS, requestId)
      : await worker.paraphrase(text, requestId);

    return {
      firstMode: result.firstMode,
      secondMode: result.secondMode,
    };
  }

  private async tryFallbackWorkers(
    accountId: AccountId,
    fallbackWorkers: AccountWorker[],
    text: string,
    requestId: string,
    mode: ParaphraseMode,
    startTime: number,
    primaryError: Error | null,
    options: { useTimeout: boolean; waitForAvailability: boolean },
  ): Promise<AccountWorkerResult | undefined> {
    for (const fallbackWorker of fallbackWorkers) {
      try {
        if (options.waitForAvailability) {
          console.log(
            `[${accountId}] Waiting for fallback worker ${fallbackWorker.accountId}...`,
          );
          await fallbackWorker.waitForAvailable();
          console.log(
            `[${accountId}] Using fallback worker ${fallbackWorker.accountId}`,
          );
        } else {
          console.log(
            `[${accountId}] Using available fallback worker ${fallbackWorker.accountId} (with timeout)`,
          );
        }

        const output = await this.invokeWorker(
          fallbackWorker,
          text,
          mode,
          `${requestId}-fallback-${fallbackWorker.accountId}`,
          options.useTimeout,
        );

        return this.toWorkerResult(
          startTime,
          output,
          fallbackWorker.accountId,
          primaryError?.message,
        );
      } catch (fallbackError) {
        const fallbackErrorMsg =
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
        const isFallbackTimeout = fallbackError instanceof TimeoutError;

        if (options.useTimeout) {
          console.log(
            `[${accountId}] Fallback ${fallbackWorker.accountId} also failed${isFallbackTimeout ? " (TIMEOUT)" : ""}: ${fallbackErrorMsg}`,
          );
        } else {
          console.log(
            `[${accountId}] Fallback ${fallbackWorker.accountId} also failed: ${fallbackErrorMsg}`,
          );
        }
      }
    }

    return undefined;
  }

  /**
   * Process a single account's text with fallback to other workers on failure
   * Uses FIFO queue for fallback - waits for a healthy worker to become available
   * For small texts (<=300 words), applies a 50s timeout and only uses immediately available fallbacks
   */
  private async processWithFallback(
    accountId: AccountId,
    text: string,
    requestId: string,
    mode: ParaphraseMode = "dual",
  ): Promise<AccountWorkerResult> {
    const startTime = performance.now();
    const worker = this.workers[accountId];
    const wordCount = getWordCount(text);
    const isSmallText = wordCount <= SMALL_TEXT_MAX_WORDS;

    if (worker.status !== "ready") {
      return {
        durationMs: this.durationSince(startTime),
        error: `Account ${accountId} is not ready: ${worker.lastError || worker.status}`,
      };
    }

    // Try primary worker first
    let primaryError: Error | null = null;
    let isTimeoutError = false;

    try {
      if (mode === "dual" && isSmallText) {
        console.log(
          `[${accountId}] Small text (${wordCount} words), using ${SMALL_TEXT_TIMEOUT_MS}ms timeout`,
        );
      }

      const primaryOutput = await this.invokeWorker(
        worker,
        text,
        mode,
        requestId,
        mode === "dual" && isSmallText,
      );

      return this.toWorkerResult(startTime, primaryOutput);
    } catch (error) {
      primaryError = error instanceof Error ? error : new Error(String(error));
      isTimeoutError = error instanceof TimeoutError;

      console.log(
        `[${accountId}] Primary attempt failed${isTimeoutError ? " (TIMEOUT)" : ""}: ${primaryError.message}, trying fallback...`,
      );
    }

    const fallbackWorkers = this.getOtherWorkers(accountId);

    if (isSmallText) {
      const availableFallbacks: AccountWorker[] = [];
      for (const fallbackWorker of fallbackWorkers) {
        if (fallbackWorker.isAvailable) {
          availableFallbacks.push(fallbackWorker);
        }
      }

      if (availableFallbacks.length === 0) {
        console.log(
          `[${accountId}] No immediately available fallback workers for small text`,
        );
        return {
          durationMs: this.durationSince(startTime),
          error: isTimeoutError
            ? "All accounts busy or timed out, please retry later"
            : primaryError?.message || "Unknown error",
        };
      }

      const fallbackResult = await this.tryFallbackWorkers(
        accountId,
        availableFallbacks,
        text,
        requestId,
        mode,
        startTime,
        primaryError,
        { useTimeout: mode === "dual", waitForAvailability: false },
      );

      if (fallbackResult) {
        return fallbackResult;
      }

      return {
        durationMs: this.durationSince(startTime),
        error: "All accounts busy or timed out, please retry later",
      };
    }

    const fallbackResult = await this.tryFallbackWorkers(
      accountId,
      fallbackWorkers,
      text,
      requestId,
      mode,
      startTime,
      primaryError,
      { useTimeout: false, waitForAvailability: true },
    );

    if (fallbackResult) {
      return fallbackResult;
    }

    // All workers failed
    return {
      durationMs: this.durationSince(startTime),
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
    const response: BatchResponse = {};
    const tasks: Array<Promise<void>> = [];

    if (request.acc1) {
      tasks.push(
        this.processWithFallback("acc1", request.acc1, `${requestId}-acc1`, mode).then(
          (result) => {
            response.acc1 = result;
          },
        ),
      );
    }

    if (request.acc2) {
      tasks.push(
        this.processWithFallback("acc2", request.acc2, `${requestId}-acc2`, mode).then(
          (result) => {
            response.acc2 = result;
          },
        ),
      );
    }

    if (request.acc3) {
      tasks.push(
        this.processWithFallback("acc3", request.acc3, `${requestId}-acc3`, mode).then(
          (result) => {
            response.acc3 = result;
          },
        ),
      );
    }

    if (tasks.length === 0) {
      throw new Error("At least one account text must be provided");
    }

    await Promise.all(tasks);
    return response;
  }

  /**
   * Restart a specific worker
   */
  async restartWorker(accountId: string): Promise<void> {
    if (!this.isAccountId(accountId)) {
      throw new Error(`Account ${accountId} not found`);
    }
    await this.workers[accountId].restart();
  }

  /**
   * Restart all workers
   */
  async restartAll(): Promise<void> {
    console.log("Restarting all workers...");
    const restartPromises: Array<Promise<{ accountId: AccountId; success: boolean }>> =
      [];

    for (const accountId of ACCOUNT_IDS) {
      const worker = this.workers[accountId];
      restartPromises.push(
        worker
          .restart()
          .then(() => ({ accountId, success: true }))
          .catch((error) => {
            console.error(`Failed to restart ${accountId}:`, error);
            return { accountId, success: false };
          }),
      );
    }

    const results = await Promise.all(restartPromises);
    let successCount = 0;
    for (const result of results) {
      if (result.success) {
        successCount += 1;
      }
    }

    console.log(`Restart complete: ${successCount}/3 workers restarted`);
  }

  private isAccountId(accountId: string): accountId is AccountId {
    return accountId === "acc1" || accountId === "acc2" || accountId === "acc3";
  }
}
