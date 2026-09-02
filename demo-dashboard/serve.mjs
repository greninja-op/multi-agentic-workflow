/*
 * Tiny zero-dependency static server for the CFLS demo dashboard.
 * Serves index.html + scenario.js on http://localhost:8730 (plain HTTP, so
 * there is no self-signed-certificate warning to deal with while recording).
 *
 *   node serve.mjs
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8730);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};

createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  let file = "index.html";
  if (url === "/scenario.js") file = "scenario.js";
  else if (url === "/cfls-mark.png") file = "cfls-mark.png";
  else if (url !== "/" && url !== "/dashboard") {
    // any other path just serves the dashboard too
    file = "index.html";
  }
  try {
    const body = readFileSync(join(here, file));
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, {
      "content-type": TYPES[ext] ?? "text/plain",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(PORT, () => {
  console.log(`\n  CFLS demo dashboard running:`);
  console.log(`    →  http://localhost:${PORT}/\n`);
  console.log(`  Open that link, hit record. Ctrl+C to stop.\n`);
});
