import type { Plugin, PreviewServer, ViteDevServer } from "vite";

export const HTTP_KEEP_ALIVE_MS = 65_000;

function configure(server: PreviewServer | ViteDevServer) {
  // Keep HTTP/1 sockets beyond Safari's reuse window; do not disable request deadlines.
  if (server.httpServer && "keepAliveTimeout" in server.httpServer)
    server.httpServer.keepAliveTimeout = HTTP_KEEP_ALIVE_MS;
}

export const httpKeepAlive: Plugin = {
  name: "rakazo-http-keep-alive",
  configureServer: configure,
  configurePreviewServer: configure,
};
