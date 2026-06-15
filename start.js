/**
 * start.js — SecEVM unified launcher
 * -----------------------------------
 * Starts BOTH servers in a single process:
 *   - Frontend web server  →  http://localhost:3000
 *   - Fingerprint backend  →  http://127.0.0.1:5002
 *
 * Double-click SecEVM.bat (or START SecEVM.bat) from the project folder.
 * Do NOT open index.html directly — the backend will not run that way.
 */

"use strict";

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const { exec, execSync } = require("child_process");

const WEB_PORT = 3010;
const API_PORT = 5002;
const API_HOST = "127.0.0.1";

// Always run from the folder that contains this file (fixes Desktop / OneDrive paths)
process.chdir(__dirname);

function ensureBackendDeps() {
  const serverDir = path.join(__dirname, "fingerprint-server");
  const nodeModules = path.join(serverDir, "node_modules");
  if (fs.existsSync(nodeModules)) return;

  console.log("[EVM] First run — installing fingerprint-server dependencies...");
  try {
    execSync("npm install --omit=dev", {
      cwd: serverDir,
      stdio: "inherit",
      shell: true,
      env: process.env
    });
    console.log("[EVM] Backend dependencies installed.");
  } catch (e) {
    console.error("[EVM] npm install failed:", e.message);
    console.error("[EVM] Open a terminal in this folder and run:");
    console.error("[EVM]   cd fingerprint-server && npm install");
    process.exit(1);
  }
}

function checkBackendOnline() {
  return new Promise((resolve) => {
    const req = http.get(`http://${API_HOST}:${API_PORT}/status`, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body).bridge === "online");
        } catch (_) {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startFingerprintBackend() {
  try {
    require("./fingerprint-server/server.js");
    console.log("[EVM] Fingerprint backend loaded (port " + API_PORT + ")");
  } catch (e) {
    console.error("[EVM] Failed to load fingerprint-server/server.js:", e.message);
    console.error("[EVM] Run: cd fingerprint-server && npm install");
    process.exit(1);
  }
}

function startWebServer() {
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
    console.log("[EVM]  Backend   →  http://" + API_HOST + ":" + API_PORT);
    console.log("[EVM] ─────────────────────────────────────────────");
    console.log("[EVM]  Opening browser...");

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
      console.error(`[EVM] Port ${WEB_PORT} is already in use. Close the other SecEVM window or run SecEVM.bat again.`);
    } else {
      console.error("[EVM] Web server error:", err.message);
    }
    process.exit(1);
  });
}

async function main() {
  console.log("[EVM] Project folder: " + __dirname);
  ensureBackendDeps();

  const backendAlreadyUp = await checkBackendOnline();
  if (backendAlreadyUp) {
    console.log("[EVM] Fingerprint backend already running on port " + API_PORT);
  } else {
    startFingerprintBackend();
    // Give Express a moment to bind before the web UI loads
    await new Promise((r) => setTimeout(r, 400));
    const ok = await checkBackendOnline();
    if (!ok) {
      console.error("[EVM] Backend did not start on port " + API_PORT + ".");
      console.error("[EVM] Close any old SecEVM window, then double-click SecEVM.bat again.");
      process.exit(1);
    }
  }

  startWebServer();
}

main().catch((err) => {
  console.error("[EVM] Startup failed:", err.message);
  process.exit(1);
});

process.on("SIGINT",  () => { console.log("\n[EVM] Shutting down..."); process.exit(0); });
process.on("SIGTERM", () => { console.log("\n[EVM] Shutting down..."); process.exit(0); });
