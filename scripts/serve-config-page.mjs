import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const args = process.argv.slice(2);
const portFlagIndex = args.indexOf("--port");
const port = portFlagIndex >= 0 ? Number(args[portFlagIndex + 1]) : 4173;
const root = "src/config";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const requestPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const normalizedPath = normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(process.cwd(), root, normalizedPath);

  try {
    const data = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
    });
    response.end(data);
  } catch (_error) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Config page server listening on http://127.0.0.1:${port}`);
});
