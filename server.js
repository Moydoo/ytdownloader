// server.js  –  Local yt-dlp web interface
// Usage: node server.js   then open http://localhost:3000

const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");

const app = express();
const PORT = 3000;

// Default download folder: ~/Downloads
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

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── GET /info?url=...  ──────────────────────────────────────────────────────
// Returns video title + thumbnail without downloading
app.get("/info", (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url" });

  const proc = spawn("yt-dlp", [
    "--dump-json",
    "--no-playlist",
    "--cookies-from-browser", "chrome",
    url,
  ]);

  let raw = "";
  let err = "";

  proc.stdout.on("data", (d) => (raw += d));
  proc.stderr.on("data", (d) => (err += d));

  proc.on("close", (code) => {
    if (code !== 0 || !raw.trim()) {
      return res.status(500).json({ error: err || "Could not fetch video info" });
    }
    try {
      const info = JSON.parse(raw);
      res.json({
        title:     info.title,
        thumbnail: info.thumbnail,
        duration:  info.duration_string || "",
        uploader:  info.uploader || "",
        id:        info.id,
      });
    } catch {
      res.status(500).json({ error: "Failed to parse video info" });
    }
  });
});

// ── GET /download  (SSE stream) ─────────────────────────────────────────────
// Streams progress events back to the browser via Server-Sent Events
app.get("/download", (req, res) => {
  const { url, quality = "best", format = "mp4" } = req.query;
  if (!url) return res.status(400).end();

  const isMP3 = format === "mp3";

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (type, data) =>
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  send("start", { message: `Starting download…` });

  let args;

  if (isMP3) {
    // MP3: extract audio only, convert to mp3 via ffmpeg
    args = [
      "--no-playlist",
      "--cookies-from-browser", "chrome",
      "--format", "bestaudio/best",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "0",          // 0 = best quality VBR
      "--output", path.join(DOWNLOAD_DIR, "%(title)s [%(id)s].%(ext)s"),
      "--windows-filenames",
      "--newline",
      url,
    ];
  } else {
    // MP4: video + audio merged
    const fmt = QUALITY_MAP[quality] || quality;
    args = [
      "--no-playlist",
      "--cookies-from-browser", "chrome",
      "--format", fmt,
      "--merge-output-format", "mp4",
      "--output", path.join(DOWNLOAD_DIR, "%(title)s [%(id)s].%(ext)s"),
      "--windows-filenames",
      "--newline",
      url,
    ];
  }

  const proc = spawn("yt-dlp", args);

  // Parse yt-dlp's stdout for progress lines
  proc.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;

      // Progress line: [download]  42.3% of  280.89MiB at  389.41KiB/s ETA 10:14
      const progressMatch = line.match(
        /\[download\]\s+([\d.]+)%.*?at\s+([\d.]+\s*\S+\/s).*?ETA\s+(\S+)/
      );
      if (progressMatch) {
        send("progress", {
          percent: parseFloat(progressMatch[1]),
          speed:   progressMatch[2],
          eta:     progressMatch[3],
        });
        continue;
      }

      // Destination line
      if (line.includes("[download] Destination:")) {
        const filename = path.basename(line.replace("[download] Destination:", "").trim());
        send("info", { message: `Saving: ${filename}` });
        continue;
      }

      // Merge line
      if (line.includes("Merging") || line.includes("ffmpeg")) {
        send("info", { message: "Merging audio & video…" });
      }
    }
  });

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    // Only forward real errors, not verbose noise
    if (text.includes("ERROR")) {
      send("error", { message: text.trim() });
    }
  });

  proc.on("close", (code) => {
    if (code === 0) {
      send("done", { message: `Saved to ~/Downloads as ${isMP3 ? "MP3" : "MP4"} ✓` });
    } else {
      send("error", { message: "Download failed. Check the terminal for details." });
    }
    res.end();
  });

  // If client disconnects, kill the child process
  req.on("close", () => proc.kill());
});

app.listen(PORT, () => {
  console.log(`\n  ✓  YT Downloader running at http://localhost:${PORT}\n`);
});
