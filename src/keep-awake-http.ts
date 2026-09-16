import { z } from "zod";
import type { KeepAwakeDefaults, KeepAwakeSupervisor } from "./keep-awake.js";

/**
 * Manual control surface for the keep-awake watchdogs.
 *
 * The MCP tools are written for an agent that is already inside a long task. A person watching that
 * task from the Notion web client has no way to reach them, because the browser cannot open an MCP
 * session on their behalf. These routes expose exactly the same supervisor over plain JSON so a
 * browser extension can arm, inspect and stop a watchdog by hand, using the one bearer token the
 * HTTP transport already checks.
 *
 * Units are the same as the MCP tools: seconds for the intervals, minutes for the deadline. The
 * stored record keeps milliseconds, so the conversion happens here and nowhere else.
 */
export const KEEP_AWAKE_HTTP_PREFIX = "/keep-awake";

export type KeepAwakeRoute =
  | { action: "list" }
  | { action: "start" }
  | { action: "stopAll" }
  | { action: "check" | "kick" | "stop"; keepAliveId: string };

export type KeepAwakeRouteResolution =
  | { kind: "route"; route: KeepAwakeRoute }
  | { kind: "method_not_allowed"; allow: string }
  | { kind: "not_found" };

export interface KeepAwakeHttpContext {
  supervisor: () => KeepAwakeSupervisor;
  defaults: () => KeepAwakeDefaults;
  now?: (() => number) | undefined;
}

export interface KeepAwakeHttpResult {
  status: number;
  body: Record<string, unknown>;
}

const ACTION_METHODS = "POST, OPTIONS";
const COLLECTION_METHODS = "GET, POST, OPTIONS";

/**
 * Maps a request to a keep-awake action.
 *
 * Returns null for every path that is not part of this surface, so the caller can fall through to
 * the MCP transport without knowing anything about these routes.
 */
export function resolveKeepAwakeRoute(method: string, pathname: string): KeepAwakeRouteResolution | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path !== KEEP_AWAKE_HTTP_PREFIX && !path.startsWith(`${KEEP_AWAKE_HTTP_PREFIX}/`)) return null;
  const segments = path.slice(KEEP_AWAKE_HTTP_PREFIX.length).split("/").filter(Boolean);
  const verb = method.toUpperCase();

  if (segments.length === 0) {
    if (verb === "GET") return { kind: "route", route: { action: "list" } };
    if (verb === "POST") return { kind: "route", route: { action: "start" } };
    return { kind: "method_not_allowed", allow: COLLECTION_METHODS };
  }

  const first = segments[0] ?? "";
  if (segments.length === 1 && first === "stop-all") {
    return verb === "POST"
      ? { kind: "route", route: { action: "stopAll" } }
      : { kind: "method_not_allowed", allow: ACTION_METHODS };
  }

  const second = segments[1] ?? "";
  if (segments.length === 2 && (second === "check" || second === "kick" || second === "stop")) {
    const keepAliveId = safeDecode(first);
    if (!keepAliveId) return { kind: "not_found" };
    return verb === "POST"
      ? { kind: "route", route: { action: second, keepAliveId } }
      : { kind: "method_not_allowed", allow: ACTION_METHODS };
  }

  return { kind: "not_found" };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return "";
  }
}

const statusValues = ["watching", "completed", "exhausted", "expired", "stopped", "orphaned"] as const;

// The bounds repeat the ones the MCP tool declares, so a value rejected here is rejected there too.
const startSchema = z
  .object({
    conversationId: z.string().uuid(),
    idleSeconds: z.number().int().min(60).max(900).optional(),
    pollSeconds: z.number().int().min(5).max(300).optional(),
    cooldownSeconds: z.number().int().min(0).max(1800).optional(),
    maxNudges: z.number().int().min(1).max(500).optional(),
    deadlineMinutes: z.number().int().min(1).max(1440).optional(),
    autoContinue: z.boolean().optional(),
    maxContinues: z.number().int().min(0).max(100).optional(),
    language: z.enum(["ja", "en"]).optional(),
    doneToken: z.string().min(3).max(64).optional(),
    message: z.string().min(1).max(2000).optional()
  })
  .strict();

const listSchema = z
  .object({
    status: z.enum(statusValues).optional(),
    conversationId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional()
  })
  .strict();

/** The defaults a caller needs to prefill a form, in the units the routes accept. */
export function publicKeepAwakeDefaults(defaults: KeepAwakeDefaults): Record<string, unknown> {
  return {
    enabled: defaults.enabled,
    idleSeconds: Math.round(defaults.idleMs / 1000),
    pollSeconds: Math.round(defaults.pollMs / 1000),
    cooldownSeconds: Math.round(defaults.cooldownMs / 1000),
    maxNudges: defaults.maxNudges,
    deadlineMinutes: Math.round(defaults.deadlineMs / 60000),
    autoContinue: defaults.autoContinue !== false,
    maxContinues: defaults.maxContinues ?? 10,
    interrupt: defaults.interrupt
  };
}

function invalid(message: string, issues?: Array<{ path: string; message: string }>): KeepAwakeHttpResult {
  return {
    status: 400,
    body: { error: message, code: "invalid_request", ...(issues ? { issues } : {}) }
  };
}

function issuesOf(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

/**
 * Turns a thrown supervisor error into a response.
 *
 * A disabled watchdog is a configuration state the caller can fix, while anything else came from
 * the Notion read that calibrates a new watch, so the two must not look the same in the UI.
 */
function failure(error: unknown): KeepAwakeHttpResult {
  const message = error instanceof Error ? error.message : String(error);
  if (/keep_me_awake is disabled/i.test(message)) {
    return { status: 409, body: { error: message, code: "keep_awake_disabled" } };
  }
  return { status: 502, body: { error: message, code: "notion_unavailable" } };
}

function notFound(keepAliveId: string): KeepAwakeHttpResult {
  return { status: 404, body: { error: `No watchdog with keepAliveId ${keepAliveId}`, code: "not_found", keepAliveId } };
}

export async function runKeepAwakeRoute(
  route: KeepAwakeRoute,
  input: { body?: unknown; query?: URLSearchParams | undefined },
  context: KeepAwakeHttpContext
): Promise<KeepAwakeHttpResult> {
  const now = context.now ? context.now() : Date.now();
  const defaults = context.defaults();

  if (route.action === "list") {
    const query = input.query ?? new URLSearchParams();
    const raw: Record<string, string> = {};
    for (const key of ["status", "conversationId", "limit"]) {
      const value = query.get(key);
      if (value !== null && value !== "") raw[key] = value;
    }
    const parsed = listSchema.safeParse(raw);
    if (!parsed.success) return invalid("Invalid keep-awake query", issuesOf(parsed.error));
    const keepAlives = context.supervisor().list({
      limit: parsed.data.limit ?? 20,
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.conversationId ? { conversationId: parsed.data.conversationId } : {})
    });
    return {
      status: 200,
      body: { serverNow: now, defaults: publicKeepAwakeDefaults(defaults), keepAlives }
    };
  }

  if (route.action === "start") {
    const parsed = startSchema.safeParse(input.body ?? {});
    if (!parsed.success) return invalid("Invalid keep-awake request", issuesOf(parsed.error));
    const options = parsed.data;
    try {
      const keepAlive = await context.supervisor().start({
        conversationId: options.conversationId,
        ...(options.idleSeconds === undefined ? {} : { idleMs: options.idleSeconds * 1000 }),
        ...(options.pollSeconds === undefined ? {} : { pollMs: options.pollSeconds * 1000 }),
        ...(options.cooldownSeconds === undefined ? {} : { cooldownMs: options.cooldownSeconds * 1000 }),
        ...(options.maxNudges === undefined ? {} : { maxNudges: options.maxNudges }),
        ...(options.deadlineMinutes === undefined ? {} : { deadlineMs: options.deadlineMinutes * 60000 }),
        ...(options.autoContinue === undefined ? {} : { autoContinue: options.autoContinue }),
        ...(options.maxContinues === undefined ? {} : { maxContinues: options.maxContinues }),
        ...(options.language ? { language: options.language } : {}),
        ...(options.doneToken ? { doneToken: options.doneToken } : {}),
        ...(options.message ? { message: options.message } : {})
      });
      return { status: 201, body: { serverNow: now, defaults: publicKeepAwakeDefaults(defaults), keepAlive } };
    } catch (error) {
      return failure(error);
    }
  }

  if (route.action === "stopAll") {
    const stopped = context.supervisor().stopAll();
    return { status: 200, body: { serverNow: now, stopped } };
  }

  if (route.action === "check") {
    try {
      const outcome = await context.supervisor().tick(route.keepAliveId);
      if (!outcome.keepAlive) return notFound(route.keepAliveId);
      return { status: 200, body: { serverNow: now, decision: outcome.decision, keepAlive: outcome.keepAlive } };
    } catch (error) {
      return failure(error);
    }
  }

  if (route.action === "kick") {
    try {
      const keepAlive = await context.supervisor().kick(route.keepAliveId);
      if (!keepAlive) return notFound(route.keepAliveId);
      return { status: 200, body: { serverNow: now, keepAlive } };
    } catch (error) {
      return failure(error);
    }
  }

  const keepAlive = context.supervisor().stop(route.keepAliveId);
  if (!keepAlive) return notFound(route.keepAliveId);
  return { status: 200, body: { serverNow: now, keepAlive } };
}
