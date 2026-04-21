// server.js  –  Local yt-dlp web interface
// Usage: node server.js   then open http://localhost:3000

const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const app = express();
const PORT = 3000;

const DOWNLOAD_DIR  = path.join(os.homedir(), "Downloads");
const COOKIES_PATH  = path.join(__dirname, "cookies.txt");  // persisted upload location

const QUALITY_MAP = {
  best:  "bestvideo+bestaudio/best",
  "4k":  "bestvideo[height<=2160]+bestaudio/best",
  "1440":"bestvideo[height<=1440]+bestaudio/best",
  "1080":"bestvideo[height<=1080]+bestaudio/best",
  "720": "bestvideo[height<=720]+bestaudio/best",
  "480": "bestvideo[height<=480]+bestaudio/best",
  "360": "bestvideo[height<=360]+bestaudio/best",
};

// Chrome first — Safari's cookies are sandboxed on macOS and often cause permission errors
const BROWSERS = ["chrome", "firefox", "brave", "edge", "chromium", "opera", "safari"];

// Windows needs shell:true to resolve binaries like yt-dlp.exe from PATH
const SPAWN_OPTS = { shell: process.platform === "win32" };

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Cookie args: use uploaded file if present, else try browsers ─────────────
function hasCookieFile() {
  return fs.existsSync(COOKIES_PATH);
}

function cookieArgs(browser) {
  return hasCookieFile()
    ? ["--cookies", COOKIES_PATH]
    : ["--cookies-from-browser", browser];
}

// ── Helper: try yt-dlp with each browser, fallback to cookie file ────────────
function ytdlpWithFallback(args) {
  return new Promise((resolve, reject) => {

    // If a cookie file is already uploaded, use it directly — no browser loop
    if (hasCookieFile()) {
      console.log("  → Using uploaded cookies.txt");
      const proc = spawn("yt-dlp", ["--cookies", COOKIES_PATH, ...args], SPAWN_OPTS);
      let stdout = "", stderr = "";
      proc.stdout.on("data", (d) => (stdout += d));
      proc.stderr.on("data", (d) => (stderr += d));
      proc.on("close", (code) => {
        if (code === 0 && stdout.trim()) return resolve({ stdout, browser: "cookies.txt" });
        // Surface as AUTH_FAILED so the frontend can prompt for new cookies
        reject(Object.assign(
          new Error(stderr || "yt-dlp failed with cookie file"),
          { authFailed: true }
        ));
      });
      proc.on("error", (e) =>
        reject(Object.assign(new Error(e.message), { authFailed: true }))
      );
      return;
    }

    // Otherwise try browsers one by one
    let index = 0;

    function tryNext() {
      if (index >= BROWSERS.length) {
        return reject(Object.assign(
          new Error("AUTH_FAILED"),
          { authFailed: true }
        ));
      }

      const browser = BROWSERS[index++];
      console.log(`  → Trying cookies from ${browser}…`);

      const proc = spawn("yt-dlp", ["--cookies-from-browser", browser, ...args], SPAWN_OPTS);
      let stdout = "", stderr = "";
      proc.stdout.on("data", (d) => (stdout += d));
      proc.stderr.on("data", (d) => (stderr += d));

      proc.on("close", (code) => {
        if (code === 0 && stdout.trim()) {
          console.log(`  ✓ Success with ${browser}`);
          return resolve({ stdout, browser });
        }

        const isAuthError =
          stderr.includes("Sign in to confirm") ||
          stderr.includes("bot") ||
          stderr.includes("cookies") ||
          stderr.includes("403") ||
          stderr.includes("Operation not permitted") ||
          stderr.includes("Errno 1") ||
          stderr.includes("could not find") ||
          stderr.includes("cookies database");

        if (isAuthError) return tryNext();
        reject(new Error(stderr || "yt-dlp failed"));
      });

      proc.on("error", () => tryNext());
    }

    tryNext();
  });
}

// ── Helper: streaming download with auto browser / cookie file fallback ───────
function ytdlpDownloadWithFallback(args, onData, onDone, onError) {
  let index = 0;
  let hasProgress = false;
  let killed = false;
  let currentProc = null;

  function tryWith(cookieArgList, label) {
    if (killed) return;
    console.log(`  → Download: trying ${label}…`);

    const proc = spawn("yt-dlp", [...cookieArgList, ...args], SPAWN_OPTS);
    currentProc = proc;
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.includes("%")) hasProgress = true;
      onData(text, label);
    });

    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (killed) return;
      if (code === 0) return onDone(label);

      const isAuthError = !hasProgress && (
        stderr.includes("Sign in to confirm") ||
        stderr.includes("bot") ||
        stderr.includes("403") ||
        stderr.includes("Operation not permitted") ||
        stderr.includes("Errno 1") ||
        stderr.includes("could not find") ||
        stderr.includes("cookies database")
      );

      if (isAuthError) {
        console.log(`  ✗ Auth failed with ${label}`);
        hasProgress = false;
        // If we were already using the cookie file, don't loop — surface the error
        if (label === "cookies.txt") {
          return onError("AUTH_FAILED");
        }
        tryNext();
      } else {
        onError(stderr || "Download failed.");
      }
    });

    proc.on("error", () => { if (!killed) { if (label === "cookies.txt") onError("AUTH_FAILED"); else tryNext(); } });
  }

  function tryNext() {
    if (killed) return;

    // Cookie file was uploaded — use it
    if (hasCookieFile()) {
      return tryWith(["--cookies", COOKIES_PATH], "cookies.txt");
    }

    if (index >= BROWSERS.length) {
      return onError("AUTH_FAILED");
    }

    const browser = BROWSERS[index++];
    tryWith(["--cookies-from-browser", browser], browser);
  }

  tryNext();
  return () => { killed = true; if (currentProc) currentProc.kill(); };
}

// ── POST /upload-cookies  ────────────────────────────────────────────────────
// Accepts a raw cookies.txt upload (multipart via fetch)
app.post("/upload-cookies", express.raw({ type: "*/*", limit: "5mb" }), (req, res) => {
  try {
    fs.writeFileSync(COOKIES_PATH, req.body);
    console.log("  ✓ cookies.txt saved");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /has-cookies  ────────────────────────────────────────────────────────
app.get("/has-cookies", (req, res) => {
  res.json({ hasCookies: hasCookieFile() });
});

// ── GET /info?url=...  ──────────────────────────────────────────────────────
app.get("/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url" });

  try {
    const { stdout, browser } = await ytdlpWithFallback([
      "--dump-json", "--no-playlist", url,
    ]);

    const info = JSON.parse(stdout);
    res.json({
      title:     info.title,
      thumbnail: info.thumbnail,
      duration:  info.duration_string || "",
      uploader:  info.uploader || "",
      id:        info.id,
      browser,
    });
  } catch (err) {
    if (err.authFailed || err.message === "AUTH_FAILED") {
      return res.status(401).json({ error: "AUTH_FAILED" });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── GET /download  (SSE stream) ─────────────────────────────────────────────
app.get("/download", (req, res) => {
  const { url, quality = "best", format = "mp4" } = req.query;
  if (!url) return res.status(400).end();

  const isMP3 = format === "mp3";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (type, data) =>
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  send("start", { message: "Finding working browser cookies…" });

  // On Windows, spawn uses cmd.exe which joins args with spaces — the output
  // template contains a space ("%(title)s [%(id)s].%(ext)s"), so it must be
  // quoted or cmd.exe splits it and yt-dlp treats the tail as a URL.
  const outputTemplate = path.join(DOWNLOAD_DIR, "%(title)s [%(id)s].%(ext)s");
  const outputArg = process.platform === "win32" ? `"${outputTemplate}"` : outputTemplate;

  const baseArgs = isMP3
    ? ["--no-playlist", "--format", "bestaudio/best",
       "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0",
       "--output", outputArg,
       "--windows-filenames", "--newline", url]
    : ["--no-playlist", "--format", QUALITY_MAP[quality] || quality,
       "--merge-output-format", "mp4",
       "--output", outputArg,
       "--windows-filenames", "--newline", url];

  let notifiedBrowser = false;

  const kill = ytdlpDownloadWithFallback(
    baseArgs,
    (text, label) => {
      if (!notifiedBrowser) {
        send("info", { message: `Authenticated via ${label}` });
        notifiedBrowser = true;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const m = line.match(/\[download\]\s+([\d.]+)%.*?at\s+([\d.]+\s*\S+\/s).*?ETA\s+(\S+)/);
        if (m) { send("progress", { percent: parseFloat(m[1]), speed: m[2], eta: m[3] }); continue; }
        if (line.includes("[download] Destination:"))
          send("info", { message: `Saving: ${path.basename(line.replace("[download] Destination:", "").trim())}` });
        if (line.includes("Merging") || line.includes("ffmpeg"))
          send("info", { message: "Merging audio & video…" });
      }
    },
    (label) => {
      send("done", { message: `Saved to ~/Downloads as ${isMP3 ? "MP3" : "MP4"} ✓` });
      res.end();
    },
    (errMsg) => {
      if (errMsg === "AUTH_FAILED") {
        send("auth_failed", { message: "AUTH_FAILED" });
      } else {
        send("error", { message: errMsg });
      }
      res.end();
    }
  );

  req.on("close", () => kill && kill());
});

app.listen(PORT, () => {
  console.log(`\n  ✓  YT Downloader running at http://localhost:${PORT}\n`);
  if (hasCookieFile()) {
    console.log("  ✓  cookies.txt found — will use it for authentication\n");
  }
});
