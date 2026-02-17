// server.js  –  Local yt-dlp web interface
// Usage: node server.js   then open http://localhost:3000

const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");

const app = express();
const PORT = 3000;

const DOWNLOAD_DIR = path.join(os.homedir(), "Downloads");

const QUALITY_MAP = {
  best:  "bestvideo+bestaudio/best",
  "4k":  "bestvideo[height<=2160]+bestaudio/best",
  "1440":"bestvideo[height<=1440]+bestaudio/best",
  "1080":"bestvideo[height<=1080]+bestaudio/best",
  "720": "bestvideo[height<=720]+bestaudio/best",
  "480": "bestvideo[height<=480]+bestaudio/best",
  "360": "bestvideo[height<=360]+bestaudio/best",
};

// Browsers tried in order — skips any that aren't installed
const BROWSERS = ["safari", "chrome", "firefox", "brave", "edge", "chromium", "opera"];

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Helper: try yt-dlp with each browser's cookies until one works ───────────
function ytdlpWithFallback(args) {
  return new Promise((resolve, reject) => {
    let index = 0;

    function tryNext() {
      if (index >= BROWSERS.length) {
        return reject(new Error(
          "Could not authenticate with any browser. " +
          "Make sure you are logged into YouTube in Chrome, Safari, or Firefox."
        ));
      }

      const browser = BROWSERS[index++];
      console.log(`  → Trying cookies from ${browser}…`);

      const proc = spawn("yt-dlp", ["--cookies-from-browser", browser, ...args]);
      let stdout = "";
      let stderr = "";

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
          stderr.includes("403");

        if (isAuthError) {
          tryNext(); // silently try next
        } else {
          reject(new Error(stderr || "yt-dlp failed"));
        }
      });

      proc.on("error", () => tryNext()); // binary not found, skip
    }

    tryNext();
  });
}

// ── Helper: streaming download with auto browser fallback ────────────────────
function ytdlpDownloadWithFallback(args, onData, onDone, onError) {
  let index = 0;
  let hasProgress = false;
  let killed = false;
  let currentProc = null;

  function tryNext() {
    if (killed) return;
    if (index >= BROWSERS.length) {
      return onError("Could not authenticate with any browser. Make sure you're logged into YouTube in Chrome, Safari, or Firefox.");
    }

    const browser = BROWSERS[index++];
    console.log(`  → Download: trying cookies from ${browser}…`);

    const proc = spawn("yt-dlp", ["--cookies-from-browser", browser, ...args]);
    currentProc = proc;
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.includes("%")) hasProgress = true;
      onData(text, browser);
    });

    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (killed) return;
      if (code === 0) return onDone(browser);

      const isAuthError = !hasProgress && (
        stderr.includes("Sign in to confirm") ||
        stderr.includes("bot") ||
        stderr.includes("403")
      );

      if (isAuthError) {
        console.log(`  ✗ Auth failed with ${browser}, trying next…`);
        hasProgress = false;
        tryNext();
      } else {
        onError(stderr || "Download failed.");
      }
    });

    proc.on("error", () => { if (!killed) tryNext(); });
  }

  tryNext();
  return () => { killed = true; if (currentProc) currentProc.kill(); };
}

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

  const baseArgs = isMP3
    ? [
        "--no-playlist",
        "--format", "bestaudio/best",
        "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0",
        "--output", path.join(DOWNLOAD_DIR, "%(title)s [%(id)s].%(ext)s"),
        "--windows-filenames", "--newline", url,
      ]
    : [
        "--no-playlist",
        "--format", QUALITY_MAP[quality] || quality,
        "--merge-output-format", "mp4",
        "--output", path.join(DOWNLOAD_DIR, "%(title)s [%(id)s].%(ext)s"),
        "--windows-filenames", "--newline", url,
      ];

  let notifiedBrowser = false;

  const kill = ytdlpDownloadWithFallback(
    baseArgs,
    (text, browser) => {
      if (!notifiedBrowser) {
        send("info", { message: `Authenticated via ${browser}` });
        notifiedBrowser = true;
      }

      for (const line of text.split("\n")) {
        if (!line.trim()) continue;

        const m = line.match(/\[download\]\s+([\d.]+)%.*?at\s+([\d.]+\s*\S+\/s).*?ETA\s+(\S+)/);
        if (m) { send("progress", { percent: parseFloat(m[1]), speed: m[2], eta: m[3] }); continue; }

        if (line.includes("[download] Destination:")) {
          send("info", { message: `Saving: ${path.basename(line.replace("[download] Destination:", "").trim())}` });
        }
        if (line.includes("Merging") || line.includes("ffmpeg")) {
          send("info", { message: "Merging audio & video…" });
        }
      }
    },
    (browser) => {
      send("done", { message: `Saved to ~/Downloads as ${isMP3 ? "MP3" : "MP4"} ✓` });
      res.end();
    },
    (errMsg) => {
      send("error", { message: errMsg });
      res.end();
    }
  );

  req.on("close", () => kill && kill());
});

app.listen(PORT, () => {
  console.log(`\n  ✓  YT Downloader running at http://localhost:${PORT}\n`);
});