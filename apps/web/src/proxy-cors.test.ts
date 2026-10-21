import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import path from "node:path";
import { loadConfigFromFile, preview } from "vite";
import { pageRpcTransport } from "./lib/rpc-lifecycle";
import { httpKeepAlive, HTTP_KEEP_ALIVE_MS } from "./http-keep-alive";

it("proxies API preflights unchanged instead of consuming them in Vite CORS", async () => {
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "test" },
    path.resolve(import.meta.dirname, "../vite.config.ts"),
  );
  if (!loaded) throw new Error("Missing web proxy configuration");
  const config = loaded.config;
  expect(
    config.plugins?.some(
      (entry) =>
        entry && typeof entry === "object" && "name" in entry && entry.name === httpKeepAlive.name,
    ),
  ).toBe(true);
  expect(config.server?.cors).toBe(false);
  expect(config.preview?.cors).toBe(false);
  const trusted = "https://workspace.example.test";
  const methods: string[] = [];
  const upstream = http.createServer((req, res) => {
    methods.push(req.method ?? "");
    if (req.headers.origin === trusted) {
      res.setHeader("Access-Control-Allow-Origin", trusted);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "content-type,x-rakazo-space-id");
    }
    res.writeHead(req.method === "OPTIONS" ? 204 : 401).end();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const { port } = upstream.address() as AddressInfo;
  const server = await preview({
    configFile: false,
    logLevel: "silent",
    preview: {
      host: "127.0.0.1",
      port: 0,
      cors: config.preview?.cors,
      proxy: { "/rpc": { target: `http://127.0.0.1:${port}`, changeOrigin: true } },
    },
  });
  try {
    const webPort = (server.httpServer.address() as AddressInfo).port;
    for (const origin of [trusted, "https://untrusted.example.test"]) {
      const response = await fetch(`http://127.0.0.1:${webPort}/rpc/threads/get`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,x-rakazo-space-id",
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        origin === trusted ? trusted : null,
      );
      expect(response.headers.get("access-control-allow-credentials")).toBe(
        origin === trusted ? "true" : null,
      );
    }
    const response = await fetch(`http://127.0.0.1:${webPort}/rpc/threads/get`, {
      method: "POST",
      headers: { Origin: trusted },
    });
    expect(response.status).toBe(401);
    expect(methods).toEqual(["OPTIONS", "OPTIONS", "POST"]);
  } finally {
    (server.httpServer as http.Server).closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("retains one HTTP/1 socket beyond the old idle cutoff without disabling request deadlines", async () => {
  const server = await preview({
    configFile: false,
    logLevel: "silent",
    plugins: [
      httpKeepAlive,
      {
        name: "public-asset-fixture",
        configurePreviewServer(server) {
          server.middlewares.use((_req, res) => res.end("ok"));
        },
      },
    ],
    preview: {
      host: "127.0.0.1",
      port: 0,
      cors: false,
    },
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const httpServer = server.httpServer as http.Server;
  const defaults = http.createServer();
  try {
    expect(httpServer.keepAliveTimeout).toBe(HTTP_KEEP_ALIVE_MS);
    expect(httpServer.headersTimeout).toBe(defaults.headersTimeout);
    expect(httpServer.requestTimeout).toBe(defaults.requestTimeout);
    const read = () =>
      new Promise<{ port: number | undefined; keepAlive: string | undefined }>(
        (resolve, reject) => {
          http
            .get(
              {
                hostname: "127.0.0.1",
                port: (httpServer.address() as AddressInfo).port,
                path: "/asset.js",
                agent,
                timeout: 2000,
              },
              (res) => {
                const result = {
                  port: res.socket.localPort,
                  keepAlive: String(res.headers["keep-alive"] ?? ""),
                };
                res.on("error", reject);
                res.on("end", () => resolve(result));
                res.resume();
              },
            )
            .on("error", reject)
            .on("timeout", function (this: http.ClientRequest) {
              this.destroy(new Error("fixture request timeout"));
            });
        },
      );
    const first = await read();
    expect(first.keepAlive).toMatch(/timeout=65/);
    await delay(6200);
    const second = await read();
    expect(second.port).toBe(first.port);
    expect(second.keepAlive).toMatch(/timeout=65/);
  } finally {
    agent.destroy();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 15000);

it.each(["threads/get", "bootstrap"])(
  "recovers a real dropped %s read without repeating an action",
  async (route) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const receipts: Array<{ path: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const path = req.url ?? "";
        receipts.push({ path, body: Buffer.concat(chunks).toString() });
        if (path === "/rpc/threads/send" || receipts.length === 1) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end('{"json":{"cursor":42}}');
      });
    });
    const transport = pageRpcTransport(new EventTarget());
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}/rpc/`;
      const options = { method: "POST", body: '{"json":{"botId":"owned"}}' };
      const response = await transport.fetch(new Request(base + route, options), {});
      expect(await response.json()).toEqual({ json: { cursor: 42 } });
      await expect(
        transport.fetch(new Request(base + "threads/send", options), {}),
      ).rejects.toBeInstanceOf(TypeError);
      expect(receipts.map((item) => item.path)).toEqual([
        "/rpc/" + route,
        "/rpc/" + route,
        "/rpc/threads/send",
      ]);
      expect(receipts[0]?.body).toBe(receipts[1]?.body);
    } finally {
      transport.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      warning.mockRestore();
    }
  },
);
