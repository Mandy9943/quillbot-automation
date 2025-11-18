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
