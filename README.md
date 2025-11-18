# QuillBot Automation API

This project exposes an Express API that keeps a single puppeteer-driven QuillBot session alive. The browser logs in once, stays on the paraphrasing page, and every request reuses the session to paraphrase the provided text through the two modes described in the original script.

## Features

- **Persistent browser**: Launches Chromium once, logs into QuillBot, and keeps the session open for subsequent requests.
- **Two-step paraphrasing**: Mimics the manual workflow—paraphrases the incoming text in mode 1, copies the output, feeds it into mode 2, and returns both results.
- **Queueing & serialization**: Requests are processed sequentially to avoid DOM race conditions while reusing the same page.
- **Health endpoint**: Quickly verify that the browser session finished bootstrapping.

## Requirements

- Node.js 18+
- A QuillBot account with credentials that can log in without MFA/CAPTCHA prompts.
- The ability to run Chromium headless (usually works out-of-the-box on Linux servers with Puppeteer).

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` file based on `.env.example`:

   ```bash
   cp .env.example .env
   ```

   | Variable | Description |
   | --- | --- |
   | `QUILLBOT_EMAIL` | Account email used to log in. |
   | `QUILLBOT_PASSWORD` | Account password. |
   | `PORT` | Port for the Express server (default `3000`). |
   | `HEADLESS` | Set to `false` for debugging with a visible browser. |

## Running

### Local Development (ts-node)

```bash
npm run dev
```

### Production Build + Start

```bash
npm run build
npm start
```

### Docker (Recommended for Production)

The application is fully containerized with all Chromium dependencies included.

1. **Build and run with Docker Compose:**

   ```bash
   docker-compose up --build
   ```

   The API will be available at `http://localhost:3000`.

2. **Or build and run manually:**

   ```bash
   # Build the image
   docker build -t quillbot-automation .
   
   # Run the container
   docker run -d \
     -p 3000:3000 \
     -e QUILLBOT_EMAIL="your_email@example.com" \
     -e QUILLBOT_PASSWORD="your_password" \
     -e HEADLESS=true \
     --shm-size=2gb \
     --cap-add=SYS_ADMIN \
     --name quillbot-automation \
     quillbot-automation
   ```

3. **Check logs:**

   ```bash
   docker logs -f quillbot-automation
   ```

4. **Stop the container:**

   ```bash
   docker-compose down
   # or
   docker stop quillbot-automation
   ```

**Note:** The Docker image includes Chromium and all required system libraries, ensuring consistent behavior across environments (local, cloud, CI/CD).

## API

### `GET /health`

Returns `{ status: "ok", ready: boolean }` so you can wait until the initial login completes.

### `POST /paraphrase`

Body:

```json
{
  "text": "String with the content to paraphrase"
}
```

Response:

```json
{
  "inputLength": 123,
  "firstMode": "...",
  "secondMode": "..."
}
```

Errors return a JSON payload with an `error` field and an appropriate HTTP status code.

## How it works

- `QuillBotAutomation` (see `src/quillbotAutomation.ts`) owns the Puppeteer browser.
- On startup, it logs in, lands on the paraphraser page, selects the first mode, and grants clipboard permissions.
- Incoming requests are enqueued so they run one-at-a-time against the same tab.
- The original manual flow (type text → paraphrase → copy → switch mode → clear → paste → paraphrase → copy) is reproduced step by step.

## Next steps / ideas

- Persist cookies/session on disk to survive restarts.
- Add retries for transient DOM failures or selector drift.
- Stream the paraphrase progress back to the client.
- Replace hard-coded selectors with a more resilient lookup strategy.
