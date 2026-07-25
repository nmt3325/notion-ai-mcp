import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createNodeServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { NotionClient } from "./notion-client.js";
import { createServer as createMcpServer } from "./server.js";

const DEFAULT_BODY_LIMIT = 1024 * 1024;

export interface HttpServerOptions {
  host: string;
  port: number;
  path: string;
  bearerToken: string;
  sessionTtlMs: number;
  maxSessions: number;
  clientFactory?: () => NotionClient;
  logger?: (message: string) => void;
}

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>;
  lastSeen: number;
}

export interface RemoteMcpHttpServer {
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
  sessionCount(): number;
}

function integerSetting(name: string, fallback: number): number {
  const value = Number(process.env[name]?.trim() || fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function normalizePath(value: string): string {
  const path = value.trim() || "/mcp";
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new Error("NOTION_MCP_HTTP_PATH must be an absolute URL path");
  }
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function loadHttpServerOptions(): HttpServerOptions {
  const bearerToken = process.env.NOTION_MCP_HTTP_BEARER_TOKEN?.trim() || "";
  if (bearerToken.length < 32) {
    throw new Error("NOTION_MCP_HTTP_BEARER_TOKEN must contain at least 32 characters");
  }
  const host = process.env.NOTION_MCP_HTTP_HOST?.trim() || "127.0.0.1";
  return {
    host,
    port: integerSetting("NOTION_MCP_HTTP_PORT", 3000),
    path: normalizePath(process.env.NOTION_MCP_HTTP_PATH || "/mcp"),
    bearerToken,
    sessionTtlMs: integerSetting("NOTION_MCP_HTTP_SESSION_TTL_MS", 60 * 60 * 1000),
    maxSessions: integerSetting("NOTION_MCP_HTTP_MAX_SESSIONS", 100)
  };
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function authenticated(req: IncomingMessage, expectedToken: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header(req, "authorization"));
  if (!match?.[1]) return false;
  const provided = createHash("sha256").update(match[1]).digest();
  const expected = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(provided, expected);
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store"
  });
  res.end(encoded);
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  jsonResponse(res, status, {
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentLength = Number(header(req, "content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > DEFAULT_BODY_LIMIT) {
    throw new Error("Request body is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > DEFAULT_BODY_LIMIT) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new Error("Request body is empty");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function requestPath(req: IncomingMessage): string {
  return new URL(req.url || "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
}

export function createRemoteMcpHttpServer(options: HttpServerOptions): RemoteMcpHttpServer {
  if (!options.path.startsWith("/")) throw new Error("HTTP MCP path must start with /");
  if (options.bearerToken.length < 32) throw new Error("HTTP MCP bearer token must contain at least 32 characters");
  const sessions = new Map<string, HttpSession>();
  const clientFactory = options.clientFactory ?? (() => new NotionClient(loadConfig()));
  const log = options.logger ?? ((message: string) => process.stderr.write(`${message}\n`));

  const removeExpiredSessions = async (): Promise<void> => {
    const cutoff = Date.now() - options.sessionTtlMs;
    const stale = [...sessions.entries()].filter(([, session]) => session.lastSeen < cutoff);
    await Promise.all(stale.map(async ([id, session]) => {
      sessions.delete(id);
      await session.server.close().catch(() => undefined);
    }));
  };

  const nodeServer: Server = createNodeServer(async (req, res) => {
    try {
      const path = requestPath(req);
      if (path === "/healthz") {
        jsonResponse(res, 200, { status: "ok" });
        return;
      }
      if (path !== options.path) {
        jsonResponse(res, 404, { error: "Not found" });
        return;
      }
      if (!authenticated(req, options.bearerToken)) {
        res.setHeader("www-authenticate", "Bearer");
        jsonResponse(res, 401, { error: "Unauthorized" });
        return;
      }

      await removeExpiredSessions();
      const sessionId = header(req, "mcp-session-id");
      const existing = sessionId ? sessions.get(sessionId) : undefined;

      if (req.method === "POST") {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid JSON request";
          rpcError(res, message.includes("too large") ? 413 : 400, message);
          return;
        }

        if (existing) {
          existing.lastSeen = Date.now();
          await existing.transport.handleRequest(req, res, body);
          return;
        }
        if (sessionId) {
          rpcError(res, 404, "Unknown or expired MCP session");
          return;
        }
        if (!isInitializeRequest(body)) {
          rpcError(res, 400, "MCP initialization request or valid session ID required");
          return;
        }
        if (sessions.size >= options.maxSessions) {
          rpcError(res, 503, "MCP session limit reached");
          return;
        }

        const mcpServer = createMcpServer(clientFactory());
        let initializedSessionId = "";
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => {
            initializedSessionId = id;
            sessions.set(id, { transport, server: mcpServer, lastSeen: Date.now() });
          }
        });
        transport.onclose = () => {
          const id = transport.sessionId || initializedSessionId;
          if (id) sessions.delete(id);
        };
        try {
          // SDK 1.29's Node transport declaration is structurally compatible at runtime,
          // but conflicts with exactOptionalPropertyTypes on callback properties.
          await mcpServer.connect(transport as unknown as Transport);
          await transport.handleRequest(req, res, body);
        } catch (error) {
          if (initializedSessionId) sessions.delete(initializedSessionId);
          await mcpServer.close().catch(() => undefined);
          throw error;
        }
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (!sessionId || !existing) {
          rpcError(res, sessionId ? 404 : 400, "Valid MCP session ID required");
          return;
        }
        existing.lastSeen = Date.now();
        await existing.transport.handleRequest(req, res);
        return;
      }

      res.setHeader("allow", "GET, POST, DELETE");
      rpcError(res, 405, "Method not allowed");
    } catch (error) {
      log(`notion-ai-mcp-http request error: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) rpcError(res, 500, "Internal server error");
      else res.end();
    }
  });

  const cleanupInterval = setInterval(() => {
    void removeExpiredSessions().catch((error: unknown) => {
      log(`notion-ai-mcp-http session cleanup error: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, Math.min(options.sessionTtlMs, 60_000));
  cleanupInterval.unref();

  return {
    listen: () => new Promise<AddressInfo>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      nodeServer.once("error", onError);
      nodeServer.listen(options.port, options.host, () => {
        nodeServer.off("error", onError);
        const address = nodeServer.address();
        if (!address || typeof address === "string") {
          reject(new Error("HTTP server did not receive a TCP address"));
          return;
        }
        resolve(address);
      });
    }),
    close: async () => {
      clearInterval(cleanupInterval);
      await Promise.all([...sessions.values()].map((session) => session.server.close().catch(() => undefined)));
      sessions.clear();
      if (!nodeServer.listening) return;
      await new Promise<void>((resolve, reject) => {
        nodeServer.close((error) => error ? reject(error) : resolve());
      });
    },
    sessionCount: () => sessions.size
  };
}

export async function runHttpServer(): Promise<void> {
  const options = loadHttpServerOptions();
  const remote = createRemoteMcpHttpServer(options);
  const address = await remote.listen();
  process.stderr.write(`notion-ai-mcp-http: listening on http://${address.address}:${address.port}${options.path}\n`);
  if (options.host !== "127.0.0.1" && options.host !== "::1" && options.host !== "localhost") {
    process.stderr.write("notion-ai-mcp-http: use a TLS reverse proxy before exposing this listener to the internet\n");
  }

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void remote.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
