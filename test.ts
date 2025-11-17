import puppeteer, { Page } from "puppeteer";

const waitForAnySelector = async (
  page: Page,
  selectors: string[],
  timeout: number
) => {
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
    lastError ?? new Error(`Unable to find selectors: ${selectors.join(", ")}`)
  );
};

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
  });
  const page = await browser.newPage();
  const timeout = 10000;
  page.setDefaultTimeout(timeout);
  const context = browser.defaultBrowserContext();
  await context.overridePermissions("https://quillbot.com", [
    "clipboard-read",
    "clipboard-write",
  ]);

  {
    const targetPage = page;
    await targetPage.setViewport({
      width: 1920,
      height: 1080,
    });
  }
  {
    const targetPage = page;
    await targetPage.goto("https://quillbot.com/login");
    await targetPage.evaluate(() => {
      localStorage.setItem("DONT_SHOW_DELETE_REMINDER_AGAIN", "true");
    });
  }

  {
    const targetPage = page;
    const emailSelectors = ['input[type="email"]'];
    const emailField = await waitForAnySelector(
      targetPage,
      emailSelectors,
      timeout
    );

    await emailField.type("salut@paylinks.ro");
  }
  {
    const targetPage = page;
    const passwordSelectors = ['input[type="password"]'];
    const passwordField = await waitForAnySelector(
      targetPage,
      passwordSelectors,
      timeout
    );
    await passwordField.type("Ub$9MKyRGs.2T.9");
  }
  {
    const targetPage = page;
    const loginSelectors = [
      "#loginContainer > div.MuiGrid-root.MuiGrid-container.css-1d3bbye > div.MuiGrid-root.MuiGrid-item.css-koo75d > div.MuiGrid-root.MuiGrid-item.MuiGrid-grid-xs-4.MuiGrid-grid-sm-8.MuiGrid-grid-md-12.css-adow25 > button",
    ];
    const loginButton = await waitForAnySelector(
      targetPage,
      loginSelectors,
      timeout
    );
    await loginButton.click();
  }

  {
    const targetPage = page;
    await targetPage.goto("https://quillbot.com/paraphrasing-tool");
  }

  {
    try {
      const targetPage = page;
      const closeModalSelectors = [
        "body > div.MuiModal-root.MuiDialog-root.css-1056mjz > div.MuiDialog-container.MuiDialog-scrollPaper.css-ekeie0 > div > div.MuiBox-root.css-1q9qc6z > div > button",
      ];
      const closePremium = await waitForAnySelector(
        targetPage,
        closeModalSelectors,
        1500
      );
      await closePremium.click();
    } catch (error) {
      console.log("No premium modal to close.");
    }
  }

  {
    const targetPage = page;
    const firstModeSelectors = ["#Paraphraser-mode-tab-0 > div"];
    const firstMode = await waitForAnySelector(
      targetPage,
      firstModeSelectors,
      timeout
    );
    await firstMode.click();
  }

  //   //   input the text to be paraphrased
  console.log("Input the text to be paraphrased");

  {
    const targetPage = page;
    const inputAreaSelectors = ["#paraphraser-input-box"];
    const inputArea = await waitForAnySelector(
      targetPage,
      inputAreaSelectors,
      timeout
    );
    const textToParaphrase = `Artificial intelligence (AI) refers to the simulation of human intelligence in machines that are programmed to think and learn like humans. These intelligent machines can perform tasks that typically require human intelligence, such as problem-solving, decision-making, language understanding, and visual perception. AI can be categorized into two main types: narrow AI, which is designed for specific tasks (like virtual assistants or recommendation systems), and general AI, which aims to possess the ability to perform any intellectual task that a human can do. The development of AI has the potential to revolutionize various industries, including healthcare, finance, transportation, and entertainment, by improving efficiency and enabling new capabilities. However, it also raises ethical concerns regarding privacy, job displacement, and the potential for biased decision-making.`;
    await inputArea.type(textToParaphrase);
  }

  {
    try {
      const targetPage = page;
      const closeModalSelectors = [
        "body > div.MuiModal-root.MuiDialog-root.css-1056mjz > div.MuiDialog-container.MuiDialog-scrollPaper.css-ekeie0 > div > div.MuiBox-root.css-1q9qc6z > div > button",
      ];
      const closePremium = await waitForAnySelector(
        targetPage,
        closeModalSelectors,
        1500
      );
      await closePremium.click();
    } catch (error) {
      console.log("No premium modal to close.");
    }
  }

  //   //   click the paraphrase button
  console.log("Clicking paraphrase button");

  {
    const targetPage = page;
    const paraphraseButtonSelectors = [
      "#controlledInputBoxContainer > div.MuiBox-root.css-1a43h92 > div > div.MuiBox-root.css-n0jqrr > span > div > button",
    ];
    const paraphraseButton = await waitForAnySelector(
      targetPage,
      paraphraseButtonSelectors,
      timeout
    );
    await paraphraseButton.click();
  }

  //   close premium modal if it appears
  {
    try {
      const targetPage = page;
      const closeModalSelectors = [
        "body > div.MuiModal-root.MuiDialog-root.css-1056mjz > div.MuiDialog-container.MuiDialog-scrollPaper.css-ekeie0 > div > div.MuiBox-root.css-1q9qc6z > div > button",
      ];
      const closePremium = await waitForAnySelector(
        targetPage,
        closeModalSelectors,
        1500
      );
      await closePremium.click();
    } catch (error) {
      console.log("No premium modal to close.");
    }
  }

  //   copy the paraphrased text with copy button
  console.log("Copying paraphrased text");
  {
    const targetPage = page;
    const copyButtonSelectors = [
      "#pphr-view-editor-box > div > div.Pane.vertical.Pane2 > div > div.MuiBox-root.css-3wazsk > div > div > div > span:nth-child(5) > button",
    ];
    const copyButton = await waitForAnySelector(
      targetPage,
      copyButtonSelectors,
      10000
    );
    await copyButton.click();
  }

  //   close premium modal if it appears
  {
    try {
      const targetPage = page;
      const closeModalSelectors = [
        "body > div.MuiModal-root.MuiDialog-root.css-1056mjz > div.MuiDialog-container.MuiDialog-scrollPaper.css-ekeie0 > div > div.MuiBox-root.css-1q9qc6z > div > button",
      ];
      const closePremium = await waitForAnySelector(
        targetPage,
        closeModalSelectors,
        1500
      );
      await closePremium.click();
    } catch (error) {
      console.log("No premium modal to close.");
    }
  }

  //   check the clipboard content
  console.log("Checking clipboard content");
  let clipboardContentFromFirstMode = "";
  {
    const targetPage = page;
    clipboardContentFromFirstMode = await targetPage.evaluate(() =>
      navigator.clipboard.readText()
    );
    console.log("Clipboard content:", clipboardContentFromFirstMode);
  }

  //   Select second mode
  console.log("Selecting second mode");
  {
    const targetPage = page;
    const secondModeSelectors = ["#Paraphraser-mode-tab-1"];
    const secondMode = await waitForAnySelector(
      targetPage,
      secondModeSelectors,
      timeout
    );
    await secondMode.click();
  }

  //   clear the input area
  console.log("Clearing input area");
  {
    const targetPage = page;
    const cleanButtonSelectors = [
      "#paraphraser-input-content > div.MuiBox-root.css-xi6nk4 > button",
    ];
    const clearButton = await waitForAnySelector(
      targetPage,
      cleanButtonSelectors,
      timeout
    );
    await clearButton.click();
  }

  //   //   input the text to be paraphrased
  console.log("Input the text to be paraphrased in second mode");

  {
    const targetPage = page;
    const inputAreaSelectors = ["#paraphraser-input-box"];
    const inputArea = await waitForAnySelector(
      targetPage,
      inputAreaSelectors,
      timeout
    );
    const textToParaphrase = clipboardContentFromFirstMode;
    await inputArea.type(textToParaphrase);
  }

  //   small delay to ensure the text is fully inputted
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("Clicking paraphrase button in second mode");

  //  click the paraphrase button again
  {
    const targetPage = page;
    const paraphraseButtonSelectors = [
      "#controlledInputBoxContainer > div.MuiBox-root.css-1a43h92 > div > div.MuiBox-root.css-n0jqrr > span > div > button",
    ];
    const paraphraseButton = await waitForAnySelector(
      targetPage,
      paraphraseButtonSelectors,
      timeout
    );
    await paraphraseButton.click();
  }

  //   close premium modal if it appears
  {
    try {
      const targetPage = page;
      const closeModalSelectors = [
        "body > div.MuiModal-root.MuiDialog-root.css-1056mjz > div.MuiDialog-container.MuiDialog-scrollPaper.css-ekeie0 > div > div.MuiBox-root.css-1q9qc6z > div > button",
      ];
      const closePremium = await waitForAnySelector(
        targetPage,
        closeModalSelectors,
        1500
      );
      await closePremium.click();
    } catch (error) {
      console.log("No premium modal to close.");
    }
  }

  //   delay to ensure clipboard is updated
  await new Promise((resolve) => setTimeout(resolve, 3000));

  //   close premium modal if it appears
  {
    try {
      const targetPage = page;
      const closeModalSelectors = [
        "body > div.MuiModal-root.MuiDialog-root.css-1056mjz > div.MuiDialog-container.MuiDialog-scrollPaper.css-ekeie0 > div > div.MuiBox-root.css-1q9qc6z > div > button",
      ];
      const closePremium = await waitForAnySelector(
        targetPage,
        closeModalSelectors,
        1500
      );
      await closePremium.click();
    } catch (error) {
      console.log("No premium modal to close.");
    }
  }

  //   copy the paraphrased text with copy button
  console.log("Copying paraphrased text in second mode");
  {
    const targetPage = page;
    const copyButtonSelectors = [
      "#pphr-view-editor-box > div > div.Pane.vertical.Pane2 > div > div.MuiBox-root.css-3wazsk > div > div > div > span:nth-child(5) > button",
    ];
    const copyButton = await waitForAnySelector(
      targetPage,
      copyButtonSelectors,
      10000
    );
    await copyButton.click();
  }

  //   close premium modal if it appears
  {
    try {
      const targetPage = page;
      const closeModalSelectors = [
        "body > div.MuiModal-root.MuiDialog-root.css-1056mjz > div.MuiDialog-container.MuiDialog-scrollPaper.css-ekeie0 > div > div.MuiBox-root.css-1q9qc6z > div > button",
      ];
      const closePremium = await waitForAnySelector(
        targetPage,
        closeModalSelectors,
        1500
      );
      await closePremium.click();
    } catch (error) {
      console.log("No premium modal to close.");
    }
  }

  //   check the clipboard content
  console.log("Checking clipboard content from second mode");
  let clipboardContentFromSecondMode = "";
  {
    const targetPage = page;
    clipboardContentFromSecondMode = await targetPage.evaluate(() =>
      navigator.clipboard.readText()
    );
    console.log("Clipboard content:", clipboardContentFromSecondMode);
  }

  //   await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
