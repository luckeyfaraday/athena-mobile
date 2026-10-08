import fs from "node:fs";
import path from "node:path";

export function serveStatic(req, res, distDir) {
  const fail = (status, message) => {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(message);
  };
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://athena-mobile.local").pathname);
  } catch {
    return fail(400, "Bad request");
  }
  const requested = path.resolve(distDir, `.${pathname}`);
  if (requested !== distDir && !requested.startsWith(`${distDir}${path.sep}`)) return fail(403, "Forbidden");
  let file = requested;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // Only document routes may fall back to the SPA. Returning HTML for an old
    // hashed JS/CSS URL breaks startup and poisons service-worker caches.
    if (pathname.startsWith("/assets/") || path.extname(pathname) || (pathname !== "/" && !req.headers.accept?.includes("text/html"))) {
      return fail(404, "Not found");
    }
    file = path.join(distDir, "index.html");
  }
  const ext = path.extname(file);
  const type = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json; charset=utf-8",
  }[ext] || "application/octet-stream";
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  fs.createReadStream(file).on("error", () => {
    if (res.headersSent) res.destroy();
    else fail(404, "Not found");
  }).pipe(res);
}
