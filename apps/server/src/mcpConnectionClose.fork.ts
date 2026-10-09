// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: answers every MCP request with `Connection: close`.
 *
 * The listener closes an idle keep-alive socket after about 6 s
 * (keepAliveTimeout plus its buffer). The Claude CLI's embedded Bun fetch
 * ignores the `Keep-Alive: timeout=5` hint and reuses pooled sockets with no
 * idle limit, so a tool call made about 6 s after the previous one can land on
 * a socket the server just closed and fail with ECONNRESET before the server
 * sees it. With no socket left to reuse, each MCP call opens a fresh one.
 *
 * Covers only the MCP endpoint: the WebSocket upgrade and every other route
 * keep their keep-alive behaviour.
 */
import type * as NodeHttp from "node:http";

/** Mirrors the `path` given to `McpServer.layerHttp` in `mcp/McpHttpServer.ts`. */
export const MCP_HTTP_PATH = "/mcp";

/**
 * True for the request URLs MCP clients send to the MCP endpoint. Like the
 * router, it drops the query, collapses duplicate slashes, ignores one trailing
 * slash, and matches case-insensitively. Rarer shapes the router also accepts
 * (a `;` suffix, percent-encoding, an absolute-form target) keep keep-alive.
 */
export function isMcpRequestPath(url: string | undefined): boolean {
  if (url === undefined) return false;
  let path = url.split(/[?#]/, 1)[0]!.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path.toLowerCase() === MCP_HTTP_PATH;
}

/**
 * Registers a `request` listener that turns off keep-alive for MCP responses.
 * Call it on the server before handing it to the HTTP layer: Node runs
 * `request` listeners in registration order, and the flag must be set before
 * the app writes the response head.
 */
export function closeMcpConnections<T extends NodeHttp.Server>(server: T): T {
  server.on("request", (request, response) => {
    if (isMcpRequestPath(request.url)) {
      response.shouldKeepAlive = false;
    }
  });
  return server;
}
