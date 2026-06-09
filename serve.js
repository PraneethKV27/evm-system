const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const mimeTypes = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".py": "text/plain"
};

const server = http.createServer((req, res) => {
  let urlPath = req.url === "/" ? "/index.html" : req.url;

  // Strip query strings and fragments
  urlPath = urlPath.split("?")[0].split("#")[0];

  // Resolve path and ensure it stays inside PUBLIC_DIR (prevent path traversal)
  const filePath = path.resolve(PUBLIC_DIR, "." + urlPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end("403 Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || "text/plain";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`[EVM] Website running at http://localhost:${PORT}`);
});
