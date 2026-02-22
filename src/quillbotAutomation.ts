import * as fs from "fs";
import * as path from "path";
import puppeteer, {
  Browser,
  CookieParam,
  ElementHandle,
  Page,
} from "puppeteer";

const LOGIN_URL = "https://quillbot.com/login";

// Session persistence paths (configurable via environment variables)
const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";
const PARAPHRASER_URL = "https://quillbot.com/paraphrasing-tool";
const QUILLBOT_ORIGIN = "https://quillbot.com";
const QUILLBOT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const MAX_PARAPHRASE_CLICK_ATTEMPTS = 2;
const PARAPHRASE_START_TIMEOUT_MS = 10000;
const PARAPHRASE_BUTTON_DISCOVERY_TIMEOUT_MS = 4000;
const OUTPUT_SELECTORS = [
  '#paraphraser-output-box [data-testid="pphr/output_box/contenteditable"]',
  "#paraphraser-output-box .ql-editor",
  '#paraphraser-output-box [contenteditable="false"]',
  "#paraphraser-output-box",
  '[data-testid="pphr/output_box"]',
] as const;

const SELECTORS = {
  email: ['input[type="email"]'],
  password: ['input[type="password"]'],
  loginButton: [
    "#loginContainer > div.MuiGrid-root.MuiGrid-container.css-1d3bbye > div.MuiGrid-root.MuiGrid-item.css-koo75d > div.MuiGrid-root.MuiGrid-item.MuiGrid-grid-xs-4.MuiGrid-grid-sm-8.MuiGrid-grid-md-12.css-adow25 > button",
  ],
  closePremiumModal: [
    "body > div.MuiModal-root.MuiDialog-root.css-1056mjz > div.MuiDialog-container.MuiDialog-scrollPaper.css-ekeie0 > div > div.MuiBox-root.css-1q9qc6z > div > button",
  ],
  standardModeTab: ["#Paraphraser-mode-tab-0", "#Paraphraser-mode-tab-0 > div"], // Standard mode
  firstModeTab: ["#Paraphraser-mode-tab-5", "#Paraphraser-mode-tab-5 > div"], // Simple mode
  secondModeTab: ["#Paraphraser-mode-tab-8", "#Paraphraser-mode-tab-8 > div"], // Shorten mode
  inputArea: ["#paraphraser-input-box"],
  clearInputButton: [
    "#paraphraser-input-content > div.MuiBox-root.css-xi6nk4 > button",
  ],
  paraphraseButton: [
    'button[data-testid="pphr/input_footer/paraphrase_button"]',
    '[data-testid="pphr/input_footer/paraphrase_button"]',
    'span[aria-label^="Paraphrase"] button',
    'button[aria-label*="paraphrase" i]',
    '[data-testid*="paraphrase" i]',
    'button[data-testid*="paraphrase" i]',
    'button[class*="paraphrase" i]',
    "#controlledInputBoxContainer > div.MuiBox-root.css-1a43h92 > div > div.MuiBox-root.css-n0jqrr > span > div > button",
    "#controlledInputBoxContainer > div.MuiBox-root.css-1buxzwp > div > div.MuiBox-root.css-1s1ozo1 > span > div > button",
  ],
  copyButton: ['[data-testid="pphr/output_footer/copy_text_button"]'],
  loadingIndicator: [
    ".MuiLoadingButton-loadingIndicator",
    "button[aria-busy='true']",
    "[data-testid='pphr/input_footer/paraphrase_button'] .MuiCircularProgress-root",
  ],
  cookieConsent: [
    "#onetrust-accept-btn-handler",
    "#onetrust-reject-all-handler",
    ".onetrust-close-btn-handler",
  ],
};

export interface ParaphraseResult {
  firstMode: string;
  secondMode: string;
}

export type AutomationErrorCode =
  | "E_TIMEOUT"
  | "E_THROTTLED"
  | "E_SELECTOR_MISS"
  | "E_MODAL_BLOCK"
  | "E_BROWSER_CRASH"
  | "E_RESTART_FAILED"
  | "E_UNKNOWN";

export class AutomationError extends Error {
  constructor(
    public readonly code: AutomationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AutomationError";
  }
}

export interface QuillBotAutomationOptions {
  email: string;
  password: string;
  accountId: string;
  headless?: boolean;
  timeout?: number;
  /** Optional override (ms) for waiting the spinner to disappear. Use 0 for no timeout. */
  loaderWaitTimeout?: number;
}

export class QuillBotAutomation {
  private browser?: Browser;
  private page?: Page;
  private readyPromise?: Promise<void>;
  private taskQueue: Promise<unknown> = Promise.resolve();
  private readonly timeout: number;
  private readonly loaderWaitTimeout: number;
  private readonly cookiesFile: string;
  private cookieConsentHandled = false;
  private browserFailed = false;
  private isRestarting = false;
  private autoRestartCount = 0;
  private readonly criticalFailureCountByContext = new Map<string, number>();

  public readonly accountId: string;

  constructor(private readonly options: QuillBotAutomationOptions) {
    this.timeout = options.timeout ?? 30000;
    this.loaderWaitTimeout = options.loaderWaitTimeout ?? 0;
    this.accountId = options.accountId;
    // Per-account cookie path: sessions/{accountId}/cookies.json
    this.cookiesFile = path.join(
      SESSIONS_DIR,
      options.accountId,
      "cookies.json",
    );
  }

  get restartCount(): number {
    return this.autoRestartCount;
  }

  async init(): Promise<void> {
    // Si el navegador falló previamente, forzar reinicio
    if (this.browserFailed) {
      console.log("Browser in failed state, forcing restart...");
      await this.dispose();
    }

    if (!this.readyPromise) {
      this.readyPromise = this.setup();
    }

    return this.readyPromise;
  }

  async dispose(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
    this.page = undefined;
    this.readyPromise = undefined;
    this.taskQueue = Promise.resolve();
    this.browserFailed = false;
    this.cookieConsentHandled = false;
    this.isRestarting = false;
    this.criticalFailureCountByContext.clear();
  }

  /**
   * Ensures session directories exist for this account
   */
  private ensureDirectoriesExist(): void {
    const accountDir = path.dirname(this.cookiesFile);
    if (!fs.existsSync(accountDir)) {
      fs.mkdirSync(accountDir, { recursive: true });
      console.log(
        `[${this.accountId}] Created sessions directory: ${accountDir}`,
      );
    }
  }

  /**
   * Save cookies to file for session persistence
   */
  async saveCookies(): Promise<void> {
    if (!this.page) {
      console.log(
        `[${this.accountId}] No page available, skipping cookie save`,
      );
      return;
    }

    try {
      const cookies = await this.page.cookies();
      this.ensureDirectoriesExist();
      fs.writeFileSync(this.cookiesFile, JSON.stringify(cookies, null, 2));
      console.log(
        `[${this.accountId}] Saved ${cookies.length} cookies to ${this.cookiesFile}`,
      );
    } catch (error) {
      console.error(`[${this.accountId}] Failed to save cookies:`, error);
    }
  }

  /**
   * Load cookies from file if they exist
   * @returns true if cookies were loaded successfully
   */
  async loadCookies(): Promise<boolean> {
    if (!this.page) {
      console.log(
        `[${this.accountId}] No page available, skipping cookie load`,
      );
      return false;
    }

    try {
      if (!fs.existsSync(this.cookiesFile)) {
        console.log(`[${this.accountId}] No saved cookies found`);
        return false;
      }

      const cookiesData = fs.readFileSync(this.cookiesFile, "utf-8");
      const cookies: CookieParam[] = JSON.parse(cookiesData);

      if (!Array.isArray(cookies) || cookies.length === 0) {
        console.log(`[${this.accountId}] Cookie file is empty or invalid`);
        return false;
      }

      await this.page.setCookie(...cookies);
      console.log(
        `[${this.accountId}] Loaded ${cookies.length} cookies from ${this.cookiesFile}`,
      );
      return true;
    } catch (error) {
      console.error(`[${this.accountId}] Failed to load cookies:`, error);
      return false;
    }
  }

  /**
   * Check if user is already logged in by navigating to paraphraser
   * @returns true if already logged in
   */
  private async isAlreadyLoggedIn(): Promise<boolean> {
    if (!this.page) return false;

    try {
      console.log(`[${this.accountId}] Checking if already logged in...`);

      // Navigate to settings page - this requires authentication
      // If we get redirected to login, we're not logged in
      const SETTINGS_URL = "https://quillbot.com/settings";

      await this.page.goto(SETTINGS_URL, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      // Wait a bit for any redirects
      await this.delay(2000);

      const currentUrl = this.page.url();
      console.log(
        `[${this.accountId}] Login check - navigated to settings, current URL: ${currentUrl}`,
      );

      // If we're still on settings page (not redirected to login), we're logged in
      if (currentUrl.includes("/settings")) {
        console.log(
          `[${this.accountId}] Settings page accessible - user is logged in!`,
        );

        // Navigate to paraphraser for actual use
        await this.page.goto(PARAPHRASER_URL, {
          waitUntil: "networkidle2",
          timeout: 30000,
        });

        return true;
      }

      // If redirected to login page, we're not logged in
      if (currentUrl.includes("/login")) {
        console.log(
          `[${this.accountId}] Redirected to login page - session expired or not logged in`,
        );
        return false;
      }

      // Any other redirect means we're probably not logged in
      console.log(
        `[${this.accountId}] Unexpected redirect - assuming not logged in`,
      );
      return false;
    } catch (error) {
      console.log(`[${this.accountId}] Error checking login status:`, error);
      return false;
    }
  }

  private enqueueTask<T>(task: () => Promise<T>): Promise<T> {
    const run = this.taskQueue.then(task);
    this.taskQueue = run.catch(() => undefined);
    return run;
  }

  private incrementCriticalFailure(context: string): number {
    const next = (this.criticalFailureCountByContext.get(context) || 0) + 1;
    this.criticalFailureCountByContext.set(context, next);
    return next;
  }

  private clearCriticalFailure(context: string): void {
    this.criticalFailureCountByContext.delete(context);
  }

  private async runWithAutoRestart<T>(
    context: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await operation();
      this.clearCriticalFailure(context);
      return result;
    } catch (error) {
      if (!this.isCriticalError(error)) {
        throw error;
      }

      const criticalCount = this.incrementCriticalFailure(context);
      if (criticalCount >= 2) {
        throw new AutomationError(
          "E_RESTART_FAILED",
          `[${this.accountId}] Restart circuit opened after repeated critical failures (${criticalCount})`,
        );
      }

      this.log(
        context,
        `Critical error detected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.browserFailed = true;

      if (this.isRestarting) {
        this.log(
          context,
          "Restart already in progress, skipping automatic restart",
        );
        throw new AutomationError(
          "E_RESTART_FAILED",
          `[${this.accountId}] Restart already in progress while critical failure occurred`,
        );
      }

      this.log(context, "Attempting automatic browser restart...");
      this.isRestarting = true;

      try {
        await this.dispose();
        await this.init();
        this.autoRestartCount += 1;
        this.log(context, "Browser restarted successfully, retrying request...");
        const result = await operation();
        this.clearCriticalFailure(context);
        this.log(context, "Retry successful after browser restart");
        return result;
      } catch (retryError) {
        if (this.isCriticalError(retryError)) {
          const retryCriticalCount = this.incrementCriticalFailure(context);
          if (retryCriticalCount >= 2) {
            throw new AutomationError(
              "E_RESTART_FAILED",
              `[${this.accountId}] Retry failed after browser restart and exceeded critical failure cap`,
            );
          }
        }

        this.log(
          context,
          `Retry failed after browser restart: ${
            retryError instanceof Error
              ? retryError.message
              : String(retryError)
          }`,
        );
        throw retryError;
      } finally {
        this.isRestarting = false;
      }
    }
  }

  async paraphrase(
    text: string,
    requestId?: string,
  ): Promise<ParaphraseResult> {
    if (!text.trim()) {
      throw new Error("Input text must not be empty.");
    }

    await this.init();

    const context = requestId ?? `paraphrase-${Date.now()}`;
    this.log(context, `Queued request (length: ${text.length} chars)`);

    return this.enqueueTask(() =>
      this.runWithAutoRestart(context, async () => {
        const page = this.getPage();
        this.log(context, "Starting mode 1 flow");
        const firstModeOutput = await this.runFirstMode(page, text, context);
        this.log(context, "Mode 1 complete, starting mode 2 flow");
        const secondModeOutput = await this.runSecondMode(
          page,
          firstModeOutput,
          context,
        );
        this.log(context, "Mode 2 complete");
        return {
          firstMode: firstModeOutput,
          secondMode: secondModeOutput,
        } satisfies ParaphraseResult;
      }),
    );
  }

  async paraphraseStandardMode(
    text: string,
    requestId?: string,
  ): Promise<string> {
    if (!text.trim()) {
      throw new Error("Input text must not be empty.");
    }

    await this.init();

    const context = requestId ?? `paraphrase-standard-${Date.now()}`;
    this.log(
      context,
      `Queued standard mode request (length: ${text.length} chars)`,
    );

    return this.enqueueTask(() =>
      this.runWithAutoRestart(context, async () => {
        const page = this.getPage();
        this.log(context, "Starting standard mode flow");
        const output = await this.runStandardMode(page, text, context);
        this.log(context, "Standard mode complete");
        return output;
      }),
    );
  }

  private async setup(): Promise<void> {
    // Ensure session directories exist
    this.ensureDirectoriesExist();

    try {
      // NOTE: We intentionally do NOT use userDataDir to avoid Chrome's SingletonLock
      // issue when containers restart. Session persistence is handled via cookies only.
      this.browser = await puppeteer.launch({
        headless: this.options.headless ?? true,
        // userDataDir removed - causes lock issues with container restarts
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-blink-features=AutomationControlled",
          "--disable-web-security",
          "--disable-features=VizDisplayCompositor",
          "--single-process",
          "--no-default-browser-check",
          "--disable-extensions",
          "--disable-background-networking",
          "--dns-prefetch-disable",
          "--window-size=1920,1080",
          `--user-agent=${QUILLBOT_USER_AGENT}`,
        ],
        protocolTimeout: 60000,
      });
      const page = await this.browser.newPage();
      this.page = page;

      page.setDefaultTimeout(this.timeout);
      const context = this.browser.defaultBrowserContext();
      await context.overridePermissions(QUILLBOT_ORIGIN, [
        "clipboard-read",
        "clipboard-write",
      ]);

      await page.setViewport({ width: 1920, height: 1080 });

      // Add stealth headers
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": QUILLBOT_USER_AGENT,
        Referer: `${QUILLBOT_ORIGIN}/`,
        Origin: QUILLBOT_ORIGIN,
      });

      // Try to restore session from cookies first
      const cookiesLoaded = await this.loadCookies();

      if (cookiesLoaded) {
        // Check if we're already logged in (session still valid)
        const alreadyLoggedIn = await this.isAlreadyLoggedIn();

        if (alreadyLoggedIn) {
          // Session restored successfully, finalize setup
          await this.closePremiumModalIfPresent(page);
          await this.handleCookieConsent(page);
          await this.ensureMode(page, SELECTORS.firstModeTab);
          console.log(
            `[${this.accountId}] Session restored from cookies - skipping login!`,
          );
          return;
        }

        console.log(
          `[${this.accountId}] Saved cookies exist but session invalid, performing fresh login...`,
        );
      }

      // Full login flow - no valid session found
      console.log(`[${this.accountId}] Performing full login...`);

      // Retry navigation with exponential backoff
      let loginSuccess = false;
      let retries = 0;
      const maxRetries = 3;

      while (!loginSuccess && retries < maxRetries) {
        try {
          await page.goto(LOGIN_URL, {
            waitUntil: "networkidle2",
            timeout: 60000,
          });
          loginSuccess = true;
        } catch (error) {
          retries++;
          if (retries >= maxRetries) {
            throw error;
          }
          console.log(
            `[${this.accountId}] Navigation failed, retry ${retries}/${maxRetries}...`,
          );
          await this.delay(2000 * retries); // Exponential backoff
        }
      }

      await page.evaluate(() => {
        localStorage.setItem("DONT_SHOW_DELETE_REMINDER_AGAIN", "true");
      });

      // Handle cookie consent BEFORE login attempt
      await this.handleCookieConsent(page);

      await this.typeIntoField(page, SELECTORS.email, this.options.email);
      await this.typeIntoField(page, SELECTORS.password, this.options.password);

      const loginButton = await this.waitForAnySelector(
        page,
        SELECTORS.loginButton,
        this.timeout,
      );

      console.log(`[${this.accountId}] loginButton found`);

      // Ensure cookie banner is gone before clicking login
      await this.handleCookieConsent(page);

      await loginButton.click();

      // Wait for navigation to complete after login
      try {
        await page.waitForNavigation({
          waitUntil: "networkidle2",
          timeout: 15000,
        });
      } catch {
        console.log(
          `[${this.accountId}] Login navigation wait timed out, checking if we are redirected...`,
        );
      }

      // Check if we are still on login page or redirected to Facebook/Google
      const currentUrl = page.url();
      if (
        currentUrl.includes("facebook.com") ||
        currentUrl.includes("google.com")
      ) {
        throw new Error(
          `[${this.accountId}] Login failed: Redirected to social login page (${currentUrl})`,
        );
      }

      if (currentUrl.includes("/login")) {
        // Check for error messages
        const error = await page.evaluate(() =>
          document.body.innerText.match(
            /Invalid email or password|Incorrect password/i,
          ),
        );
        if (error) {
          throw new Error(`[${this.accountId}] Login failed: ${error[0]}`);
        }
      }

      // Retry paraphraser navigation with exponential backoff
      loginSuccess = false;
      retries = 0;

      while (!loginSuccess && retries < maxRetries) {
        try {
          await page.goto(PARAPHRASER_URL, {
            waitUntil: "networkidle2",
            timeout: 60000,
          });
          loginSuccess = true;
        } catch (error) {
          retries++;
          if (retries >= maxRetries) {
            throw error;
          }
          console.log(
            `[${this.accountId}] Paraphraser page navigation failed, retry ${retries}/${maxRetries}...`,
          );
          await this.delay(2000 * retries);
        }
      }

      await this.closePremiumModalIfPresent(page);
      await this.handleCookieConsent(page);
      await this.ensureMode(page, SELECTORS.firstModeTab);

      // Save cookies after successful login for future session restoration
      await this.saveCookies();
      console.log(
        `[${this.accountId}] Login successful - cookies saved for session persistence`,
      );
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  private getPage(): Page {
    if (!this.page) {
      throw new Error("Browser page not initialized yet.");
    }
    return this.page;
  }

  private async ensureParaphraserPage(page: Page, context: string): Promise<void> {
    const currentUrl = page.url();
    if (currentUrl.includes("/paraphrasing-tool")) {
      return;
    }

    this.log(context, "Preflight: navigating to paraphrasing tool");
    await page.goto(PARAPHRASER_URL, {
      waitUntil: "domcontentloaded",
      timeout: this.timeout,
    });
  }

  private async ensureInputWritable(page: Page): Promise<void> {
    const inputRoot = await this.waitForAnySelector(
      page,
      SELECTORS.inputArea,
      this.timeout,
    );

    const writable = await page.evaluate((root) => {
      const resolveEditable = (element: Element): HTMLElement | null => {
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          return element;
        }
        if (element instanceof HTMLElement && element.isContentEditable) {
          return element;
        }
        const nestedEditable = element.querySelector<HTMLElement>(
          "[contenteditable='true']",
        );
        if (nestedEditable) {
          return nestedEditable;
        }
        const nestedInput = element.querySelector<
          HTMLInputElement | HTMLTextAreaElement
        >("textarea, input");
        return nestedInput ?? null;
      };

      const editable = resolveEditable(root);
      if (!editable) {
        return false;
      }

      if (
        editable instanceof HTMLInputElement ||
        editable instanceof HTMLTextAreaElement
      ) {
        return !editable.disabled && !editable.readOnly;
      }

      return editable.isContentEditable;
    }, inputRoot);

    if (!writable) {
      throw new AutomationError(
        "E_SELECTOR_MISS",
        `[${this.accountId}] Input area is not writable`,
      );
    }
  }

  private async preflightForMode(
    page: Page,
    modeSelectors: string[],
    context: string,
  ): Promise<void> {
    await this.ensureParaphraserPage(page, context);
    await this.closePremiumModalIfPresent(page);
    await this.handleCookieConsent(page);
    await this.ensureMode(page, modeSelectors);
    await this.ensureInputWritable(page);
    await this.ensureParaphraseActionReady(page, context);
  }

  private async ensureParaphraseActionReady(
    page: Page,
    context: string,
  ): Promise<void> {
    const button = await this.resolveParaphraseButton(
      page,
      PARAPHRASE_BUTTON_DISCOVERY_TIMEOUT_MS,
    );

    if (button) {
      await button.dispose();
      return;
    }

    this.log(
      context,
      "Preflight: paraphrase button selector drift detected, using keyboard shortcut fallback",
    );
  }

  private async resolveParaphraseButton(
    page: Page,
    timeout: number,
  ): Promise<ElementHandle<Element> | null> {
    try {
      return await this.waitForAnySelector(page, SELECTORS.paraphraseButton, timeout);
    } catch {
      // Continue with semantic fallback below.
    }

    try {
      await page.waitForFunction(
        () => {
          const candidates = Array.from(
            document.querySelectorAll("button, [role='button']"),
          );
          return candidates.some((el) => {
            const text = (el.textContent || "").toLowerCase();
            const aria = (el.getAttribute("aria-label") || "").toLowerCase();
            const testId = (el.getAttribute("data-testid") || "").toLowerCase();
            return (
              text.includes("paraphrase") ||
              text.includes("rephrase") ||
              text.includes("rewrite") ||
              aria.includes("paraphrase") ||
              aria.includes("rephrase") ||
              aria.includes("rewrite") ||
              testId.includes("paraphrase") ||
              testId.includes("rephrase") ||
              testId.includes("rewrite")
            );
          });
        },
        { timeout },
      );

      const handle = await page.evaluateHandle(() => {
        const candidates = Array.from(
          document.querySelectorAll("button, [role='button']"),
        );
        for (const el of candidates) {
          const text = (el.textContent || "").toLowerCase();
          const aria = (el.getAttribute("aria-label") || "").toLowerCase();
          const testId = (el.getAttribute("data-testid") || "").toLowerCase();
          const isParaphraseAction =
            text.includes("paraphrase") ||
            text.includes("rephrase") ||
            text.includes("rewrite") ||
            aria.includes("paraphrase") ||
            aria.includes("rephrase") ||
            aria.includes("rewrite") ||
            testId.includes("paraphrase") ||
            testId.includes("rephrase") ||
            testId.includes("rewrite");

          if (isParaphraseAction) {
            return el;
          }
        }
        return null;
      });

      const element = handle.asElement();
      if (!element) {
        await handle.dispose();
        return null;
      }

      return element as unknown as ElementHandle<Element>;
    } catch {
      return null;
    }
  }

  private async softResetForMode(
    page: Page,
    modeSelectors: string[],
    text: string,
    context: string,
  ): Promise<void> {
    this.log(context, "Attempting soft reset");
    await this.closePremiumModalIfPresent(page);
    await this.handleCookieConsent(page);
    await this.ensureMode(page, modeSelectors);
    await this.clearInputArea(page);
    await this.fillInputArea(page, text);
  }

  private async hardResetForMode(
    page: Page,
    modeSelectors: string[],
    text: string,
    context: string,
  ): Promise<void> {
    this.log(context, "Soft reset failed, falling back to hard reset");
    await page.reload({ waitUntil: "networkidle2" });
    await this.closePremiumModalIfPresent(page);
    await this.handleCookieConsent(page);
    await this.ensureMode(page, modeSelectors);
    await this.clearInputArea(page);
    await this.fillInputArea(page, text);
  }

  private async recoverAfterTriggerFailure(
    page: Page,
    modeSelectors: string[],
    text: string,
    context: string,
  ): Promise<void> {
    try {
      await this.softResetForMode(page, modeSelectors, text, context);
      await this.preflightForMode(page, modeSelectors, context);
      return;
    } catch (softResetError) {
      this.log(
        context,
        `Soft reset failed: ${
          softResetError instanceof Error
            ? softResetError.message
            : String(softResetError)
        }`,
      );
    }

    await this.hardResetForMode(page, modeSelectors, text, context);
    await this.preflightForMode(page, modeSelectors, context);
  }

  private async runFirstMode(
    page: Page,
    text: string,
    context: string,
  ): Promise<string> {
    const modeSelectors = SELECTORS.firstModeTab;
    await this.preflightForMode(page, modeSelectors, context);
    this.log(context, "Mode 1: ensuring tab active");
    await this.ensureMode(page, modeSelectors);
    this.log(context, "Mode 1: filling input");
    await this.fillInputArea(page, text);
    await this.closePremiumModalIfPresent(page);
    await this.handleCookieConsent(page);
    this.log(context, "Mode 1: clicking paraphrase");

    await this.clickParaphraseWithRetry(
      page,
      context,
      "Mode 1",
      modeSelectors,
      text,
    );

    return this.captureParaphraseOutput(page, context, "Mode 1");
  }

  private async runSecondMode(
    page: Page,
    text: string,
    context: string,
  ): Promise<string> {
    const modeSelectors = SELECTORS.secondModeTab;
    await this.preflightForMode(page, modeSelectors, context);

    this.log(context, "Mode 2: switching tab");
    await this.switchMode(page, modeSelectors);

    this.log(context, "Mode 2: filling input");
    await this.fillInputArea(page, text);

    await this.delay(500);
    this.log(context, "Mode 2: clicking paraphrase");

    await this.clickParaphraseWithRetry(
      page,
      context,
      "Mode 2",
      modeSelectors,
      text,
    );

    const output = await this.captureParaphraseOutput(page, context, "Mode 2");
    this.resetPageState(page, context);
    return output;
  }

  private async runStandardMode(
    page: Page,
    text: string,
    context: string,
  ): Promise<string> {
    const modeSelectors = SELECTORS.standardModeTab;
    await this.preflightForMode(page, modeSelectors, context);
    this.log(context, "Standard mode: ensuring tab active");
    await this.ensureMode(page, modeSelectors);
    this.log(context, "Standard mode: filling input");
    await this.fillInputArea(page, text);
    await this.closePremiumModalIfPresent(page);
    await this.handleCookieConsent(page);
    this.log(context, "Standard mode: clicking paraphrase");

    await this.clickParaphraseWithRetry(
      page,
      context,
      "Standard mode",
      modeSelectors,
      text,
    );

    const output = await this.captureParaphraseOutput(
      page,
      context,
      "Standard mode",
    );
    this.resetPageState(page, context);
    return output;
  }

  private async readOutputSignature(page: Page): Promise<string> {
    return page.evaluate((outputSelectors) => {
      const normalize = (value: string): string =>
        value.replace(/\s+/g, " ").trim();

      const isVisible = (el: Element | null): el is HTMLElement => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      for (const selector of outputSelectors) {
        const candidate = document.querySelector(selector);
        if (!isVisible(candidate)) continue;
        const text = normalize(candidate.innerText || candidate.textContent || "");
        if (text) {
          return text.slice(0, 800);
        }
      }

      return "";
    }, [...OUTPUT_SELECTORS]);
  }

  private async waitForParaphraseToStart(
    page: Page,
    baselineOutputSignature: string,
  ): Promise<boolean> {
    try {
      await page.waitForFunction(
        (
          loadingSelectors,
          paraphraseButtonSelectors,
          outputSelectors,
          baselineOutput,
        ) => {
          const normalize = (value: string): string =>
            value.replace(/\s+/g, " ").trim();

          const isVisible = (el: Element | null): el is HTMLElement => {
            if (!(el instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") {
              return false;
            }
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };

          const isParaphraseButtonBusy = (): boolean => {
            for (const selector of paraphraseButtonSelectors) {
              const button = document.querySelector(selector);
              if (!(button instanceof HTMLElement)) continue;
              const ariaBusy = button.getAttribute("aria-busy");
              const ariaDisabled = button.getAttribute("aria-disabled");
              const className = (button.className || "").toLowerCase();
              if (
                button.hasAttribute("disabled") ||
                ariaBusy === "true" ||
                ariaDisabled === "true" ||
                className.includes("loading")
              ) {
                return true;
              }
            }
            return false;
          };

          const currentOutputSignature = (() => {
            for (const selector of outputSelectors) {
              const candidate = document.querySelector(selector);
              if (!isVisible(candidate)) continue;
              const text = normalize(candidate.innerText || candidate.textContent || "");
              if (text) {
                return text.slice(0, 800);
              }
            }
            return "";
          })();

          const isLoading = loadingSelectors.some((s) =>
            document.querySelector(s),
          );
          const outputChanged =
            !!currentOutputSignature &&
            currentOutputSignature !== baselineOutput;
          return isLoading || isParaphraseButtonBusy() || outputChanged;
        },
        { timeout: PARAPHRASE_START_TIMEOUT_MS },
        [...SELECTORS.loadingIndicator],
        [...SELECTORS.paraphraseButton],
        [...OUTPUT_SELECTORS],
        baselineOutputSignature,
      );
      return true;
    } catch {
      return false;
    }
  }

  private async clickParaphraseWithRetry(
    page: Page,
    context: string,
    modeLabel: string,
    modeSelectors: string[],
    text: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_PARAPHRASE_CLICK_ATTEMPTS; attempt++) {
      const baselineOutputSignature = await this.readOutputSignature(page);
      await this.randomDelay(100, 400);
      await this.triggerParaphrase(page);

      if (await this.waitForParaphraseToStart(page, baselineOutputSignature)) {
        return;
      }

      this.log(
        context,
        `${modeLabel}: Click attempt ${
          attempt + 1
        } failed to trigger action, retrying...`,
      );

      if (attempt === 0) {
        this.log(context, `${modeLabel}: running recovery flow before retry...`);
        await this.recoverAfterTriggerFailure(
          page,
          modeSelectors,
          text,
          context,
        );
        await this.delay(300);
      }
    }

    throw new Error(
      "Critical: Click failed after 2 attempts - paraphrase button not responding",
    );
  }

  private async captureParaphraseOutput(
    page: Page,
    context: string,
    modeLabel: string,
  ): Promise<string> {
    await this.closePremiumModalIfPresent(page);
    await this.waitForLoaderToDisappear(page);
    this.log(context, `${modeLabel}: copying result`);
    await this.copyResult(page);
    await this.closePremiumModalIfPresent(page);
    const output = await this.readClipboard(page);
    this.log(context, `${modeLabel}: clipboard captured`);
    return output;
  }

  private async typeIntoField(
    page: Page,
    selectors: string[],
    value: string,
  ): Promise<void> {
    const field = await this.waitForAnySelector(page, selectors, this.timeout);
    await field.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await this.delay(50);
    await field.type(value, { delay: 10 }); // Add typing delay to mimic human
  }

  private async ensureMode(page: Page, selectors: string[]): Promise<void> {
    const labels = this.inferModeLabels(selectors);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tab = await this.waitForAnySelector(
          page,
          selectors,
          this.timeout,
        );
        await tab.click({ delay: 5 });
        if (labels.length > 0) {
          await this.ensureModeLabelActive(page, labels);
        }
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : "";
        if (!message.includes("detached")) {
          break;
        }
        await this.delay(100);
      }
    }

    if (labels.length > 0) {
      this.log(
        "mode",
        `Selector-based mode switch failed; trying label-based mode selection (${labels.join(", ")})`,
      );
      try {
        await this.selectModeByLabel(page, labels, 8000);
        await this.ensureModeLabelActive(page, labels);
        return;
      } catch (labelError) {
        lastError = labelError;
      }
    }

    throw lastError ?? new Error("Failed to switch mode tab");
  }

  private inferModeLabels(selectors: string[]): string[] {
    if (selectors === SELECTORS.firstModeTab) {
      return ["simple"];
    }
    if (selectors === SELECTORS.secondModeTab) {
      return ["shorten"];
    }
    if (selectors === SELECTORS.standardModeTab) {
      return ["standard"];
    }
    return [];
  }

  private async selectModeByLabel(
    page: Page,
    labels: string[],
    timeoutMs: number,
  ): Promise<void> {
    const startedAt = Date.now();
    const normalizedLabels = labels.map((label) => label.toLowerCase());

    while (Date.now() - startedAt < timeoutMs) {
      const action = await page.evaluate((targetLabels) => {
        const normalize = (value: string): string =>
          value.toLowerCase().replace(/\s+/g, " ").trim();

        const isVisible = (el: Element): boolean => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const textFor = (el: Element): string =>
          normalize(
            `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""} ${el.textContent || ""}`,
          );

        const matchesLabel = (el: Element): boolean => {
          const hay = textFor(el);
          return targetLabels.some(
            (label) => hay === label || hay.includes(` ${label} `) || hay.startsWith(`${label} `) || hay.endsWith(` ${label}`) || hay.includes(label),
          );
        };

        const candidates = Array.from(
          document.querySelectorAll(
            "[id^='Paraphraser-mode-tab-'], [role='tab'], [role='menuitem'], button",
          ),
        );

        const target = candidates.find((el) => isVisible(el) && matchesLabel(el));
        if (target && target instanceof HTMLElement) {
          target.click();
          return "clicked-target";
        }

        const more = candidates.find((el) => {
          if (!isVisible(el)) return false;
          const text = textFor(el);
          return text === "more" || text.includes(" more");
        });

        if (more && more instanceof HTMLElement) {
          more.click();
          return "clicked-more";
        }

        return "none";
      }, normalizedLabels);

      if (action === "clicked-target") {
        await this.delay(120);
        return;
      }

      await this.delay(action === "clicked-more" ? 220 : 140);
    }

    throw new AutomationError(
      "E_SELECTOR_MISS",
      `Failed to switch mode by labels within ${timeoutMs}ms (${labels.join(", ")})`,
    );
  }

  private async ensureModeLabelActive(
    page: Page,
    labels: string[],
  ): Promise<void> {
    const expected = labels.map((label) => label.toLowerCase());

    const isActive = await page.evaluate((targetLabels) => {
      const normalize = (value: string): string =>
        value.toLowerCase().replace(/\s+/g, " ").trim();

      const textFor = (el: Element): string =>
        normalize(
          `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""} ${el.textContent || ""}`,
        );

      const candidates = Array.from(
        document.querySelectorAll(
          "[id^='Paraphraser-mode-tab-'][aria-selected='true'], [role='tab'][aria-selected='true'], [aria-selected='true'][role='button']",
        ),
      );

      return candidates.some((el) => {
        const text = textFor(el);
        return targetLabels.some((label) => text.includes(label));
      });
    }, expected);

    if (!isActive) {
      throw new AutomationError(
        "E_SELECTOR_MISS",
        `Mode activation check failed for labels: ${labels.join(", ")}`,
      );
    }
  }

  private async switchMode(page: Page, selectors: string[]): Promise<void> {
    await this.ensureMode(page, selectors);
  }

  private async fillInputArea(page: Page, text: string): Promise<void> {
    await this.setInputAreaContent(page, text);
    // Verify content was set
    const content = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      return el?.textContent || (el as HTMLInputElement)?.value || "";
    }, SELECTORS.inputArea[0]);

    if (!content && text.length > 0) {
      console.log("Warning: Input area seems empty after fill attempt");
      // Retry once
      await this.setInputAreaContent(page, text);
    }
  }

  private async clearInputArea(page: Page): Promise<void> {
    try {
      const clearButton = await this.waitForAnySelector(
        page,
        SELECTORS.clearInputButton,
        2000,
      );
      await clearButton.click();
    } catch {
      await this.setInputAreaContent(page, "");
    }
  }

  private async triggerParaphrase(page: Page): Promise<void> {
    const button = await this.resolveParaphraseButton(
      page,
      PARAPHRASE_BUTTON_DISCOVERY_TIMEOUT_MS,
    );
    if (!button) {
      // QuillBot frequently changes generated classnames; fall back to the
      // tooltip shortcut when the button selector drifts.
      console.log(
        "Paraphrase button selector not found; falling back to keyboard Ctrl+Enter",
      );
      await this.pressParaphraseShortcut(page);
      return;
    }

    // Log what we found to help debugging
    const buttonState = await page.evaluate(
      (el) => ({
        disabled:
          el.hasAttribute("disabled") ||
          el.getAttribute("aria-disabled") === "true",
        visible: (el as HTMLElement).offsetParent !== null,
      }),
      button,
    );

    console.log(
      `Paraphrase button found: disabled=${buttonState.disabled}, visible=${buttonState.visible}`,
    );

    if (buttonState.disabled) {
      console.log("Button is disabled! Attempting to wake up input...");
      // Try to trigger input events by typing a space and backspace
      const input = await this.waitForAnySelector(
        page,
        SELECTORS.inputArea,
        2000,
      );
      await input.focus();
      await page.keyboard.type(" ");
      await page.keyboard.press("Backspace");
      await this.delay(500);
    }

    // Try to scroll into view
    await button.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await this.delay(100); // Reduced from 500ms

    // Try mouse click (most reliable for avoiding detection/overlays)
    try {
      const box = await button.boundingBox();
      if (box) {
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;

        await page.mouse.move(x, y);
        await this.delay(10);
        await page.mouse.down();
        await this.delay(10);
        await page.mouse.up();

        // Fallback: JS click dispatch (React sometimes needs this)
        await this.delay(50);
        await page.evaluate((el) => {
          const event = new MouseEvent("click", {
            view: window,
            bubbles: true,
            cancelable: true,
          });
          el.dispatchEvent(event);
        }, button);
        return;
      }

      console.log("Paraphrase button has no bounding box; using JS click");
      await page.evaluate((el) => (el as HTMLElement).click(), button);
    } catch (clickError) {
      console.log(
        `Click on paraphrase button failed; falling back to keyboard shortcut: ${
          clickError instanceof Error ? clickError.message : String(clickError)
        }`,
      );
      await this.pressParaphraseShortcut(page);
    } finally {
      try {
        await button.dispose();
      } catch {
        // no-op
      }
    }
  }

  private async pressParaphraseShortcut(page: Page): Promise<void> {
    // QuillBot advertises Ctrl+Enter; use Meta+Enter on macOS.
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.down(modifier);
    await page.keyboard.press("Enter");
    await page.keyboard.up(modifier);
  }

  private async copyResult(page: Page): Promise<void> {
    try {
      const button = await this.waitForAnySelector(
        page,
        SELECTORS.copyButton,
        this.timeout,
      );
      await button.click();
      await this.delay(500);
    } catch (error) {
      // Si copyButton no aparece, es un error crítico que indica estado irrecuperable
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        "Failed to find copy button - browser likely in bad state:",
        message,
      );
      throw new Error(`Critical: Copy button not found - ${message}`);
    }
  }

  /**
   * Extract paraphrased text directly from the output area DOM
   * This avoids clipboard sharing issues when running multiple browser instances
   */
  private async readOutputText(page: Page): Promise<string> {
    for (const selector of OUTPUT_SELECTORS) {
      try {
        const element = await page.$(selector);
        if (element) {
          const text = await page.evaluate((el) => {
            // Try to get innerText first, fallback to textContent
            return (
              (el as HTMLElement).innerText ||
              (el as HTMLElement).textContent ||
              ""
            );
          }, element);

          if (text && text.trim().length > 0) {
            this.log("output", `Extracted text using selector: ${selector}`);
            return text.trim();
          }
        }
      } catch {
        // Try next selector
      }
    }

    // Fallback to clipboard if DOM extraction fails
    this.log("output", "DOM extraction failed, falling back to clipboard");
    return page.evaluate(async () => navigator.clipboard.readText());
  }

  private async readClipboard(page: Page): Promise<string> {
    // Use DOM extraction instead of clipboard to avoid race conditions
    // when multiple browser instances run in parallel
    return this.readOutputText(page);
  }

  private async closePremiumModalIfPresent(page: Page): Promise<void> {
    try {
      const closeButton = await this.waitForAnySelector(
        page,
        SELECTORS.closePremiumModal,
        500,
      );
      await closeButton.click();
      await this.delay(200);
    } catch {
      // Ignore if modal is not present.
    }
  }

  private async resetPageState(page: Page, context: string): Promise<void> {
    this.log(context, "Resetting page state after Mode 2");
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await this.closePremiumModalIfPresent(page);
      await this.handleCookieConsent(page);
      await this.ensureMode(page, SELECTORS.firstModeTab);
    } catch (error) {
      console.error("Failed to reset page state:", error);
    }
  }

  private async handleCookieConsent(page: Page): Promise<void> {
    if (this.cookieConsentHandled) return;

    try {
      // Reduced timeout to check quickly
      const consentButton = await this.waitForAnySelector(
        page,
        SELECTORS.cookieConsent,
        500,
      );
      console.log("Cookie consent banner detected, clicking accept/close...");
      await consentButton.click();
      this.cookieConsentHandled = true;

      // Wait for banner to disappear instead of fixed delay
      try {
        await page.waitForFunction(
          (selectors) => !selectors.some((s) => document.querySelector(s)),
          { timeout: 1000 },
          SELECTORS.cookieConsent,
        );
      } catch {
        // If wait fails, just continue
      }
    } catch {
      // Ignore if cookie banner is not present
    }
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Random delay between min and max milliseconds to desynchronize parallel operations
   */
  private randomDelay(min: number, max: number): Promise<void> {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return this.delay(ms);
  }

  private log(context: string, message: string): void {
    console.log(`[${this.accountId}] [${context}] ${message}`);
  }

  private async waitForLoaderToDisappear(
    page: Page,
    timeout = this.loaderWaitTimeout,
  ): Promise<void> {
    const hasCustomTimeout = typeof timeout === "number" && timeout > 0;
    const pollInterval = 500;
    const maxWait = hasCustomTimeout ? timeout : Number.POSITIVE_INFINITY;
    const start = Date.now();

    while (true) {
      if (page.isClosed()) {
        throw new Error("Page closed while waiting for loader to disappear");
      }

      const stillLoading = await page
        .evaluate(
          (selectors) =>
            selectors.some((selector) => !!document.querySelector(selector)),
          SELECTORS.loadingIndicator,
        )
        .catch((error) => {
          // If the execution context is destroyed (navigation/reload), retry
          const message = error instanceof Error ? error.message : "";
          if (message.includes("Execution context was destroyed")) {
            return true;
          }
          throw error;
        });

      if (!stillLoading) {
        return;
      }

      if (Date.now() - start >= maxWait) {
        throw new Error(
          `Loader still visible after ${maxWait}ms. You can increase loaderWaitTimeout if needed.`,
        );
      }

      await this.delay(pollInterval);
    }
  }

  private async setInputAreaContent(page: Page, text: string): Promise<void> {
    const inputArea = await this.waitForAnySelector(
      page,
      SELECTORS.inputArea,
      this.timeout,
    );

    await inputArea.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await inputArea.focus();

    if (text.length === 0) {
      await inputArea.evaluate((element) => {
        element.dispatchEvent(new InputEvent("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      });
      return;
    }

    await inputArea.evaluate((element, value) => {
      const resolveEditable = (root: Element): HTMLElement | null => {
        if (
          root instanceof HTMLInputElement ||
          root instanceof HTMLTextAreaElement
        ) {
          return root;
        }
        if (root instanceof HTMLElement && root.isContentEditable) {
          return root;
        }
        const contentEditable = root.querySelector<HTMLElement>(
          "[contenteditable='true']",
        );
        if (contentEditable) {
          return contentEditable;
        }
        const textControl = root.querySelector<
          HTMLInputElement | HTMLTextAreaElement
        >("textarea, input");
        if (textControl) {
          return textControl;
        }
        return root instanceof HTMLElement ? root : null;
      };

      const target = resolveEditable(element);
      if (!target) {
        return;
      }

      const assign = (content: string): void => {
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement
        ) {
          target.value = content;
        } else {
          target.textContent = content;
        }
      };

      assign(value);

      target.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertFromPaste",
          data: value,
        }),
      );
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }, text);
  }

  private async waitForAnySelector(
    page: Page,
    selectors: string[],
    timeout = this.timeout,
  ): Promise<ElementHandle<Element>> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.waitForFunction(
          (selectorList) =>
            selectorList.some((selector) => !!document.querySelector(selector)),
          { timeout },
          selectors,
        );
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : "";
        if (
          message.includes("Execution context was destroyed") &&
          attempt < 2
        ) {
          await this.delay(50);
          continue;
        }
        break;
      }
    }

    if (!lastError) {
      for (let attempt = 0; attempt < 3; attempt++) {
        for (const selector of selectors) {
          const handle = await page.$(selector);
          if (handle) {
            return handle;
          }
        }
        if (attempt < 2) {
          await this.delay(25);
        }
      }
      lastError = new Error(`Unable to resolve selectors after wait`);
    }

    // If we failed to find any selector, capture current page state.
    try {
      const url = page.url();
      const title = await page.title();
      console.log(`Current page state - URL: ${url}, Title: ${title}`);
    } catch (e) {
      console.error("Failed to capture debug info on selector failure:", e);
    }

    const baseMessage =
      lastError instanceof Error
        ? lastError.message
        : String(lastError ?? "unknown selector error");
    throw new AutomationError(
      "E_SELECTOR_MISS",
      `Unable to find selectors: ${selectors.join(", ")} (${baseMessage})`,
    );
  }

  /**
   * Determina si un error es crítico y requiere reinicio del navegador.
   * Errores críticos incluyen:
   * - Timeout esperando el botón de copiar (indica que paraphrase falló)
   * - Contexto de ejecución destruido inesperadamente
   * - Página cerrada inesperadamente
   * - Navegador desconectado
   */
  private isCriticalError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();

    // Timeout esperando copyButton es crítico
    if (
      message.includes("copy button not found") ||
      (message.includes("timeout") && message.includes("copy"))
    ) {
      return true;
    }

    // Contexto de ejecución destruido inesperadamente
    if (
      message.includes("execution context was destroyed") &&
      !message.includes("navigation")
    ) {
      return true;
    }

    // Página cerrada o navegador desconectado
    if (
      message.includes("page closed") ||
      message.includes("browser has been closed") ||
      message.includes("session closed") ||
      message.includes("target closed")
    ) {
      return true;
    }

    // Protocolo de timeout generalmente indica problema serio
    if (
      message.includes("protocol error") ||
      message.includes("websocket") ||
      message.includes("connection closed")
    ) {
      return true;
    }

    return false;
  }
}
