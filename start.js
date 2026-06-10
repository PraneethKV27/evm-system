/**
 * start.js — SecEVM unified launcher
 * -----------------------------------
 * Starts BOTH servers in a single process:
 *   - Frontend web server  →  http://localhost:3000
 *   - Fingerprint backend  →  http://localhost:5002  (embedded, not a child process)
 *
 * Also opens the browser automatically.
 *
 * Usage:
 *   node start.js
 *
 * This means you never need to start two terminals.
 * Works whether you double-click SecEVM.bat or run from the terminal.
 */

"use strict";

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const { exec } = require("child_process");

const WEB_PORT = 3000;
const API_PORT = 5002;

// ─── 1. Start fingerprint backend (server.js) ─────────────────────────────
//    We require() it directly so both run in the same process.
//    server.js calls app.listen(5002) by itself.
try {
  require("./fingerprint-server/server.js");
  console.log("[EVM] Fingerprint backend loaded (port " + API_PORT + ")");
} catch (e) {
  console.error("[EVM] Failed to load fingerprint-server/server.js:", e.message);
  console.error("[EVM] Run  cd fingerprint-server && npm install  then try again.");
  process.exit(1);
}

// ─── 2. Start frontend web server ─────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".json": "application/json",
  ".py":   "text/plain"
};

const webServer = http.createServer((req, res) => {
  let urlPath = req.url === "/" ? "/index.html" : req.url;
  urlPath = urlPath.split("?")[0].split("#")[0];

  const filePath = path.resolve(PUBLIC_DIR, "." + urlPath);

  // Path traversal guard
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end("403 Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("404 Not Found — " + urlPath);
      return;
    }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || "text/plain";
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
});

webServer.listen(WEB_PORT, "127.0.0.1", () => {
  const url = `http://localhost:${WEB_PORT}`;
  console.log("[EVM] ─────────────────────────────────────────────");
  console.log("[EVM]  SecEVM is ready");
  console.log("[EVM]  Frontend  →  " + url);
  console.log("[EVM]  Backend   →  http://localhost:" + API_PORT);
  console.log("[EVM] ─────────────────────────────────────────────");
  console.log("[EVM]  Opening browser...");

  // Open browser automatically
  const opener =
    process.platform === "win32"  ? `start "" "${url}"` :
    process.platform === "darwin" ? `open "${url}"` :
                                    `xdg-open "${url}"`;
  exec(opener, (err) => {
    if (err) console.log("[EVM]  Could not open browser — navigate to " + url);
  });
});

webServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[EVM] Port ${WEB_PORT} is already in use. Stop the existing server first.`);
  } else {
    console.error("[EVM] Web server error:", err.message);
  }
  process.exit(1);
});

// ─── 3. Graceful shutdown ──────────────────────────────────────────────────
process.on("SIGINT",  () => { console.log("\n[EVM] Shutting down..."); process.exit(0); });
process.on("SIGTERM", () => { console.log("\n[EVM] Shutting down..."); process.exit(0); });
