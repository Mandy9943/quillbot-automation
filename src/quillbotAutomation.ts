import puppeteer, { Browser, ElementHandle, Page } from "puppeteer";

const LOGIN_URL = "https://quillbot.com/login";
const PARAPHRASER_URL = "https://quillbot.com/paraphrasing-tool";

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
    "#controlledInputBoxContainer > div.MuiBox-root.css-1a43h92 > div > div.MuiBox-root.css-n0jqrr > span > div > button",
    "#controlledInputBoxContainer > div.MuiBox-root.css-1buxzwp > div > div.MuiBox-root.css-1s1ozo1 > span > div > button",
  ],
  copyButton: ['[data-testid="pphr/output_footer/copy_text_button"]'],
  loadingIndicator: ["#mui-2401 > div", ".MuiLoadingButton-loadingIndicator"],
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

export interface QuillBotAutomationOptions {
  email: string;
  password: string;
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
  private cookieConsentHandled = false;
  private browserFailed = false;

  constructor(private readonly options: QuillBotAutomationOptions) {
    this.timeout = options.timeout ?? 30000;
    this.loaderWaitTimeout = options.loaderWaitTimeout ?? 0;
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
  }

  async paraphrase(
    text: string,
    requestId?: string
  ): Promise<ParaphraseResult> {
    if (!text.trim()) {
      throw new Error("Input text must not be empty.");
    }

    await this.init();

    const context = requestId ?? `paraphrase-${Date.now()}`;
    this.log(context, `Queued request (length: ${text.length} chars)`);

    const task = async () => {
      try {
        const page = this.getPage();
        this.log(context, "Starting mode 1 flow");
        const firstModeOutput = await this.runFirstMode(page, text, context);
        this.log(context, "Mode 1 complete, starting mode 2 flow");
        const secondModeOutput = await this.runSecondMode(
          page,
          firstModeOutput,
          context
        );
        this.log(context, "Mode 2 complete");
        return {
          firstMode: firstModeOutput,
          secondMode: secondModeOutput,
        } satisfies ParaphraseResult;
      } catch (error) {
        if (this.isCriticalError(error)) {
          this.log(
            context,
            `Critical error detected: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          this.browserFailed = true;
          
          // Attempt automatic restart
          this.log(context, "Attempting automatic browser restart...");
          try {
            await this.dispose();
            await this.init();
            this.log(context, "Browser restarted successfully, retrying request...");
            
            // Retry the operation once after restart
            const page = this.getPage();
            const firstModeOutput = await this.runFirstMode(page, text, context);
            const secondModeOutput = await this.runSecondMode(
              page,
              firstModeOutput,
              context
            );
            this.log(context, "Retry successful after browser restart");
            return {
              firstMode: firstModeOutput,
              secondMode: secondModeOutput,
            } satisfies ParaphraseResult;
          } catch (retryError) {
            this.log(
              context,
              `Retry failed after browser restart: ${
                retryError instanceof Error ? retryError.message : String(retryError)
              }`
            );
            throw retryError;
          }
        }
        throw error;
      }
    };

    const run = this.taskQueue.then(() => task());
    this.taskQueue = run.catch(() => undefined);
    return run;
  }

  async paraphraseStandardMode(
    text: string,
    requestId?: string
  ): Promise<string> {
    if (!text.trim()) {
      throw new Error("Input text must not be empty.");
    }

    await this.init();

    const context = requestId ?? `paraphrase-standard-${Date.now()}`;
    this.log(
      context,
      `Queued standard mode request (length: ${text.length} chars)`
    );

    const task = async () => {
      try {
        const page = this.getPage();
        this.log(context, "Starting standard mode flow");
        const output = await this.runStandardMode(page, text, context);
        this.log(context, "Standard mode complete");
        return output;
      } catch (error) {
        if (this.isCriticalError(error)) {
          this.log(
            context,
            `Critical error detected: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          this.browserFailed = true;
          
          // Attempt automatic restart
          this.log(context, "Attempting automatic browser restart...");
          try {
            await this.dispose();
            await this.init();
            this.log(context, "Browser restarted successfully, retrying request...");
            
            // Retry the operation once after restart
            const page = this.getPage();
            const output = await this.runStandardMode(page, text, context);
            this.log(context, "Retry successful after browser restart");
            return output;
          } catch (retryError) {
            this.log(
              context,
              `Retry failed after browser restart: ${
                retryError instanceof Error ? retryError.message : String(retryError)
              }`
            );
            throw retryError;
          }
        }
        throw error;
      }
    };

    const run = this.taskQueue.then(() => task());
    this.taskQueue = run.catch(() => undefined);
    return run;
  }

  private async setup(): Promise<void> {
    try {
      this.browser = await puppeteer.launch({
        headless: this.options.headless ?? true,
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
          "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        ],
        protocolTimeout: 60000,
      });
      const page = await this.browser.newPage();
      this.page = page;

      page.setDefaultTimeout(this.timeout);
      const context = this.browser.defaultBrowserContext();
      await context.overridePermissions("https://quillbot.com", [
        "clipboard-read",
        "clipboard-write",
      ]);

      await page.setViewport({ width: 1920, height: 1080 });

      // Add stealth headers
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Referer: "https://quillbot.com/",
        Origin: "https://quillbot.com",
      });

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
          console.log(`Navigation failed, retry ${retries}/${maxRetries}...`);
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
        this.timeout
      );

      console.log("loginButton");

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
          "Login navigation wait timed out, checking if we are redirected..."
        );
      }

      // Check if we are still on login page or redirected to Facebook/Google
      const currentUrl = page.url();
      if (
        currentUrl.includes("facebook.com") ||
        currentUrl.includes("google.com")
      ) {
        throw new Error(
          `Login failed: Redirected to social login page (${currentUrl})`
        );
      }

      if (currentUrl.includes("/login")) {
        // Check for error messages
        const error = await page.evaluate(() =>
          document.body.innerText.match(
            /Invalid email or password|Incorrect password/i
          )
        );
        if (error) {
          throw new Error(`Login failed: ${error[0]}`);
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
            `Paraphraser page navigation failed, retry ${retries}/${maxRetries}...`
          );
          await this.delay(2000 * retries);
        }
      }

      await this.closePremiumModalIfPresent(page);
      await this.handleCookieConsent(page);
      await this.ensureMode(page, SELECTORS.firstModeTab);
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

  private async runFirstMode(
    page: Page,
    text: string,
    context: string
  ): Promise<string> {
    this.log(context, "Mode 1: ensuring tab active");
    await this.ensureMode(page, SELECTORS.firstModeTab);
    this.log(context, "Mode 1: filling input");
    await this.fillInputArea(page, text);
    await this.closePremiumModalIfPresent(page);
    await this.handleCookieConsent(page);
    this.log(context, "Mode 1: clicking paraphrase");

    let clickSuccess = false;
    for (let i = 0; i < 3; i++) {
      await this.triggerParaphrase(page);

      // Wait for either loader or result to appear to confirm click worked
      try {
        await page.waitForFunction(
          (loadingSelectors, copySelectors) => {
            const isLoading = loadingSelectors.some((s) =>
              document.querySelector(s)
            );
            const isDone = copySelectors.some((s) => document.querySelector(s));
            return isLoading || isDone;
          },
          { timeout: 40000 },
          SELECTORS.loadingIndicator,
          SELECTORS.copyButton
        );
        clickSuccess = true;
        break;
      } catch {
        this.log(
          context,
          `Mode 1: Click attempt ${i + 1} failed to trigger action, retrying...`
        );
        await this.delay(500);
      }
    }

    if (!clickSuccess) {
      this.log(
        context,
        "Mode 1: Warning - No loader or result detected after multiple click attempts"
      );
    }

    await this.closePremiumModalIfPresent(page);
    await this.waitForLoaderToDisappear(page);
    this.log(context, "Mode 1: copying result");
    await this.copyResult(page);
    await this.closePremiumModalIfPresent(page);
    const output = await this.readClipboard(page);
    this.log(context, "Mode 1: clipboard captured");
    return output;
  }

  private async runSecondMode(
    page: Page,
    text: string,
    context: string
  ): Promise<string> {
    this.log(context, "Mode 2: Reloading page to ensure fresh state");
    await page.reload({ ignoreCache: false, waitUntil: "networkidle2" });

    await this.closePremiumModalIfPresent(page);
    await this.handleCookieConsent(page);

    this.log(context, "Mode 2: switching tab");
    await this.switchMode(page, SELECTORS.secondModeTab);

    this.log(context, "Mode 2: filling input");
    await this.fillInputArea(page, text);

    await this.delay(500);
    this.log(context, "Mode 2: clicking paraphrase");

    // Use the same robust click logic as Mode 1
    let clickSuccess = false;
    for (let i = 0; i < 3; i++) {
      await this.triggerParaphrase(page);

      try {
        await page.waitForFunction(
          (loadingSelectors, copySelectors) => {
            const isLoading = loadingSelectors.some((s) =>
              document.querySelector(s)
            );
            const isDone = copySelectors.some((s) => document.querySelector(s));
            return isLoading || isDone;
          },
          { timeout: 40000 },
          SELECTORS.loadingIndicator,
          SELECTORS.copyButton
        );
        clickSuccess = true;
        break;
      } catch {
        this.log(context, `Mode 2: Click attempt ${i + 1} failed, retrying...`);
        await this.delay(500);
      }
    }

    if (!clickSuccess) {
      this.log(context, "Mode 2: Warning - No loader/result detected");
    }

    await this.closePremiumModalIfPresent(page);

    await this.waitForLoaderToDisappear(page);

    this.log(context, "Mode 2: copying result");
    await this.copyResult(page);
    await this.closePremiumModalIfPresent(page);
    const output = await this.readClipboard(page);
    this.log(context, "Mode 2: clipboard captured");

    this.resetPageState(page, context);

    return output;
  }

  private async runStandardMode(
    page: Page,
    text: string,
    context: string
  ): Promise<string> {
    this.log(context, "Standard mode: ensuring tab active");
    await this.ensureMode(page, SELECTORS.standardModeTab);
    this.log(context, "Standard mode: filling input");
    await this.fillInputArea(page, text);
    await this.closePremiumModalIfPresent(page);
    await this.handleCookieConsent(page);
    this.log(context, "Standard mode: clicking paraphrase");

    let clickSuccess = false;
    for (let i = 0; i < 3; i++) {
      await this.triggerParaphrase(page);

      try {
        await page.waitForFunction(
          (loadingSelectors, copySelectors) => {
            const isLoading = loadingSelectors.some((s) =>
              document.querySelector(s)
            );
            const isDone = copySelectors.some((s) => document.querySelector(s));
            return isLoading || isDone;
          },
          { timeout: 40000 },
          SELECTORS.loadingIndicator,
          SELECTORS.copyButton
        );
        clickSuccess = true;
        break;
      } catch {
        this.log(
          context,
          `Standard mode: Click attempt ${
            i + 1
          } failed to trigger action, retrying...`
        );
        await this.delay(500);
      }
    }

    if (!clickSuccess) {
      this.log(
        context,
        "Standard mode: Warning - No loader or result detected after multiple click attempts"
      );
    }

    await this.closePremiumModalIfPresent(page);
    await this.waitForLoaderToDisappear(page);
    this.log(context, "Standard mode: copying result");
    await this.copyResult(page);
    await this.closePremiumModalIfPresent(page);
    const output = await this.readClipboard(page);
    this.log(context, "Standard mode: clipboard captured");

    this.resetPageState(page, context);

    return output;
  }

  private async typeIntoField(
    page: Page,
    selectors: string[],
    value: string
  ): Promise<void> {
    const field = await this.waitForAnySelector(page, selectors, this.timeout);
    await field.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await this.delay(50);
    await field.type(value, { delay: 10 }); // Add typing delay to mimic human
  }

  private async ensureMode(page: Page, selectors: string[]): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tab = await this.waitForAnySelector(
          page,
          selectors,
          this.timeout
        );
        await tab.click({ delay: 5 });
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
    throw lastError ?? new Error("Failed to switch mode tab");
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
        2000
      );
      await clearButton.click();
    } catch {
      await this.setInputAreaContent(page, "");
    }
  }

  private async triggerParaphrase(page: Page): Promise<void> {
    const button = await this.waitForAnySelector(
      page,
      SELECTORS.paraphraseButton,
      this.timeout
    );

    // Log what we found to help debugging
    const buttonState = await page.evaluate(
      (el) => ({
        html: el.outerHTML.substring(0, 150),
        disabled:
          el.hasAttribute("disabled") ||
          el.getAttribute("aria-disabled") === "true",
        visible: (el as HTMLElement).offsetParent !== null,
      }),
      button
    );

    console.log(
      `Paraphrase button found: disabled=${buttonState.disabled}, visible=${buttonState.visible}`
    );

    if (buttonState.disabled) {
      console.log("Button is disabled! Attempting to wake up input...");
      // Try to trigger input events by typing a space and backspace
      const input = await this.waitForAnySelector(
        page,
        SELECTORS.inputArea,
        2000
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
    const box = await button.boundingBox();
    if (box) {
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;

      // Only log if we need to debug
      // console.log(`Clicking button at ${x}, ${y}`);

      await page.mouse.move(x, y);
      await this.delay(10); // Reduced from 50ms
      await page.mouse.down();
      await this.delay(10); // Reduced from 50ms
      await page.mouse.up();

      // Fallback: Aggressive JS click if mouse didn't work (React sometimes needs this)
      await this.delay(50); // Reduced from 100ms
      await page.evaluate((el) => {
        const event = new MouseEvent("click", {
          view: window,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(event);
      }, button);
    } else {
      // Fallback
      console.log("Native click failed, trying JS click");
      await page.evaluate((el) => (el as HTMLElement).click(), button);
    }
  }

  private async copyResult(page: Page): Promise<void> {
    try {
      const button = await this.waitForAnySelector(
        page,
        SELECTORS.copyButton,
        this.timeout
      );
      await button.click();
      await this.delay(500);
    } catch (error) {
      // Si copyButton no aparece, es un error crítico que indica estado irrecuperable
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        "Failed to find copy button - browser likely in bad state:",
        message
      );
      throw new Error(`Critical: Copy button not found - ${message}`);
    }
  }

  private async readClipboard(page: Page): Promise<string> {
    return page.evaluate(async () => navigator.clipboard.readText());
  }

  private async closePremiumModalIfPresent(page: Page): Promise<void> {
    try {
      const closeButton = await this.waitForAnySelector(
        page,
        SELECTORS.closePremiumModal,
        500
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
        500
      );
      console.log("Cookie consent banner detected, clicking accept/close...");
      await consentButton.click();
      this.cookieConsentHandled = true;

      // Wait for banner to disappear instead of fixed delay
      try {
        await page.waitForFunction(
          (selectors) => !selectors.some((s) => document.querySelector(s)),
          { timeout: 1000 },
          SELECTORS.cookieConsent
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

  private log(context: string, message: string): void {
    console.log(`${message}`);
  }

  private async waitForLoaderToDisappear(
    page: Page,
    timeout = this.loaderWaitTimeout
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
          SELECTORS.loadingIndicator
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
          `Loader still visible after ${maxWait}ms. You can increase loaderWaitTimeout if needed.`
        );
      }

      await this.delay(pollInterval);
    }
  }

  private async setInputAreaContent(page: Page, text: string): Promise<void> {
    const inputArea = await this.waitForAnySelector(
      page,
      SELECTORS.inputArea,
      this.timeout
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
          "[contenteditable='true']"
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
        })
      );
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }, text);
  }

  private async waitForAnySelector(
    page: Page,
    selectors: string[],
    timeout = this.timeout
  ): Promise<ElementHandle<Element>> {
    let lastError: unknown;
    for (const selector of selectors) {
      try {
        const handle = await page.waitForSelector(selector, { timeout });
        if (handle) {
          return handle;
        }
      } catch (error) {
        lastError = error;
      }
    }

    // If we failed to find any selector, take a screenshot for debugging
    try {
      // Also log current URL and title
      const url = page.url();
      const title = await page.title();
      console.log(`Current page state - URL: ${url}, Title: ${title}`);
    } catch (e) {
      console.error("Failed to capture debug info on selector failure:", e);
    }

    throw (
      lastError ??
      new Error(`Unable to find selectors: ${selectors.join(", ")}`)
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
