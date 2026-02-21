import { performance } from "node:perf_hooks";
import {
  AccountConfig,
  AccountWorker,
  AccountWorkerResult,
  TimeoutError,
} from "./accountWorker";
import {
  AutomationError,
  AutomationErrorCode,
} from "./quillbotAutomation";

const ACCOUNT_IDS = ["acc1", "acc2", "acc3"] as const;
type AccountId = (typeof ACCOUNT_IDS)[number];

const SMALL_TEXT_MAX_WORDS = 300;
const SMALL_TEXT_TIMEOUT_MS = 50000;

const HEALTH_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const TRIPPED_COOLDOWN_MS = 90 * 1000;
const HEALTH_TO_DEGRADED_FAILURES = 2;
const HEALTH_TO_TRIPPED_FAILURES = 4;
const DEGRADED_TO_HEALTHY_SUCCESSES = 6;

const EWMA_ALPHA = 0.2;
const FALLBACK_WAIT_TIMEOUT_MS = 12000;
const JITTER_MIN_MS = 100;
const JITTER_MAX_MS = 300;

const MODE_TARGET_SECONDS: Record<ParaphraseMode, number> = {
  dual: 18,
  standard: 9,
  ludicrous: 7,
};

const MODE_BUDGET_BOUNDS: Record<
  ParaphraseMode,
  { min: number; max: number; initial: number }
> = {
  dual: { min: 280, max: 760, initial: 520 },
  standard: { min: 500, max: 1400, initial: 950 },
  ludicrous: { min: 700, max: 2000, initial: 1300 },
};

const MODE_BASE_COOLDOWN_MS: Record<ParaphraseMode, number> = {
  dual: 1200,
  standard: 600,
  ludicrous: 250,
};

const HEALTH_PENALTY_MS: Record<SchedulerHealthState, number> = {
  healthy: 0,
  degraded: 1500,
  tripped: 120000,
};

const COOLDOWN_PROFILE_MULTIPLIER: Record<CooldownProfile, number> = {
  balanced: 1,
  max_speed: 0.6,
  max_stability: 1.6,
};

interface WorkerOutput {
  result?: string;
  firstMode?: string;
  secondMode?: string;
}

interface SlotRequest {
  slotKey: AccountId;
  text: string;
  words: number;
}

interface SlotPlan {
  slot: SlotRequest;
  primaryAccount: AccountId;
  candidateOrder: AccountId[];
}

interface SlotAttemptResult {
  accountId: AccountId;
  output: WorkerOutput;
  queueWaitMs: number;
  processingMs: number;
  durationMs: number;
}

interface ModeRuntime {
  ewmaWordsPerSecond: number;
  ewmaSuccessRate: number;
  ewmaRetryRate: number;
  ewmaTimeoutRate: number;
  noThrottleSuccessCount: number;
  sampleCount: number;
}

type SchedulerHealthState = "healthy" | "degraded" | "tripped";
type CooldownProfile = "balanced" | "max_speed" | "max_stability";

interface AccountRuntime {
  health: SchedulerHealthState;
  trippedUntil: number;
  failureTimestamps: number[];
  consecutiveSuccesses: number;
  pendingLoadMs: number;
  activeJobs: number;
  cooldownUntilByMode: Record<ParaphraseMode, number>;
  dynamicCooldownByMode: Record<ParaphraseMode, number>;
  modeStats: Record<ParaphraseMode, ModeRuntime>;
  totalAttempts: number;
  totalSuccess: number;
  totalTimeouts: number;
  totalRetries: number;
  totalFallbacks: number;
  lastObservedRestartCount: number;
}

interface RollingRecord {
  endedAt: number;
  durationMs: number;
  words: number;
  success: boolean;
  usedFallback: boolean;
  attempts: number;
  errorCode?: AutomationErrorCode;
}

export type ParaphraseMode = "dual" | "standard" | "ludicrous";

export interface BatchRequest {
  acc1?: string;
  acc2?: string;
  acc3?: string;
  mode?: ParaphraseMode;
  strict?: boolean;
  requestId?: string;
}

export interface BatchMeta {
  requestId: string;
  mode: ParaphraseMode;
  strict: boolean;
  totalSlots: number;
  successSlots: number;
  failedSlots: number;
  fallbackSlots: number;
  totalAttempts: number;
  totalWords: number;
  durationMs: number;
}

export interface BatchResponse {
  acc1?: AccountWorkerResult;
  acc2?: AccountWorkerResult;
  acc3?: AccountWorkerResult;
  meta?: BatchMeta;
}

export interface SchedulerAccountStatus {
  health: SchedulerHealthState;
  cooldownMsDual: number;
  cooldownMsStandard: number;
  cooldownMsLudicrous: number;
  pendingLoadMs: number;
  activeJobs: number;
  waitQueueDepth: number;
  ewmaWordsPerSecondDual: number;
  ewmaWordsPerSecondStandard: number;
  ewmaWordsPerSecondLudicrous: number;
  successRateDual: number;
  successRateStandard: number;
  successRateLudicrous: number;
  retryRateDual: number;
  retryRateStandard: number;
  retryRateLudicrous: number;
  timeoutRateDual: number;
  timeoutRateStandard: number;
  timeoutRateLudicrous: number;
  trippedUntil: number | null;
  restartCount: number;
}

export interface SchedulerRecommendedBudgets {
  dual: number;
  standard: number;
  ludicrous: number;
  perAccount: Record<AccountId, { dual: number; standard: number; ludicrous: number }>;
}

export interface SchedulerRollingStats {
  throughputWordsPerMinute: number;
  successRatio: number;
  p50DurationMs: number;
  p95DurationMs: number;
  fallbackRate: number;
  restartRatePerMinute: number;
}

export interface SchedulerStatus {
  adaptiveEnabled: boolean;
  cooldownProfile: CooldownProfile;
  accounts: Record<AccountId, SchedulerAccountStatus>;
  recommendedBudgets: SchedulerRecommendedBudgets;
  rolling: SchedulerRollingStats;
}

export interface PoolStatus {
  acc1: { status: string; lastError?: string };
  acc2: { status: string; lastError?: string };
  acc3: { status: string; lastError?: string };
  ready: boolean;
  scheduler: SchedulerStatus;
}

export interface AccountPoolOptions {
  schedulerAdaptive?: boolean;
  strictModeDefault?: boolean;
  cooldownProfile?: CooldownProfile;
}

export class StrictBatchError extends Error {
  constructor(public readonly payload: BatchResponse) {
    super("Strict batch failed: one or more slots could not be processed");
    this.name = "StrictBatchError";
  }
}

class AttemptExecutionError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly queueWaitMs: number,
    public readonly processingMs: number,
    public readonly durationMs: number,
  ) {
    super(
      originalError instanceof Error ? originalError.message : String(originalError),
    );
    this.name = "AttemptExecutionError";
  }
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function ewma(current: number, next: number): number {
  return current + EWMA_ALPHA * (next - current);
}

function quantile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const index = Math.max(
    0,
    Math.min(sortedValues.length - 1, Math.ceil(percentile * sortedValues.length) - 1),
  );

  return sortedValues[index];
}

function getWordCount(text: string): number {
  const matcher = /\S+/g;
  let count = 0;
  while (matcher.exec(text) !== null) {
    count += 1;
  }
  return count;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AccountPool {
  private readonly workers: Record<AccountId, AccountWorker>;
  private readonly runtime: Record<AccountId, AccountRuntime>;
  private readonly adaptiveEnabled: boolean;
  private readonly strictModeDefault: boolean;
  private readonly cooldownProfile: CooldownProfile;
  private _isReady = false;

  private rollingRecords: RollingRecord[] = [];
  private restartEvents: number[] = [];

  constructor(
    private readonly accounts: AccountConfig[],
    private readonly headless: boolean = true,
    options: AccountPoolOptions = {},
  ) {
    if (accounts.length !== ACCOUNT_IDS.length) {
      throw new Error("AccountPool requires exactly 3 accounts");
    }

    this.adaptiveEnabled = options.schedulerAdaptive ?? true;
    this.strictModeDefault = options.strictModeDefault ?? false;
    this.cooldownProfile = options.cooldownProfile ?? "balanced";

    this.workers = {
      acc1: new AccountWorker("acc1", accounts[0], headless),
      acc2: new AccountWorker("acc2", accounts[1], headless),
      acc3: new AccountWorker("acc3", accounts[2], headless),
    };

    this.runtime = {
      acc1: this.createInitialRuntime("acc1"),
      acc2: this.createInitialRuntime("acc2"),
      acc3: this.createInitialRuntime("acc3"),
    };
  }

  get isReady(): boolean {
    return this._isReady;
  }

  private createInitialModeRuntime(mode: ParaphraseMode): ModeRuntime {
    const initialWords = MODE_BUDGET_BOUNDS[mode].initial;
    const targetSeconds = MODE_TARGET_SECONDS[mode];

    return {
      ewmaWordsPerSecond: initialWords / targetSeconds,
      ewmaSuccessRate: 0.99,
      ewmaRetryRate: 0.02,
      ewmaTimeoutRate: 0.01,
      noThrottleSuccessCount: 0,
      sampleCount: 0,
    };
  }

  private createInitialRuntime(accountId: AccountId): AccountRuntime {
    const worker = this.workers[accountId];

    return {
      health: "healthy",
      trippedUntil: 0,
      failureTimestamps: [],
      consecutiveSuccesses: 0,
      pendingLoadMs: 0,
      activeJobs: 0,
      cooldownUntilByMode: {
        dual: 0,
        standard: 0,
        ludicrous: 0,
      },
      dynamicCooldownByMode: {
        dual: this.baseCooldownMs("dual"),
        standard: this.baseCooldownMs("standard"),
        ludicrous: this.baseCooldownMs("ludicrous"),
      },
      modeStats: {
        dual: this.createInitialModeRuntime("dual"),
        standard: this.createInitialModeRuntime("standard"),
        ludicrous: this.createInitialModeRuntime("ludicrous"),
      },
      totalAttempts: 0,
      totalSuccess: 0,
      totalTimeouts: 0,
      totalRetries: 0,
      totalFallbacks: 0,
      lastObservedRestartCount: worker.restartCount,
    };
  }

  private baseCooldownMs(mode: ParaphraseMode): number {
    const multiplier = COOLDOWN_PROFILE_MULTIPLIER[this.cooldownProfile];
    return Math.round(MODE_BASE_COOLDOWN_MS[mode] * multiplier);
  }

  private normalizeRequestId(value: string | undefined): string {
    if (!value) {
      return `batch-${Date.now()}`;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : `batch-${Date.now()}`;
  }

  private normalizeFailureWindow(runtime: AccountRuntime, now: number): void {
    const minTimestamp = now - HEALTH_FAILURE_WINDOW_MS;
    runtime.failureTimestamps = runtime.failureTimestamps.filter(
      (timestamp) => timestamp >= minTimestamp,
    );
  }

  private classifyErrorCode(error: unknown): AutomationErrorCode {
    if (error instanceof TimeoutError) {
      return "E_TIMEOUT";
    }

    if (error instanceof AutomationError) {
      return error.code;
    }

    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

    if (
      message.includes("tripped until") ||
      message.includes("waitforavailable timed out")
    ) {
      return "E_THROTTLED";
    }

    if (
      message.includes("worker is initializing") ||
      message.includes("worker is in error state")
    ) {
      return "E_RESTART_FAILED";
    }

    if (
      message.includes("rate limit") ||
      message.includes("too many") ||
      message.includes("429") ||
      message.includes("just a moment") ||
      message.includes("throttle") ||
      message.includes("temporarily unavailable")
    ) {
      return "E_THROTTLED";
    }

    if (message.includes("selector") || message.includes("unable to find selectors")) {
      return "E_SELECTOR_MISS";
    }

    if (message.includes("modal")) {
      return "E_MODAL_BLOCK";
    }

    if (
      message.includes("browser has been closed") ||
      message.includes("target closed") ||
      message.includes("session closed") ||
      message.includes("protocol error") ||
      message.includes("connection closed") ||
      message.includes("page closed")
    ) {
      return "E_BROWSER_CRASH";
    }

    if (message.includes("restart") && message.includes("failed")) {
      return "E_RESTART_FAILED";
    }

    return "E_UNKNOWN";
  }

  private getUnavailableReason(accountId: AccountId): string | null {
    const worker = this.workers[accountId];
    const runtime = this.runtime[accountId];
    const now = Date.now();

    if (runtime.health === "tripped" && now < runtime.trippedUntil) {
      return `[${accountId}] Account is tripped until ${new Date(runtime.trippedUntil).toISOString()}`;
    }

    if (worker.status === "initializing") {
      return `[${accountId}] Worker is initializing`;
    }

    if (worker.status === "error") {
      return `[${accountId}] Worker is in error state`;
    }

    return null;
  }

  private shouldUpdateHealthOnFailure(errorMessage: string): boolean {
    const lowered = errorMessage.toLowerCase();
    if (lowered.includes("tripped until")) return false;
    if (lowered.includes("worker is initializing")) return false;
    if (lowered.includes("worker is in error state")) return false;
    if (lowered.includes("waitforavailable timed out")) return false;
    return true;
  }

  private isRetryableFailure(errorMessage: string): boolean {
    const lowered = errorMessage.toLowerCase();
    if (lowered.includes("tripped until")) return false;
    if (lowered.includes("worker is initializing")) return false;
    if (lowered.includes("worker is in error state")) return false;
    if (lowered.includes("waitforavailable timed out")) return false;
    return true;
  }

  private shouldUseTimeout(words: number, mode: ParaphraseMode): boolean {
    return mode === "dual" && words <= SMALL_TEXT_MAX_WORDS;
  }

  private estimateDurationMs(
    accountId: AccountId,
    words: number,
    mode: ParaphraseMode,
  ): number {
    const runtime = this.runtime[accountId];
    const wordsPerSecond = clamp(runtime.modeStats[mode].ewmaWordsPerSecond, 1, 1000);
    const durationMs = (words / wordsPerSecond) * 1000;
    return clamp(Math.round(durationMs), 1500, 120000);
  }

  private scoreAccount(
    accountId: AccountId,
    words: number,
    mode: ParaphraseMode,
    now: number,
    reservedPending: Record<AccountId, number>,
  ): number {
    const worker = this.workers[accountId];
    const runtime = this.runtime[accountId];

    if (worker.status === "error" || worker.status === "initializing") {
      return Number.MAX_SAFE_INTEGER / 2;
    }

    const predictedDurationMs = this.estimateDurationMs(accountId, words, mode);
    const queuePenalty =
      reservedPending[accountId] + runtime.pendingLoadMs + worker.waitQueueDepth * predictedDurationMs;
    const cooldownPenalty = Math.max(0, runtime.cooldownUntilByMode[mode] - now);

    let healthPenalty = HEALTH_PENALTY_MS[runtime.health];
    if (runtime.health === "tripped" && now < runtime.trippedUntil) {
      healthPenalty += runtime.trippedUntil - now;
    }

    return predictedDurationMs + queuePenalty + cooldownPenalty + healthPenalty;
  }

  private buildAdaptivePlans(
    slots: SlotRequest[],
    mode: ParaphraseMode,
  ): SlotPlan[] {
    const now = Date.now();
    const reservedPending: Record<AccountId, number> = {
      acc1: 0,
      acc2: 0,
      acc3: 0,
    };

    const sortedByWeight = [...slots].sort((a, b) => b.words - a.words);
    const planBySlot = new Map<AccountId, SlotPlan>();

    for (const slot of sortedByWeight) {
      const scoredAccounts = ACCOUNT_IDS.map((accountId) => ({
        accountId,
        score: this.scoreAccount(accountId, slot.words, mode, now, reservedPending),
      })).sort((a, b) => a.score - b.score);

      const candidateOrder = scoredAccounts.map((entry) => entry.accountId);
      const primaryAccount = candidateOrder[0];

      reservedPending[primaryAccount] += this.estimateDurationMs(
        primaryAccount,
        slot.words,
        mode,
      );

      planBySlot.set(slot.slotKey, {
        slot,
        primaryAccount,
        candidateOrder,
      });
    }

    return slots.map((slot) => {
      const plan = planBySlot.get(slot.slotKey);
      if (!plan) {
        throw new Error(`Missing adaptive plan for slot ${slot.slotKey}`);
      }
      return plan;
    });
  }

  private buildStaticPlans(slots: SlotRequest[]): SlotPlan[] {
    return slots.map((slot) => {
      const candidateOrder = [
        slot.slotKey,
        ...ACCOUNT_IDS.filter((accountId) => accountId !== slot.slotKey),
      ];

      return {
        slot,
        primaryAccount: slot.slotKey,
        candidateOrder,
      };
    });
  }

  private buildExecutionPlans(
    slots: SlotRequest[],
    mode: ParaphraseMode,
  ): SlotPlan[] {
    if (!this.adaptiveEnabled) {
      return this.buildStaticPlans(slots);
    }

    return this.buildAdaptivePlans(slots, mode);
  }

  private async waitForWorkerAvailability(
    accountId: AccountId,
    mode: ParaphraseMode,
  ): Promise<void> {
    const worker = this.workers[accountId];
    const runtime = this.runtime[accountId];
    const unavailableReason = this.getUnavailableReason(accountId);
    if (unavailableReason) {
      throw new Error(unavailableReason);
    }

    if (!worker.isAvailable) {
      await Promise.race([
        worker.waitForAvailable(),
        delay(FALLBACK_WAIT_TIMEOUT_MS).then(() => {
          throw new TimeoutError(
            `[${accountId}] waitForAvailable timed out after ${FALLBACK_WAIT_TIMEOUT_MS}ms`,
          );
        }),
      ]);
    }

    const unavailableAfterWait = this.getUnavailableReason(accountId);
    if (unavailableAfterWait) {
      throw new Error(unavailableAfterWait);
    }

    const cooldownWaitMs = Math.max(0, runtime.cooldownUntilByMode[mode] - Date.now());
    if (cooldownWaitMs > 0) {
      await delay(cooldownWaitMs);
    }

    const jitter = Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1)) + JITTER_MIN_MS;
    await delay(jitter);
  }

  private resetRuntimeAfterRestart(accountId: AccountId): void {
    const runtime = this.runtime[accountId];
    runtime.health = "healthy";
    runtime.trippedUntil = 0;
    runtime.failureTimestamps = [];
    runtime.consecutiveSuccesses = 0;
    runtime.pendingLoadMs = 0;
    runtime.activeJobs = 0;
    runtime.cooldownUntilByMode = {
      dual: 0,
      standard: 0,
      ludicrous: 0,
    };
    runtime.dynamicCooldownByMode = {
      dual: this.baseCooldownMs("dual"),
      standard: this.baseCooldownMs("standard"),
      ludicrous: this.baseCooldownMs("ludicrous"),
    };
  }

  private updateCooldownOnFailure(
    accountId: AccountId,
    mode: ParaphraseMode,
    errorCode: AutomationErrorCode,
  ): void {
    const runtime = this.runtime[accountId];
    const base = this.baseCooldownMs(mode);
    const isSoftThrottle = errorCode === "E_THROTTLED";
    const penalty = isSoftThrottle ? 1200 : 3000;
    const nextDynamic = Math.max(
      base,
      runtime.dynamicCooldownByMode[mode] + penalty,
    );

    runtime.dynamicCooldownByMode[mode] = nextDynamic;
    runtime.cooldownUntilByMode[mode] = Math.max(
      runtime.cooldownUntilByMode[mode],
      Date.now() + nextDynamic,
    );
  }

  private updateCooldownOnSuccess(accountId: AccountId, mode: ParaphraseMode): void {
    const runtime = this.runtime[accountId];
    const base = this.baseCooldownMs(mode);

    if (runtime.consecutiveSuccesses > 0 && runtime.consecutiveSuccesses % 3 === 0) {
      runtime.dynamicCooldownByMode[mode] = Math.max(
        base,
        runtime.dynamicCooldownByMode[mode] - 300,
      );
    }

    runtime.cooldownUntilByMode[mode] = Math.max(
      runtime.cooldownUntilByMode[mode],
      Date.now() + runtime.dynamicCooldownByMode[mode],
    );
  }

  private updateHealthOnFailure(
    accountId: AccountId,
    mode: ParaphraseMode,
    errorCode: AutomationErrorCode,
  ): void {
    const now = Date.now();
    const runtime = this.runtime[accountId];
    runtime.failureTimestamps.push(now);
    runtime.consecutiveSuccesses = 0;
    runtime.totalAttempts += 1;
    if (errorCode === "E_TIMEOUT") {
      runtime.totalTimeouts += 1;
    }

    this.normalizeFailureWindow(runtime, now);

    if (
      runtime.health === "healthy" &&
      runtime.failureTimestamps.length >= HEALTH_TO_DEGRADED_FAILURES
    ) {
      runtime.health = "degraded";
    }

    if (runtime.failureTimestamps.length >= HEALTH_TO_TRIPPED_FAILURES) {
      runtime.health = "tripped";
      runtime.trippedUntil = now + TRIPPED_COOLDOWN_MS;
      runtime.consecutiveSuccesses = 0;
    }

    const modeRuntime = runtime.modeStats[mode];
    modeRuntime.ewmaSuccessRate = ewma(modeRuntime.ewmaSuccessRate, 0);
    modeRuntime.ewmaTimeoutRate = ewma(
      modeRuntime.ewmaTimeoutRate,
      errorCode === "E_TIMEOUT" ? 1 : 0,
    );
    modeRuntime.noThrottleSuccessCount = 0;
    modeRuntime.sampleCount += 1;

    this.updateCooldownOnFailure(accountId, mode, errorCode);
  }

  private updateHealthOnSuccess(
    accountId: AccountId,
    mode: ParaphraseMode,
    words: number,
    processingMs: number,
    hadRetry: boolean,
    usedFallback: boolean,
  ): void {
    const now = Date.now();
    const runtime = this.runtime[accountId];
    runtime.totalAttempts += 1;
    runtime.totalSuccess += 1;
    if (hadRetry) {
      runtime.totalRetries += 1;
    }
    if (usedFallback) {
      runtime.totalFallbacks += 1;
    }

    this.normalizeFailureWindow(runtime, now);

    if (runtime.health === "tripped") {
      if (now >= runtime.trippedUntil) {
        runtime.health = "degraded";
      }
    }

    runtime.consecutiveSuccesses += 1;
    if (
      runtime.health === "degraded" &&
      runtime.consecutiveSuccesses >= DEGRADED_TO_HEALTHY_SUCCESSES
    ) {
      runtime.health = "healthy";
      runtime.failureTimestamps = [];
    }

    const modeRuntime = runtime.modeStats[mode];
    const durationSec = Math.max(0.001, processingMs / 1000);
    const wordsPerSecond = words / durationSec;

    modeRuntime.ewmaWordsPerSecond = ewma(modeRuntime.ewmaWordsPerSecond, wordsPerSecond);
    modeRuntime.ewmaSuccessRate = ewma(modeRuntime.ewmaSuccessRate, 1);
    modeRuntime.ewmaTimeoutRate = ewma(modeRuntime.ewmaTimeoutRate, 0);
    modeRuntime.ewmaRetryRate = ewma(modeRuntime.ewmaRetryRate, hadRetry ? 1 : 0);
    modeRuntime.noThrottleSuccessCount += 1;
    modeRuntime.sampleCount += 1;

    this.updateCooldownOnSuccess(accountId, mode);
  }

  private invokeWorker(
    worker: AccountWorker,
    text: string,
    mode: ParaphraseMode,
    requestId: string,
    useTimeout: boolean,
  ): Promise<WorkerOutput> {
    if (mode !== "dual") {
      return worker.paraphraseStandardMode(text, requestId).then((result) => ({
        result,
      }));
    }

    const run = useTimeout
      ? worker.paraphraseWithTimeout(text, SMALL_TEXT_TIMEOUT_MS, requestId)
      : worker.paraphrase(text, requestId);

    return run.then((result) => ({
      firstMode: result.firstMode,
      secondMode: result.secondMode,
    }));
  }

  private reservePendingLoad(
    accountId: AccountId,
    words: number,
    mode: ParaphraseMode,
  ): number {
    const predicted = this.estimateDurationMs(accountId, words, mode);
    const runtime = this.runtime[accountId];
    runtime.pendingLoadMs += predicted;
    runtime.activeJobs += 1;
    return predicted;
  }

  private releasePendingLoad(accountId: AccountId, reservedMs: number): void {
    const runtime = this.runtime[accountId];
    runtime.pendingLoadMs = Math.max(0, runtime.pendingLoadMs - reservedMs);
    runtime.activeJobs = Math.max(0, runtime.activeJobs - 1);
  }

  private shouldTreatAsFallback(primaryAccount: AccountId, usedAccount: AccountId): boolean {
    return primaryAccount !== usedAccount;
  }

  private trackRestartDelta(accountId: AccountId): void {
    const runtime = this.runtime[accountId];
    const current = this.workers[accountId].restartCount;
    if (current <= runtime.lastObservedRestartCount) {
      return;
    }

    const delta = current - runtime.lastObservedRestartCount;
    runtime.lastObservedRestartCount = current;

    const now = Date.now();
    for (let i = 0; i < delta; i++) {
      this.restartEvents.push(now);
    }
  }

  private logSlotEvent(payload: Record<string, unknown>): void {
    console.log(JSON.stringify({ event: "slot_result", ...payload }));
  }

  private mapOutputToResult(
    output: WorkerOutput,
    durationMs: number,
  ): AccountWorkerResult {
    const result: AccountWorkerResult = { durationMs };

    if (output.result !== undefined) {
      result.result = output.result;
    }

    if (output.firstMode !== undefined) {
      result.firstMode = output.firstMode;
    }

    if (output.secondMode !== undefined) {
      result.secondMode = output.secondMode;
    }

    return result;
  }

  private async executeAttempt(
    accountId: AccountId,
    text: string,
    words: number,
    mode: ParaphraseMode,
    attemptRequestId: string,
  ): Promise<SlotAttemptResult> {
    const worker = this.workers[accountId];
    const useTimeout = this.shouldUseTimeout(words, mode);

    const attemptStart = performance.now();
    const queueWaitStart = performance.now();

    await this.waitForWorkerAvailability(accountId, mode);

    const queueWaitMs = Math.round(performance.now() - queueWaitStart);

    const reservedMs = this.reservePendingLoad(accountId, words, mode);

    const processingStart = performance.now();
    try {
      const output = await this.invokeWorker(
        worker,
        text,
        mode,
        attemptRequestId,
        useTimeout,
      );
      const processingMs = Math.round(performance.now() - processingStart);
      const durationMs = Math.round(performance.now() - attemptStart);

      return {
        accountId,
        output,
        queueWaitMs,
        processingMs,
        durationMs,
      };
    } catch (error) {
      const processingMs = Math.round(performance.now() - processingStart);
      const durationMs = Math.round(performance.now() - attemptStart);
      throw new AttemptExecutionError(
        error,
        queueWaitMs,
        processingMs,
        durationMs,
      );
    } finally {
      this.releasePendingLoad(accountId, reservedMs);
      this.trackRestartDelta(accountId);
    }
  }

  private addRollingRecord(record: RollingRecord): void {
    this.rollingRecords.push(record);
    if (this.rollingRecords.length > 1000) {
      this.rollingRecords = this.rollingRecords.slice(this.rollingRecords.length - 1000);
    }

    const minRollingTime = Date.now() - HEALTH_FAILURE_WINDOW_MS;
    this.rollingRecords = this.rollingRecords.filter((item) => item.endedAt >= minRollingTime);
    this.restartEvents = this.restartEvents.filter((item) => item >= minRollingTime);
  }

  private async executeSlotPlan(
    plan: SlotPlan,
    mode: ParaphraseMode,
    requestId: string,
  ): Promise<AccountWorkerResult> {
    const { slot, primaryAccount } = plan;
    const words = slot.words;

    const dedupedCandidates: AccountId[] = [];
    for (const accountId of plan.candidateOrder) {
      if (!dedupedCandidates.includes(accountId)) {
        dedupedCandidates.push(accountId);
      }
    }

    let attempts = 0;
    let queueWaitMs = 0;
    let processingMs = 0;
    let fallbackUsed: string | undefined;
    const fallbackChain: string[] = [];
    let lastErrorMessage = "Unknown error";
    let lastErrorCode: AutomationErrorCode = "E_UNKNOWN";

    const slotStart = performance.now();

    for (let candidateIndex = 0; candidateIndex < dedupedCandidates.length; candidateIndex++) {
      const accountId = dedupedCandidates[candidateIndex];
      const unavailableReason = this.getUnavailableReason(accountId);
      if (unavailableReason) {
        lastErrorMessage = unavailableReason;
        lastErrorCode = this.classifyErrorCode(unavailableReason);

        this.logSlotEvent({
          requestId,
          slotKey: slot.slotKey,
          accountUsed: accountId,
          mode,
          words,
          queueWaitMs,
          processingMs,
          attempts,
          fallbackChain,
          outcome: "attempt_skipped",
          errorCode: lastErrorCode,
          error: unavailableReason,
        });
        continue;
      }

      const localRetryCount = candidateIndex === 0 ? 2 : 1;

      for (let localRetry = 0; localRetry < localRetryCount; localRetry++) {
        attempts += 1;
        const attemptRequestId = `${requestId}-${slot.slotKey}-attempt-${attempts}-${accountId}`;

        try {
          const attempt = await this.executeAttempt(
            accountId,
            slot.text,
            words,
            mode,
            attemptRequestId,
          );

          queueWaitMs += attempt.queueWaitMs;
          processingMs += attempt.processingMs;

          const usedFallback = this.shouldTreatAsFallback(primaryAccount, accountId);
          if (usedFallback) {
            fallbackUsed = accountId;
            fallbackChain.push(accountId);
          }

          this.updateHealthOnSuccess(
            accountId,
            mode,
            words,
            attempt.processingMs,
            attempts > 1,
            usedFallback,
          );

          const totalDurationMs = Math.round(performance.now() - slotStart);
          const result = this.mapOutputToResult(attempt.output, totalDurationMs);
          result.accountUsed = accountId;
          result.attempts = attempts;
          result.queueWaitMs = queueWaitMs;
          result.processingMs = processingMs;
          result.errorCode = undefined;

          if (fallbackUsed) {
            result.fallbackUsed = fallbackUsed;
            result.fallbackChain = fallbackChain;
          }

          this.logSlotEvent({
            requestId,
            slotKey: slot.slotKey,
            accountUsed: accountId,
            mode,
            words,
            queueWaitMs,
            processingMs,
            attempts,
            fallbackChain,
            outcome: "success",
            errorCode: null,
          });

          this.addRollingRecord({
            endedAt: Date.now(),
            durationMs: totalDurationMs,
            words,
            success: true,
            usedFallback,
            attempts,
          });

          return result;
        } catch (error) {
          const attemptError =
            error instanceof AttemptExecutionError ? error : undefined;
          const actualError = attemptError?.originalError ?? error;
          const errorCode = this.classifyErrorCode(actualError);
          const message =
            actualError instanceof Error ? actualError.message : String(actualError);
          lastErrorMessage = message;
          lastErrorCode = errorCode;

          if (attemptError) {
            queueWaitMs += attemptError.queueWaitMs;
            processingMs += attemptError.processingMs;
          }

          if (this.shouldUpdateHealthOnFailure(message)) {
            this.updateHealthOnFailure(accountId, mode, errorCode);
          }

          if (errorCode === "E_THROTTLED") {
            this.runtime[accountId].modeStats[mode].noThrottleSuccessCount = 0;
          }

          this.logSlotEvent({
            requestId,
            slotKey: slot.slotKey,
            accountUsed: accountId,
            mode,
            words,
            queueWaitMs,
            processingMs,
            attempts,
            fallbackChain,
            outcome: "attempt_failed",
            errorCode,
            error: message,
          });

          if (!this.isRetryableFailure(message)) {
            break;
          }
        }
      }
    }

    const totalDurationMs = Math.round(performance.now() - slotStart);
    const failureResult: AccountWorkerResult = {
      durationMs: totalDurationMs,
      error: lastErrorMessage,
      accountUsed: primaryAccount,
      attempts,
      queueWaitMs,
      processingMs,
      errorCode: lastErrorCode,
    };

    if (fallbackUsed) {
      failureResult.fallbackUsed = fallbackUsed;
      failureResult.fallbackChain = fallbackChain;
    }

    this.addRollingRecord({
      endedAt: Date.now(),
      durationMs: totalDurationMs,
      words,
      success: false,
      usedFallback: fallbackChain.length > 0,
      attempts,
      errorCode: lastErrorCode,
    });

    this.logSlotEvent({
      requestId,
      slotKey: slot.slotKey,
      accountUsed: primaryAccount,
      mode,
      words,
      queueWaitMs,
      processingMs,
      attempts,
      fallbackChain,
      outcome: "failed",
      errorCode: lastErrorCode,
      error: lastErrorMessage,
    });

    return failureResult;
  }

  private recommendedBudgetForAccount(
    accountId: AccountId,
    mode: ParaphraseMode,
  ): number {
    const runtime = this.runtime[accountId];
    const modeRuntime = runtime.modeStats[mode];
    const bounds = MODE_BUDGET_BOUNDS[mode];
    const targetSeconds = MODE_TARGET_SECONDS[mode];

    let target = modeRuntime.ewmaWordsPerSecond * targetSeconds;

    if (modeRuntime.ewmaRetryRate > 0.08) {
      target *= 0.85;
    }

    if (
      modeRuntime.ewmaSuccessRate > 0.98 &&
      modeRuntime.noThrottleSuccessCount >= 50
    ) {
      target *= 1.1;
    }

    if (runtime.health === "degraded") {
      target *= 0.75;
    }

    return Math.round(clamp(target, bounds.min, bounds.max));
  }

  private getRecommendedBudgets(): SchedulerRecommendedBudgets {
    const perAccount: Record<AccountId, { dual: number; standard: number; ludicrous: number }> = {
      acc1: {
        dual: this.recommendedBudgetForAccount("acc1", "dual"),
        standard: this.recommendedBudgetForAccount("acc1", "standard"),
        ludicrous: this.recommendedBudgetForAccount("acc1", "ludicrous"),
      },
      acc2: {
        dual: this.recommendedBudgetForAccount("acc2", "dual"),
        standard: this.recommendedBudgetForAccount("acc2", "standard"),
        ludicrous: this.recommendedBudgetForAccount("acc2", "ludicrous"),
      },
      acc3: {
        dual: this.recommendedBudgetForAccount("acc3", "dual"),
        standard: this.recommendedBudgetForAccount("acc3", "standard"),
        ludicrous: this.recommendedBudgetForAccount("acc3", "ludicrous"),
      },
    };

    const dualAverage = Math.round(
      (perAccount.acc1.dual + perAccount.acc2.dual + perAccount.acc3.dual) / 3,
    );
    const standardAverage = Math.round(
      (perAccount.acc1.standard +
        perAccount.acc2.standard +
        perAccount.acc3.standard) /
        3,
    );
    const ludicrousAverage = Math.round(
      (perAccount.acc1.ludicrous +
        perAccount.acc2.ludicrous +
        perAccount.acc3.ludicrous) /
        3,
    );

    return {
      dual: dualAverage,
      standard: standardAverage,
      ludicrous: ludicrousAverage,
      perAccount,
    };
  }

  private getRollingStats(): SchedulerRollingStats {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    const windowRecords = this.rollingRecords;

    const recentMinuteWords = windowRecords
      .filter((record) => record.endedAt >= oneMinuteAgo && record.success)
      .reduce((acc, record) => acc + record.words, 0);

    const successCount = windowRecords.filter((record) => record.success).length;
    const totalCount = windowRecords.length;

    const durations = [...windowRecords]
      .map((record) => record.durationMs)
      .sort((a, b) => a - b);

    const fallbackCount = windowRecords.filter((record) => record.usedFallback).length;
    const restartRate = this.restartEvents.filter((timestamp) => timestamp >= oneMinuteAgo).length;

    return {
      throughputWordsPerMinute: recentMinuteWords,
      successRatio: totalCount === 0 ? 1 : successCount / totalCount,
      p50DurationMs: quantile(durations, 0.5),
      p95DurationMs: quantile(durations, 0.95),
      fallbackRate: totalCount === 0 ? 0 : fallbackCount / totalCount,
      restartRatePerMinute: restartRate,
    };
  }

  private getSchedulerStatus(): SchedulerStatus {
    const now = Date.now();

    const accounts: Record<AccountId, SchedulerAccountStatus> = {
      acc1: this.buildSchedulerAccountStatus("acc1", now),
      acc2: this.buildSchedulerAccountStatus("acc2", now),
      acc3: this.buildSchedulerAccountStatus("acc3", now),
    };

    return {
      adaptiveEnabled: this.adaptiveEnabled,
      cooldownProfile: this.cooldownProfile,
      accounts,
      recommendedBudgets: this.getRecommendedBudgets(),
      rolling: this.getRollingStats(),
    };
  }

  private buildSchedulerAccountStatus(
    accountId: AccountId,
    now: number,
  ): SchedulerAccountStatus {
    const runtime = this.runtime[accountId];
    const worker = this.workers[accountId];

    return {
      health: runtime.health,
      cooldownMsDual: Math.max(0, runtime.cooldownUntilByMode.dual - now),
      cooldownMsStandard: Math.max(0, runtime.cooldownUntilByMode.standard - now),
      cooldownMsLudicrous: Math.max(0, runtime.cooldownUntilByMode.ludicrous - now),
      pendingLoadMs: runtime.pendingLoadMs,
      activeJobs: runtime.activeJobs,
      waitQueueDepth: worker.waitQueueDepth,
      ewmaWordsPerSecondDual: runtime.modeStats.dual.ewmaWordsPerSecond,
      ewmaWordsPerSecondStandard: runtime.modeStats.standard.ewmaWordsPerSecond,
      ewmaWordsPerSecondLudicrous: runtime.modeStats.ludicrous.ewmaWordsPerSecond,
      successRateDual: runtime.modeStats.dual.ewmaSuccessRate,
      successRateStandard: runtime.modeStats.standard.ewmaSuccessRate,
      successRateLudicrous: runtime.modeStats.ludicrous.ewmaSuccessRate,
      retryRateDual: runtime.modeStats.dual.ewmaRetryRate,
      retryRateStandard: runtime.modeStats.standard.ewmaRetryRate,
      retryRateLudicrous: runtime.modeStats.ludicrous.ewmaRetryRate,
      timeoutRateDual: runtime.modeStats.dual.ewmaTimeoutRate,
      timeoutRateStandard: runtime.modeStats.standard.ewmaTimeoutRate,
      timeoutRateLudicrous: runtime.modeStats.ludicrous.ewmaTimeoutRate,
      trippedUntil:
        runtime.health === "tripped" && runtime.trippedUntil > now
          ? runtime.trippedUntil
          : null,
      restartCount: worker.restartCount,
    };
  }

  async initAll(): Promise<void> {
    console.log("Initializing all account workers in parallel...");

    const initPromises: Array<Promise<{ accountId: AccountId; success: boolean }>> = [];

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

    for (const accountId of ACCOUNT_IDS) {
      this.runtime[accountId].lastObservedRestartCount = this.workers[accountId].restartCount;
    }

    console.log(`Account pool ready: ${successCount}/3 workers initialized`);
    this._isReady = true;
  }

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

  getStatus(): PoolStatus {
    const acc1 = this.workers.acc1;
    const acc2 = this.workers.acc2;
    const acc3 = this.workers.acc3;

    return {
      acc1: { status: acc1.status, lastError: acc1.lastError },
      acc2: { status: acc2.status, lastError: acc2.lastError },
      acc3: { status: acc3.status, lastError: acc3.lastError },
      ready: this._isReady,
      scheduler: this.getSchedulerStatus(),
    };
  }

  async processBatch(request: BatchRequest): Promise<BatchResponse> {
    const batchStart = performance.now();
    const requestId = this.normalizeRequestId(request.requestId);
    const mode = request.mode || "dual";
    const strict = request.strict ?? this.strictModeDefault;

    const slots: SlotRequest[] = [];
    if (request.acc1) {
      slots.push({
        slotKey: "acc1",
        text: request.acc1,
        words: getWordCount(request.acc1),
      });
    }
    if (request.acc2) {
      slots.push({
        slotKey: "acc2",
        text: request.acc2,
        words: getWordCount(request.acc2),
      });
    }
    if (request.acc3) {
      slots.push({
        slotKey: "acc3",
        text: request.acc3,
        words: getWordCount(request.acc3),
      });
    }

    if (slots.length === 0) {
      throw new Error("At least one account text must be provided");
    }

    const plans = this.buildExecutionPlans(slots, mode);
    const response: BatchResponse = {};

    const slotPromises = plans.map(async (plan) => {
      const result = await this.executeSlotPlan(plan, mode, requestId);
      response[plan.slot.slotKey] = result;
    });

    await Promise.all(slotPromises);

    const slotResults: AccountWorkerResult[] = [];
    for (const slotKey of ACCOUNT_IDS) {
      const value = response[slotKey];
      if (value) {
        slotResults.push(value);
      }
    }

    let successSlots = 0;
    let failedSlots = 0;
    let fallbackSlots = 0;
    let totalAttempts = 0;
    for (const result of slotResults) {
      if (result.error) {
        failedSlots += 1;
      } else {
        successSlots += 1;
      }
      if (result.fallbackUsed) {
        fallbackSlots += 1;
      }
      totalAttempts += result.attempts || 0;
    }

    const totalWords = slots.reduce((acc, slot) => acc + slot.words, 0);
    const durationMs = Math.round(performance.now() - batchStart);

    response.meta = {
      requestId,
      mode,
      strict,
      totalSlots: slots.length,
      successSlots,
      failedSlots,
      fallbackSlots,
      totalAttempts,
      totalWords,
      durationMs,
    };

    if (strict && failedSlots > 0) {
      throw new StrictBatchError(response);
    }

    return response;
  }

  async restartWorker(accountId: string): Promise<void> {
    if (!this.isAccountId(accountId)) {
      throw new Error(`Account ${accountId} not found`);
    }

    await this.workers[accountId].restart();
    this.resetRuntimeAfterRestart(accountId);
    this.trackRestartDelta(accountId);
  }

  async restartAll(): Promise<void> {
    console.log("Restarting all workers...");
    const restartPromises: Array<Promise<{ accountId: AccountId; success: boolean }>> = [];

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
        this.resetRuntimeAfterRestart(result.accountId);
        this.trackRestartDelta(result.accountId);
      }
    }

    console.log(`Restart complete: ${successCount}/3 workers restarted`);
  }

  private isAccountId(accountId: string): accountId is AccountId {
    return accountId === "acc1" || accountId === "acc2" || accountId === "acc3";
  }
}
