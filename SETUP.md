# QuillBot Automation - Session Persistence Setup

This document explains how to configure session persistence to avoid the "max 10 sessions" limit on QuillBot.

## The Problem

QuillBot limits accounts to **10 concurrent sessions**. Without session persistence:

- Every app restart creates a new session
- After ~10 restarts, all sessions are consumed
- The app crashes with "unable to login" error

## The Solution

The app now supports **session persistence** through **cookie backup**:

1. **Cookie save/restore** - saves cookies to a JSON file after login
2. **Smart login detection** - skips login if session is still valid
3. **Automatic restoration** - loads cookies on startup to restore session

> **Note**: We intentionally do NOT use Chrome's `userDataDir` because it causes `SingletonLock` issues when containers restart with persistent volumes.

---

## Local Development Setup

### Option 1: Using docker-compose (Recommended)

```bash
# The docker-compose.yml already has volumes configured
docker-compose up -d

# Sessions will persist in Docker volume:
# - sessions-data:/app/sessions
```

### Option 2: Running directly with Node.js

```bash
# Sessions will be stored in ./sessions folder
npm run dev

# Or with custom path (optional)
SESSIONS_DIR=./my-sessions npm run dev
```

The directory is automatically created and added to `.gitignore`.

---

## Coolify Deployment Setup

Since you're deploying with **Dockerfile only** in Coolify, you need to configure persistent storage manually:

### Step 1: Add Persistent Storage

1. Go to your application in Coolify
2. Click **"Persistent Storage"** in the left menu
3. Click **"+ Add"** → **"Volume Mount"**
4. Add one volume:

| Name            | Destination Path |
| --------------- | ---------------- |
| `sessions-data` | `/app/sessions`  |

### Step 2: Add Environment Variables (Optional)

Go to **"Environment Variables"** and add:

| Variable       | Value           |
| -------------- | --------------- |
| `SESSIONS_DIR` | `/app/sessions` |

> Note: This is optional - the default already points to this path.

### Step 3: Redeploy

Click **"Redeploy"** to apply the changes.

### Step 4: Verify

After the first login, check the logs. You should see:

```
Saved X cookies to /app/sessions/cookies.json
Login successful - cookies saved for session persistence
```

On subsequent restarts, you should see:

```
Loaded X cookies from /app/sessions/cookies.json
Checking if already logged in...
Already logged in - session restored successfully!
Session restored from cookies - skipping login!
```

---

## Troubleshooting

### Session not persisting after redeploy

- Make sure you're using **"Restart"** not **"Redeploy"** for quick restarts
- Check if persistent storage is correctly configured in Coolify
- Verify the volume exists: check the container's mounts

### Still hitting session limit

1. **Wait for sessions to expire** - QuillBot sessions have a TTL
2. **Log out from other devices** - Go to QuillBot website and log out from all sessions
3. **Delete cookies file** - Remove `/app/sessions/cookies.json` and restart

### Cookies file not created

- Check file permissions in the container
- Verify the directory exists: `/app/sessions`
- Check application logs for errors

---

## Environment Variables Reference

| Variable            | Default      | Description                  |
| ------------------- | ------------ | ---------------------------- |
| `SESSIONS_DIR`      | `./sessions` | Cookie backup directory      |
| `QUILLBOT_EMAIL`    | (required)   | QuillBot account email       |
| `QUILLBOT_PASSWORD` | (required)   | QuillBot account password    |
| `HEADLESS`          | `true`       | Run browser in headless mode |
| `PORT`              | `3000`       | API server port              |

---

## How It Works

1. **On startup**: The app checks for saved cookies in `/app/sessions/cookies.json`
2. **If cookies exist**: Loads them and navigates to paraphraser to check if session is valid
3. **If session valid**: Skips login completely (saves a session slot!)
4. **If session invalid**: Performs full login and saves new cookies
5. **On shutdown**: Cookies are saved for next startup
