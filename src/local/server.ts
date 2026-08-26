import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { accounts } from "../accounts";
import { feedsDir } from "./paths";

export async function serve(port: number): Promise<void> {
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
    if (pathname === "/") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        feeds: ["/feeds/all.xml", ...accounts.map((account) => `/feeds/${account.handle}.xml`)],
      }, null, 2));
      return;
    }
    const match = pathname.match(/^\/feeds\/([A-Za-z0-9_]{1,15}|all)\.xml$/);
    if (!match?.[1]) {
      response.writeHead(404).end("Not found\n");
      return;
    }
    const filePath = path.join(feedsDir, `${match[1]}.xml`);
    try {
      await access(filePath);
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
        "cache-control": "no-cache",
      });
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404).end("Run npm run collect first.\n");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log(`Serving RSS at http://127.0.0.1:${port}/feeds/all.xml`);
}
