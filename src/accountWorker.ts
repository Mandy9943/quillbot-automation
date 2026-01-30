import { ParaphraseResult, QuillBotAutomation } from "./quillbotAutomation";

/**
 * Custom error class for timeout errors - allows distinguishing from other errors
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export interface AccountConfig {
  email: string;
  password: string;
}

export type AccountStatus = "initializing" | "ready" | "busy" | "error";

export interface AccountWorkerResult {
  result?: string;
  firstMode?: string;
  secondMode?: string;
  durationMs: number;
  error?: string;
  fallbackUsed?: string;
}

export class AccountWorker {
  private automation: QuillBotAutomation;
  private _status: AccountStatus = "initializing";
  private _lastError?: string;
  private _busy: boolean = false;

  // FIFO fallback queue management
  private waitQueue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(
    public readonly accountId: string,
    private readonly config: AccountConfig,
    private readonly headless: boolean = true,
  ) {
    this.automation = new QuillBotAutomation({
      email: config.email,
      password: config.password,
      accountId,
      headless,
    });
  }

  get status(): AccountStatus {
    return this._status;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  get isBusy(): boolean {
    return this._busy;
  }

  get isAvailable(): boolean {
    return this._status === "ready" && !this._busy;
  }

  /**
   * Initialize the worker - login and prepare browser
   */
  async init(): Promise<void> {
    try {
      this._status = "initializing";
      console.log(`[${this.accountId}] Initializing worker...`);
      await this.automation.init();
      this._status = "ready";
      console.log(`[${this.accountId}] Worker ready`);
    } catch (error) {
      this._status = "error";
      this._lastError = error instanceof Error ? error.message : String(error);
      console.error(
        `[${this.accountId}] Worker initialization failed:`,
        this._lastError,
      );
      throw error;
    }
  }

  /**
   * Dispose the worker - close browser
   */
  async dispose(): Promise<void> {
    try {
      await this.automation.saveCookies();
    } catch (error) {
      console.error(
        `[${this.accountId}] Failed to save cookies on dispose:`,
        error,
      );
    }
    await this.automation.dispose();
    this._status = "initializing";
    this._busy = false;

    // Reject all waiting fallback requests
    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift();
      waiter?.reject(new Error("Worker disposed"));
    }
  }

  /**
   * Acquire lock for this worker. Returns true if acquired, false if busy.
   */
  private tryAcquire(): boolean {
    if (this._busy || this._status !== "ready") {
      return false;
    }
    this._busy = true;
    return true;
  }

  /**
   * Release lock and notify next waiter in FIFO queue
   */
  private release(): void {
    this._busy = false;

    // Notify the first waiter in queue (FIFO)
    if (this.waitQueue.length > 0) {
      const nextWaiter = this.waitQueue.shift();
      nextWaiter?.resolve();
    }
  }

  /**
   * Wait for this worker to become available (FIFO queue)
   */
  async waitForAvailable(): Promise<void> {
    if (this.isAvailable) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.waitQueue.push({ resolve, reject });
    });
  }

  /**
   * Run paraphrase with both modes (Simple -> Shorten)
   */
  async paraphrase(
    text: string,
    requestId?: string,
  ): Promise<ParaphraseResult> {
    if (!this.tryAcquire()) {
      throw new Error(`[${this.accountId}] Worker is busy`);
    }

    try {
      const result = await this.automation.paraphrase(text, requestId);
      this._status = "ready";
      this._lastError = undefined;
      return result;
    } catch (error) {
      this._lastError = error instanceof Error ? error.message : String(error);
      // Don't set status to error here - let it try to recover
      throw error;
    } finally {
      this.release();
    }
  }

  /**
   * Run paraphrase with timeout - for small texts that should complete quickly.
   * On timeout, triggers browser restart in background to recover the stuck worker.
   */
  async paraphraseWithTimeout(
    text: string,
    timeoutMs: number,
    requestId?: string,
  ): Promise<ParaphraseResult> {
    if (!this.tryAcquire()) {
      throw new Error(`[${this.accountId}] Worker is busy`);
    }

    try {
      const operationPromise = this.automation.paraphrase(text, requestId);

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new TimeoutError(
              `[${this.accountId}] Paraphrase timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      });

      const result = await Promise.race([operationPromise, timeoutPromise]);
      this._status = "ready";
      this._lastError = undefined;
      return result;
    } catch (error) {
      this._lastError = error instanceof Error ? error.message : String(error);

      // On timeout, restart browser in background to kill stuck operation
      if (error instanceof TimeoutError) {
        console.log(
          `[${this.accountId}] Timeout detected, restarting browser in background...`,
        );
        // Don't await - let it restart while we try fallback
        this.restart().catch((restartErr) => {
          console.error(
            `[${this.accountId}] Background restart failed:`,
            restartErr,
          );
        });
      }

      throw error;
    } finally {
      this.release();
    }
  }

  /**
   * Run paraphrase with standard mode only
   */
  async paraphraseStandardMode(
    text: string,
    requestId?: string,
  ): Promise<string> {
    if (!this.tryAcquire()) {
      throw new Error(`[${this.accountId}] Worker is busy`);
    }

    try {
      const result = await this.automation.paraphraseStandardMode(
        text,
        requestId,
      );
      this._status = "ready";
      this._lastError = undefined;
      return result;
    } catch (error) {
      this._lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.release();
    }
  }

  /**
   * Force restart this worker's browser
   */
  async restart(): Promise<void> {
    console.log(`[${this.accountId}] Restarting worker...`);
    this._status = "initializing";
    await this.automation.dispose();
    await this.automation.init();
    this._status = "ready";
    this._lastError = undefined;
    console.log(`[${this.accountId}] Worker restarted successfully`);
  }

  /**
   * Save cookies for session persistence
   */
  async saveCookies(): Promise<void> {
    await this.automation.saveCookies();
  }
}
