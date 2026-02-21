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
  accountUsed?: string;
  attempts?: number;
  queueWaitMs?: number;
  processingMs?: number;
  errorCode?: string;
  fallbackChain?: string[];
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface AccountWorkerSnapshot {
  accountId: string;
  status: AccountStatus;
  lastError?: string;
  isBusy: boolean;
  isAvailable: boolean;
  waitQueueDepth: number;
  restartCount: number;
}

export class AccountWorker {
  private automation: QuillBotAutomation;
  private _status: AccountStatus = "initializing";
  private _lastError?: string;
  private _busy: boolean = false;

  // FIFO fallback queue management (head index avoids O(n) Array.shift reindexing)
  private waitQueue: Array<Waiter | undefined> = [];
  private waitQueueHead = 0;

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

  get waitQueueDepth(): number {
    return this.waitQueue.length - this.waitQueueHead;
  }

  get restartCount(): number {
    return this.automation.restartCount;
  }

  getSnapshot(): AccountWorkerSnapshot {
    return {
      accountId: this.accountId,
      status: this._status,
      lastError: this._lastError,
      isBusy: this._busy,
      isAvailable: this.isAvailable,
      waitQueueDepth: this.waitQueueDepth,
      restartCount: this.restartCount,
    };
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
    this.rejectAllWaiters(new Error("Worker disposed"));
  }

  /**
   * Acquire lock for this worker. Returns true if acquired, false if busy.
   */
  private tryAcquire(): boolean {
    if (this._busy || this._status !== "ready") {
      return false;
    }
    this._busy = true;
    this._status = "busy";
    return true;
  }

  /**
   * Release lock and notify next waiter in FIFO queue
   */
  private release(): void {
    this._busy = false;
    if (this._status === "busy") {
      this._status = "ready";
    }

    // Notify the first waiter in queue (FIFO)
    this.dequeueWaiter()?.resolve();
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

  private dequeueWaiter(): Waiter | undefined {
    if (this.waitQueueHead >= this.waitQueue.length) {
      return undefined;
    }

    const waiter = this.waitQueue[this.waitQueueHead];
    this.waitQueue[this.waitQueueHead] = undefined;
    this.waitQueueHead += 1;

    // Compact periodically so the backing array doesn't grow unbounded.
    if (this.waitQueueHead > 64 && this.waitQueueHead * 2 >= this.waitQueue.length) {
      this.waitQueue = this.waitQueue.slice(this.waitQueueHead);
      this.waitQueueHead = 0;
    }

    return waiter;
  }

  private rejectAllWaiters(error: Error): void {
    for (let i = this.waitQueueHead; i < this.waitQueue.length; i++) {
      this.waitQueue[i]?.reject(error);
    }
    this.waitQueue = [];
    this.waitQueueHead = 0;
  }

  private async runWithLock<T>(
    operation: () => Promise<T>,
    onError?: (error: unknown) => void,
  ): Promise<T> {
    if (!this.tryAcquire()) {
      throw new Error(`[${this.accountId}] Worker is busy`);
    }

    try {
      const result = await operation();
      this._status = "ready";
      this._lastError = undefined;
      return result;
    } catch (error) {
      this._lastError = error instanceof Error ? error.message : String(error);
      onError?.(error);
      throw error;
    } finally {
      this.release();
    }
  }

  /**
   * Run paraphrase with both modes (Simple -> Shorten)
   */
  async paraphrase(
    text: string,
    requestId?: string,
  ): Promise<ParaphraseResult> {
    return this.runWithLock(() => this.automation.paraphrase(text, requestId));
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
    return this.runWithLock(
      async () => {
        const operationPromise = this.automation.paraphrase(text, requestId);
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new TimeoutError(
                `[${this.accountId}] Paraphrase timed out after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        });

        try {
          return await Promise.race([operationPromise, timeoutPromise]);
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
      },
      (error) => {
        // On timeout, restart browser in background to kill stuck operation.
        if (error instanceof TimeoutError) {
          console.log(
            `[${this.accountId}] Timeout detected, restarting browser in background...`,
          );
          // Don't await - let it restart while we try fallback.
          this.restart().catch((restartErr) => {
            console.error(
              `[${this.accountId}] Background restart failed:`,
              restartErr,
            );
          });
        }
      },
    );
  }

  /**
   * Run paraphrase with standard mode only
   */
  async paraphraseStandardMode(
    text: string,
    requestId?: string,
  ): Promise<string> {
    return this.runWithLock(() =>
      this.automation.paraphraseStandardMode(text, requestId),
    );
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
