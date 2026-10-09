// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import { describe } from "vite-plus/test";

import { closeMcpConnections, isMcpRequestPath } from "./mcpConnectionClose.fork.ts";

interface Reply {
  readonly connection: string | undefined;
  readonly reusedSocket: boolean;
  readonly socketClosed: Promise<void>;
}

const send = (agent: NodeHttp.Agent, port: number, method: string, path: string) =>
  Effect.promise(
    () =>
      new Promise<Reply>((resolve, reject) => {
        const request = NodeHttp.request(
          {
            agent,
            host: "127.0.0.1",
            port,
            method,
            path,
            headers: { "content-type": "application/json" },
          },
          (response) => {
            const socket = request.socket as NodeNet.Socket;
            const socketClosed = new Promise<void>((closed) => {
              if (socket.destroyed) closed();
              else socket.once("close", () => closed());
            });
            response.resume();
            response.on("end", () =>
              resolve({
                connection: response.headers.connection,
                reusedSocket: request.reusedSocket,
                socketClosed,
              }),
            );
          },
        );
        request.on("error", reject);
        request.end(method === "POST" ? '{"jsonrpc":"2.0","id":1,"method":"ping"}' : undefined);
      }),
  );

/** Serves through Effect's own Node request handler, registered after the helper's. */
const listen = Effect.gen(function* () {
  const server = yield* NodeHttpServer.make(() => closeMcpConnections(NodeHttp.createServer()), {
    host: "127.0.0.1",
    port: 0,
  });
  yield* server.serve(Effect.succeed(HttpServerResponse.text("{}")));
  const address = server.address;
  if (typeof address === "string" || !("port" in address)) {
    throw new Error("expected a TCP address");
  }
  return address.port;
});

describe("closeMcpConnections", () => {
  it.effect("closes the connection after an MCP response", () =>
    Effect.gen(function* () {
      const port = yield* listen;
      const agent = new NodeHttp.Agent({ keepAlive: true, maxSockets: 1 });
      yield* Effect.addFinalizer(() => Effect.sync(() => agent.destroy()));

      const first = yield* send(agent, port, "POST", "/mcp");
      expect(first.connection).toBe("close");
      yield* Effect.promise(() => first.socketClosed);

      const second = yield* send(agent, port, "POST", "/mcp?session=1");
      expect(second.connection).toBe("close");
      expect(second.reusedSocket).toBe(false);
      yield* Effect.promise(() => second.socketClosed);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps other routes on a reusable keep-alive connection", () =>
    Effect.gen(function* () {
      const port = yield* listen;
      const agent = new NodeHttp.Agent({ keepAlive: true, maxSockets: 1 });
      yield* Effect.addFinalizer(() => Effect.sync(() => agent.destroy()));

      const first = yield* send(agent, port, "GET", "/api/health");
      expect(first.connection).toBe("keep-alive");

      const second = yield* send(agent, port, "GET", "/mcp-docs");
      expect(second.connection).toBe("keep-alive");
      expect(second.reusedSocket).toBe(true);
    }).pipe(Effect.scoped),
  );

  it("matches every URL the router sends to the MCP endpoint, and nothing else", () => {
    for (const url of ["/mcp", "/mcp?x=1", "/mcp/", "/MCP", "//mcp", "/mcp/?x=1"]) {
      expect(isMcpRequestPath(url), url).toBe(true);
    }
    for (const url of [undefined, "/", "/mcpx", "/mcp-docs", "/mcp/tools", "/api/mcp", "/ws"]) {
      expect(isMcpRequestPath(url), String(url)).toBe(false);
    }
  });
});
