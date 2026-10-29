// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: answers every MCP request with `Connection: close`. The listener closes idle keep-alive
 * sockets after about 6 s, but the Claude CLI's Bun fetch reuses pooled sockets with no idle limit,
 * so a call about 6 s after the last can hit a just-closed socket and fail with ECONNRESET. Only the
 * MCP endpoint: the WebSocket upgrade and every other route keep keep-alive.
 */
import type * as NodeHttp from "node:http";

/** Mirrors the `path` given to `McpServer.layerHttp` in `mcp/McpHttpServer.ts`. */
const MCP_HTTP_PATH = "/mcp";

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
