import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AccountContext } from "./types.js";

export interface NotionConfig {
  apiBase: string;
  defaultModel: string;
  requestTimeoutMs: number;
  account: Partial<AccountContext> & Pick<AccountContext, "tokenV2">;
  accountFilePath?: string|undefined;
  maxWorkspaceRetries?: number;
  mcpRegistryPath?: string | undefined;
  attachmentRoot?: string | undefined;
  maxAttachmentBytes?: number | undefined;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function accountFile(): { path: string; data: Record<string, unknown> } {
  const path = optional("NOTION_ACCOUNT_FILE");
  if (!path) return { path: "", data: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    // switch_workspace(pin) creates this file lazily, so a path that does not exist yet is not a startup failure.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { path, data: {} };
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read NOTION_ACCOUNT_FILE: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("NOTION_ACCOUNT_FILE must contain a JSON object");
  return { path, data: parsed as Record<string, unknown> };
}

function fileString(file: Record<string, unknown>, key: string): string { const value = file[key]; return typeof value === "string" ? value.trim() : ""; }

export function loadConfig(): NotionConfig {
  const { path: accountPath, data: file } = accountFile();
  const timeout = Number(optional("NOTION_REQUEST_TIMEOUT_MS", "300000"));
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("NOTION_REQUEST_TIMEOUT_MS must be a positive number");
  const tokenV2 = optional("NOTION_TOKEN_V2", fileString(file, "token_v2"));
  if (!tokenV2) throw new Error("NOTION_TOKEN_V2 or NOTION_ACCOUNT_FILE with token_v2 is required");
  const fullCookie = optional("NOTION_FULL_COOKIE", fileString(file, "full_cookie"));
  const pinnedSpaceId = optional("NOTION_PINNED_SPACE_ID", fileString(file, "pinned_space_id"));
  const maxRetries = Number(optional("NOTION_MAX_WORKSPACE_RETRIES", "5"));
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error("NOTION_MAX_WORKSPACE_RETRIES must be a non-negative safe integer");
  }
  const maxAttachmentBytes = Number(optional("NOTION_MAX_ATTACHMENT_BYTES", String(20 * 1024 * 1024)));
  if (!Number.isSafeInteger(maxAttachmentBytes) || maxAttachmentBytes <= 0) throw new Error("NOTION_MAX_ATTACHMENT_BYTES must be a positive safe integer");
  return {
    apiBase: optional("NOTION_API_BASE", "https://www.notion.so/api/v3").replace(/\/$/, ""),
    defaultModel: optional("NOTION_DEFAULT_MODEL", "almond-croissant-low"),
    requestTimeoutMs: timeout,
    accountFilePath: accountPath || undefined,
    mcpRegistryPath: optional("NOTION_MCP_REGISTRY_FILE") || undefined,
    attachmentRoot: optional("NOTION_ATTACHMENT_ROOT", process.cwd()),
    maxAttachmentBytes,
    maxWorkspaceRetries: maxRetries,
    account: {
      tokenV2,
      userId: optional("NOTION_USER_ID", fileString(file, "user_id")),
      userName: optional("NOTION_USER_NAME", fileString(file, "user_name")),
      userEmail: optional("NOTION_USER_EMAIL", fileString(file, "user_email")),
      spaceId: optional("NOTION_SPACE_ID", fileString(file, "space_id")),
      spaceName: optional("NOTION_SPACE_NAME", fileString(file, "space_name")),
      spaceViewId: optional("NOTION_SPACE_VIEW_ID", fileString(file, "space_view_id")),
      timezone: optional("NOTION_TIMEZONE", fileString(file, "timezone") || "UTC"),
      clientVersion: optional("NOTION_CLIENT_VERSION", fileString(file, "client_version") || "23.13.20260313.1423"),
      browserId: optional("NOTION_BROWSER_ID", fileString(file, "browser_id") || randomUUID()),
      deviceId: optional("NOTION_DEVICE_ID", fileString(file, "device_id") || randomUUID()),
      ...(fullCookie ? { fullCookie } : {}),
      ...(pinnedSpaceId ? { pinnedSpaceId } : {})
    }
  };
}
