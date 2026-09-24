import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { MatrixAdapterConfig } from "@beeper/chat-adapter-matrix";
import type { LogLevel } from "chat";

export interface MatrixBridgeOptions {
  pollIntervalMs: number;
  responseTimeoutMs: number;
  maxMessageChars: number;
  model?: string;
  reasoningEffort?: string;
  webSearch?: boolean;
  workspaceSearch?: boolean;
  readOnly?: boolean;
}

export interface MatrixRuntimeConfig {
  stateFilePath: string;
  botUserName: string;
  logLevel: LogLevel;
  adapter: MatrixAdapterConfig;
  bridge: MatrixBridgeOptions;
}

type Environment = Record<string, string | undefined>;

function optional(env: Environment, name: string, fallback = ""): string {
  return env[name]?.trim() || fallback;
}

function list(env: Environment, name: string): string[] {
  return optional(env, name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function booleanValue(raw: string, name: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean such as 1/0, true/false, on/off`);
}

function flag(env: Environment, name: string, fallback: boolean): boolean {
  const raw = optional(env, name);
  return raw ? booleanValue(raw, name) : fallback;
}

function optionalFlag(env: Environment, name: string): boolean | undefined {
  const raw = optional(env, name);
  return raw ? booleanValue(raw, name) : undefined;
}

function integer(
  env: Environment,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = optional(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a safe integer between ${min} and ${max}`);
  }
  return value;
}

function logLevel(env: Environment): LogLevel {
  const value = optional(env, "MATRIX_LOG_LEVEL", "info");
  if (!["debug", "info", "warn", "error", "silent"].includes(value)) {
    throw new Error("MATRIX_LOG_LEVEL must be debug, info, warn, error, or silent");
  }
  return value as LogLevel;
}

function sdkLogLevel(env: Environment): NonNullable<MatrixAdapterConfig["matrixSDKLogLevel"]> {
  const value = optional(env, "MATRIX_SDK_LOG_LEVEL", "error");
  if (!["trace", "debug", "info", "warn", "error"].includes(value)) {
    throw new Error("MATRIX_SDK_LOG_LEVEL must be trace, debug, info, warn, or error");
  }
  return value as NonNullable<MatrixAdapterConfig["matrixSDKLogLevel"]>;
}

function matrixBaseURL(env: Environment): string {
  const value = optional(env, "MATRIX_BASE_URL");
  if (!value) throw new Error("MATRIX_BASE_URL is required");
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("MATRIX_BASE_URL must be a valid absolute URL"); }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("MATRIX_BASE_URL must use http or https");
  }
  return value.replace(/\/+$/, "");
}

function matrixAuth(env: Environment): MatrixAdapterConfig["auth"] {
  const accessToken = optional(env, "MATRIX_ACCESS_TOKEN");
  const userID = optional(env, "MATRIX_USER_ID");
  if (accessToken) {
    return {
      type: "accessToken",
      accessToken,
      ...(userID ? { userID } : {})
    };
  }

  const username = optional(env, "MATRIX_USERNAME");
  const password = optional(env, "MATRIX_PASSWORD");
  if (!username || !password) {
    throw new Error(
      "Set MATRIX_ACCESS_TOKEN, or set both MATRIX_USERNAME and MATRIX_PASSWORD"
    );
  }
  return {
    type: "password",
    username,
    password,
    ...(userID ? { userID } : {}),
    initialDeviceDisplayName: optional(env, "MATRIX_DEVICE_DISPLAY_NAME", "Notion AI bridge")
  };
}

export function defaultMatrixStateFilePath(): string {
  return join(homedir(), ".notion-ai-mcp", "matrix-state.json");
}

export function loadMatrixConfig(env: Environment = process.env): MatrixRuntimeConfig {
  const stateFilePath = resolve(optional(env, "MATRIX_STATE_FILE", defaultMatrixStateFilePath()));
  const cryptoDatabasePrefix = resolve(
    optional(env, "MATRIX_CRYPTO_DATABASE_PREFIX", join(dirname(stateFilePath), "matrix-crypto"))
  );
  const botUserName = optional(env, "MATRIX_BOT_USERNAME", "notion-ai");
  const roomAllowlist = list(env, "MATRIX_ROOM_ALLOWLIST");
  const inviterAllowlist = list(env, "MATRIX_INVITE_AUTOJOIN_ALLOWLIST");
  const autoJoin = flag(env, "MATRIX_INVITE_AUTOJOIN", false) || inviterAllowlist.length > 0;
  const recoveryKey = optional(env, "MATRIX_RECOVERY_KEY");
  const deviceID = optional(env, "MATRIX_DEVICE_ID");

  const adapter: MatrixAdapterConfig = {
    baseURL: matrixBaseURL(env),
    auth: matrixAuth(env),
    userName: botUserName,
    commandPrefix: optional(env, "MATRIX_COMMAND_PREFIX", "/"),
    matrixSDKLogLevel: sdkLogLevel(env),
    e2ee: {
      useIndexedDB: false,
      cryptoDatabasePrefix
    },
    persistence: {
      keyPrefix: optional(env, "MATRIX_PERSISTENCE_KEY_PREFIX", "notion-ai-matrix"),
      sync: {
        persistIntervalMs: integer(env, "MATRIX_SYNC_PERSIST_INTERVAL_MS", 10_000, 1_000, 300_000)
      }
    },
    ...(deviceID ? { deviceID } : {}),
    ...(recoveryKey ? { recoveryKey } : {}),
    ...(roomAllowlist.length > 0 ? { roomAllowlist } : {}),
    ...(autoJoin ? { inviteAutoJoin: inviterAllowlist.length > 0 ? { inviterAllowlist } : {} } : {})
  };

  const model = optional(env, "MATRIX_NOTION_MODEL");
  const reasoningEffort = optional(env, "MATRIX_NOTION_REASONING_EFFORT");
  const webSearch = optionalFlag(env, "MATRIX_NOTION_WEB_SEARCH");
  const workspaceSearch = optionalFlag(env, "MATRIX_NOTION_WORKSPACE_SEARCH");
  const readOnly = optionalFlag(env, "MATRIX_NOTION_READ_ONLY");

  return {
    stateFilePath,
    botUserName,
    logLevel: logLevel(env),
    adapter,
    bridge: {
      pollIntervalMs: integer(env, "MATRIX_POLL_INTERVAL_MS", 3_000, 100, 60_000),
      responseTimeoutMs: integer(
        env,
        "MATRIX_RESPONSE_TIMEOUT_MS",
        30 * 60_000,
        1_000,
        24 * 60 * 60_000
      ),
      maxMessageChars: integer(env, "MATRIX_MAX_MESSAGE_CHARS", 12_000, 1_000, 50_000),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(webSearch !== undefined ? { webSearch } : {}),
      ...(workspaceSearch !== undefined ? { workspaceSearch } : {}),
      ...(readOnly !== undefined ? { readOnly } : {})
    }
  };
}
