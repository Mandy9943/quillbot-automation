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
  firstModeTab: ["#Paraphraser-mode-tab-0", "#Paraphraser-mode-tab-0 > div"],
  secondModeTab: ["#Paraphraser-mode-tab-1"],
  inputArea: ["#paraphraser-input-box"],
  clearInputButton: [
    "#paraphraser-input-content > div.MuiBox-root.css-xi6nk4 > button",
  ],
  paraphraseButton: [
    "#controlledInputBoxContainer > div.MuiBox-root.css-1a43h92 > div > div.MuiBox-root.css-n0jqrr > span > div > button",
  ],
  copyButton: [
    "#pphr-view-editor-box > div > div.Pane.vertical.Pane2 > div > div.MuiBox-root.css-3wazsk > div > div > div > span:nth-child(5) > button",
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
}

export class QuillBotAutomation {
  private browser?: Browser;
  private page?: Page;
  private readyPromise?: Promise<void>;
  private taskQueue: Promise<unknown> = Promise.resolve();
  private readonly timeout: number;

  constructor(private readonly options: QuillBotAutomationOptions) {
    this.timeout = options.timeout ?? 10000;
  }

  async init(): Promise<void> {
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
  }

  async paraphrase(text: string, requestId?: string): Promise<ParaphraseResult> {
    if (!text.trim()) {
      throw new Error("Input text must not be empty.");
    }

    await this.init();

    const context = requestId ?? `paraphrase-${Date.now()}`;
    this.log(context, `Queued request (length: ${text.length} chars)`);

    const task = async () => {
      const page = this.getPage();
      this.log(context, "Starting mode 1 flow");
      const firstModeOutput = await this.runFirstMode(page, text, context);
      this.log(context, "Mode 1 complete, starting mode 2 flow");
      const secondModeOutput = await this.runSecondMode(page, firstModeOutput, context);
      this.log(context, "Mode 2 complete");
      return {
        firstMode: firstModeOutput,
        secondMode: secondModeOutput,
      } satisfies ParaphraseResult;
    };

    const run = this.taskQueue.then(() => task());
    this.taskQueue = run.catch(() => undefined);
    return run;
  }

  private async setup(): Promise<void> {
    try {
      this.browser = await puppeteer.launch({
        headless: this.options.headless ?? true,
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
      await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });
      await page.evaluate(() => {
        localStorage.setItem("DONT_SHOW_DELETE_REMINDER_AGAIN", "true");
      });

      await this.typeIntoField(page, SELECTORS.email, this.options.email);
      await this.typeIntoField(page, SELECTORS.password, this.options.password);

      const loginButton = await this.waitForAnySelector(
        page,
        SELECTORS.loginButton,
        this.timeout
      );

      console.log("loginButton");

      await loginButton.click();

      await page.goto(PARAPHRASER_URL, { waitUntil: "networkidle2" });
      await this.closePremiumModalIfPresent(page);
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

  private async runFirstMode(page: Page, text: string, context: string): Promise<string> {
    this.log(context, "Mode 1: ensuring tab active");
    await this.ensureMode(page, SELECTORS.firstModeTab);
    this.log(context, "Mode 1: filling input");
    await this.fillInputArea(page, text);
    await this.closePremiumModalIfPresent(page);
    this.log(context, "Mode 1: clicking paraphrase");
    await this.triggerParaphrase(page);
    await this.closePremiumModalIfPresent(page);
    this.log(context, "Mode 1: copying result");
    await this.copyResult(page);
    await this.closePremiumModalIfPresent(page);
    const output = await this.readClipboard(page);
    this.log(context, "Mode 1: clipboard captured");
    return output;
  }

  private async runSecondMode(page: Page, text: string, context: string): Promise<string> {
    this.log(context, "Mode 2: switching tab");
    await this.switchMode(page, SELECTORS.secondModeTab);
    this.log(context, "Mode 2: clearing input");
    await this.clearInputArea(page);
    this.log(context, "Mode 2: filling input");
    await this.fillInputArea(page, text);
    await this.delay(1000);
    this.log(context, "Mode 2: clicking paraphrase");
    await this.triggerParaphrase(page);
    await this.closePremiumModalIfPresent(page);
    await this.delay(3000);
    await this.closePremiumModalIfPresent(page);
    this.log(context, "Mode 2: copying result");
    await this.copyResult(page);
    await this.closePremiumModalIfPresent(page);
    const output = await this.readClipboard(page);
    this.log(context, "Mode 2: clipboard captured");
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
    await field.type(value);
  }

  private async ensureMode(page: Page, selectors: string[]): Promise<void> {
    const tab = await this.waitForAnySelector(page, selectors, this.timeout);
    await tab.click();
  }

  private async switchMode(page: Page, selectors: string[]): Promise<void> {
    await this.ensureMode(page, selectors);
  }

  private async fillInputArea(page: Page, text: string): Promise<void> {
    const inputArea = await this.waitForAnySelector(
      page,
      SELECTORS.inputArea,
      this.timeout
    );
    await inputArea.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await inputArea.type(text);
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
      const inputArea = await this.waitForAnySelector(
        page,
        SELECTORS.inputArea,
        this.timeout
      );
      await inputArea.click({ clickCount: 3 });
      await page.keyboard.press("Backspace");
    }
  }

  private async triggerParaphrase(page: Page): Promise<void> {
    const button = await this.waitForAnySelector(
      page,
      SELECTORS.paraphraseButton,
      this.timeout
    );
    await button.click();
  }

  private async copyResult(page: Page): Promise<void> {
    const button = await this.waitForAnySelector(
      page,
      SELECTORS.copyButton,
      this.timeout
    );
    await button.click();
    await this.delay(500);
  }

  private async readClipboard(page: Page): Promise<string> {
    return page.evaluate(async () => navigator.clipboard.readText());
  }

  private async closePremiumModalIfPresent(page: Page): Promise<void> {
    try {
      const closeButton = await this.waitForAnySelector(
        page,
        SELECTORS.closePremiumModal,
        1500
      );
      await closeButton.click();
      await this.delay(200);
    } catch {
      // Ignore if modal is not present.
    }
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private log(context: string, message: string): void {
    console.log(`[${new Date().toISOString()}][${context}] ${message}`);
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

    throw (
      lastError ??
      new Error(`Unable to find selectors: ${selectors.join(", ")}`)
    );
  }
}
