import cors from "cors";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import { performance } from "node:perf_hooks";

import { ParaphraseResult, QuillBotAutomation } from "./quillbotAutomation";

dotenv.config();

const email = process.env.QUILLBOT_EMAIL;
const password = process.env.QUILLBOT_PASSWORD;
const headless = process.env.HEADLESS !== "false";
const port = Number(process.env.PORT ?? 3000);

if (!email || !password) {
  console.error(
    "QUILLBOT_EMAIL and QUILLBOT_PASSWORD must be set in environment variables."
  );
  process.exit(1);
}

const automation = new QuillBotAutomation({ email, password, headless });
let isReady = false;

const readyPromise = automation
  .init()
  .then(() => {
    isReady = true;
    console.log("QuillBot session initialized and ready to accept requests.");
  })
  .catch((error) => {
    console.error("Unable to initialize QuillBot session:", error);
    process.exit(1);
  });

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", ready: isReady });
});

app.get("/debug/screenshot", (_req: Request, res: Response) => {
  const path = require("path");
  const fs = require("fs");
  const screenshotPath = path.resolve("error_screenshot.png");

  if (fs.existsSync(screenshotPath)) {
    res.sendFile(screenshotPath);
  } else {
    res.status(404).send("No error screenshot available");
  }
});

app.get("/debug/list-screenshots", (_req: Request, res: Response) => {
  const fs = require("fs");
  const path = require("path");
  const dir = process.cwd();

  try {
    const files = fs
      .readdirSync(dir)
      .filter(
        (file: string) =>
          (file.startsWith("error_") || file.startsWith("debug_")) &&
          file.endsWith(".png")
      )
      .map((file: string) => ({
        name: file,
        url: `/debug/view/${file}`,
        time: fs.statSync(path.join(dir, file)).mtime,
      }))
      .sort((a: any, b: any) => b.time - a.time);

    res.json(files);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/debug/view/:filename", (req: Request, res: Response) => {
  const path = require("path");
  const fs = require("fs");
  const filename = req.params.filename;

  // Basic security check
  if (
    (!filename.startsWith("error_") && !filename.startsWith("debug_")) ||
    !filename.endsWith(".png") ||
    filename.includes("..")
  ) {
    return res.status(400).send("Invalid filename");
  }

  const filePath = path.resolve(filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send("File not found");
  }
});

app.post("/paraphrase", async (req: Request, res: Response) => {
  const { text } = req.body ?? {};
  if (typeof text !== "string" || !text.trim()) {
    return res
      .status(400)
      .json({ error: "Field 'text' must be a non-empty string." });
  }

  const requestId = randomUUID();
  const startTime = performance.now();
  console.log(
    `[${requestId}] Received paraphrase request (length: ${text.length})`
  );

  try {
    await readyPromise;
    const result: ParaphraseResult = await automation.paraphrase(
      text,
      requestId
    );
    const durationMs = Math.round(performance.now() - startTime);
    console.log(`[${requestId}] Paraphrase completed in ${durationMs} ms`);
    res.json({
      inputLength: text.length,
      firstMode: result.firstMode,
      secondMode: result.secondMode,
      durationMs,
    });
  } catch (error) {
    const durationMs = Math.round(performance.now() - startTime);
    console.error("Paraphrasing request failed:", error);
    console.error(`[${requestId}] Request failed after ${durationMs} ms`);
    res
      .status(500)
      .json({ error: "Failed to process paraphrasing request.", durationMs });
  }
});

app.post("/paraphrase-standard", async (req: Request, res: Response) => {
  const { text } = req.body ?? {};
  if (typeof text !== "string" || !text.trim()) {
    return res
      .status(400)
      .json({ error: "Field 'text' must be a non-empty string." });
  }

  const requestId = randomUUID();
  const startTime = performance.now();
  console.log(
    `[${requestId}] Received standard mode paraphrase request (length: ${text.length})`
  );

  try {
    await readyPromise;
    const result: string = await automation.paraphraseStandardMode(
      text,
      requestId
    );
    const durationMs = Math.round(performance.now() - startTime);
    console.log(
      `[${requestId}] Standard mode paraphrase completed in ${durationMs} ms`
    );
    res.json({
      inputLength: text.length,
      output: result,
      durationMs,
    });
  } catch (error) {
    const durationMs = Math.round(performance.now() - startTime);
    console.error("Standard mode paraphrasing request failed:", error);
    console.error(`[${requestId}] Request failed after ${durationMs} ms`);
    res
      .status(500)
      .json({
        error: "Failed to process standard mode paraphrasing request.",
        durationMs,
      });
  }
});

app.post("/restart", async (_req: Request, res: Response) => {
  console.log("Restart requested - disposing current browser session...");
  try {
    await automation.dispose();
    isReady = false;
    console.log("Browser disposed, reinitializing...");
    
    // Reinitialize
    const initPromise = automation
      .init()
      .then(() => {
        isReady = true;
        console.log("Browser restarted and ready.");
      })
      .catch((error) => {
        console.error("Failed to restart browser:", error);
        throw error;
      });
    
    // Update the global readyPromise
    (global as any).readyPromise = initPromise;
    
    await initPromise;
    res.json({ status: "ok", message: "Browser restarted successfully" });
  } catch (error) {
    console.error("Restart failed:", error);
    res.status(500).json({ 
      error: "Failed to restart browser",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

const server = app.listen(port, () => {
  console.log(`Express API listening on http://localhost:${port}`);
});

const shutdown = async () => {
  console.log("Shutting down server...");
  server.close();
  await automation.dispose();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
