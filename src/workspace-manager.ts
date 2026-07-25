import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { AccountContext, WorkspaceInfo } from "./types.js";

function asString(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}; }
export function unwrapRecord(value: unknown): Record<string, unknown> { let current = object(value); for (let i = 0; i < 5; i += 1) { const nested = current.value; if (nested === undefined || nested === null || typeof nested !== "object" || Array.isArray(nested)) break; current = object(nested); } return current; }

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

export class WorkspaceManager {
  private exhausted = new Set<string>();
  private accountPath: string | null;

  constructor(private account: AccountContext, private configBase: string, private fetchFn: typeof fetch, accountFilePath?: string) {
    this.accountPath = accountFilePath || null;
    this.exhausted.add(account.spaceId);
  }

  private persistAccount(): void {
    if (!this.accountPath) return;
    writeFileSync(this.accountPath, JSON.stringify({ token_v2: this.account.tokenV2, user_id: this.account.userId, user_name: this.account.userName, user_email: this.account.userEmail, space_id: this.account.spaceId, space_view_id: this.account.spaceViewId, space_name: this.account.spaceName, timezone: this.account.timezone, client_version: this.account.clientVersion }, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  async createWorkspace(name?: string): Promise<WorkspaceInfo> {
    const now = Date.now();
    const spaceName = name || `auto-${now.toString(36)}`;
    const r = await this.fetchFn(`${this.configBase}/createSpace`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", cookie: `token_v2=${this.account.tokenV2}`, "user-agent": USER_AGENT }, body: JSON.stringify({ name: spaceName, planType: "personal", personalUse: true }) });
    if (!r.ok) throw new Error(`createSpace returned HTTP ${r.status}`);
    const data = (await r.json()) as Record<string, unknown>;
    const spaceId = asString(data.spaceId);
    if (!spaceId) throw new Error("createSpace did not return a spaceId");
    const luR = await this.fetchFn(`${this.configBase}/loadUserContent`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", cookie: `token_v2=${this.account.tokenV2}`, "user-agent": USER_AGENT }, body: "{}" });
    if (!luR.ok) throw new Error(`loadUserContent returned HTTP ${luR.status}`);
    const luD = (await luR.json()) as Record<string, unknown>;
    const rm = (luD.recordMap || {}) as Record<string, unknown>;
    const uid = Object.keys((rm.user_root || {}) as Record<string, unknown>)[0];
    const root = unwrapRecord(((rm.user_root as Record<string, unknown>)?.[uid || ""]));
    const pointers = Array.isArray(root.space_view_pointers) ? root.space_view_pointers : [];
    const ptr = pointers.find((p: Record<string, unknown>) => asString(p.spaceId) === spaceId);
    const spaceViewId = ptr ? asString((ptr as Record<string, unknown>).id) : "";
    return { spaceId, spaceViewId, spaceName, plan: "personal", createdTime: now };
  }

  async discoverWorkspaces(): Promise<WorkspaceInfo[]> {
    const r = await this.fetchFn(`${this.configBase}/loadUserContent`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", cookie: `token_v2=${this.account.tokenV2}`, "user-agent": USER_AGENT }, body: "{}" });
    if (!r.ok) throw new Error(`loadUserContent returned HTTP ${r.status}`);
    const d = (await r.json()) as Record<string, unknown>;
    const rm = (d.recordMap || {}) as Record<string, unknown>;
    const uid = Object.keys((rm.user_root || {}) as Record<string, unknown>)[0];
    const root = unwrapRecord(((rm.user_root as Record<string, unknown>)?.[uid || ""]));
    const pointers = Array.isArray(root.space_view_pointers) ? root.space_view_pointers : [];
    return pointers.map((p: Record<string, unknown>) => {
      const sid = asString(p.spaceId);
      const space = unwrapRecord(((rm.space as Record<string, unknown>)?.[sid]));
      return { spaceId: sid, spaceViewId: asString(p.id), spaceName: asString(space.name) || "(nameless)", plan: asString(space.plan_type) || "unknown", createdTime: null };
    }).filter((ws) => ws.plan !== "");
  }

  async rotate(): Promise<boolean> {
    const workspaces = await this.discoverWorkspaces();
    const fresh = workspaces.filter((ws) => !this.exhausted.has(ws.spaceId));
    for (const ws of fresh) { this.exhausted.add(ws.spaceId); if (await this.switchTo(ws)) return true; }
    for (let i = 0; i < 3; i += 1) { try { const nw = await this.createWorkspace(); this.exhausted.add(nw.spaceId); if (await this.switchTo(nw)) return true; } catch { if (i === 2) throw new Error("Failed to create a new Notion workspace after retries"); } }
    return false;
  }

  private async switchTo(ws: WorkspaceInfo): Promise<boolean> {
    const probe = await this.fetchFn(`${this.configBase}/getInferenceTranscriptsForUser`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "notion-client-version": this.account.clientVersion, origin: "https://www.notion.so", referer: `https://www.notion.so/${ws.spaceId}`, "user-agent": USER_AGENT, "x-notion-active-user-header": this.account.userId, "x-notion-space-id": ws.spaceId, cookie: `notion_browser_id=${this.account.browserId}; device_id=${this.account.deviceId}; notion_user_id=${this.account.userId}; notion_users=[%22${this.account.userId}%22]; token_v2=${this.account.tokenV2}` }, body: JSON.stringify({ threadParentPointer: { table: "space", id: ws.spaceId, spaceId: ws.spaceId }, includeWorkflowThreads: true, includeWriterChats: false }) });
    if (!probe.ok) return false;
    this.account.spaceId = ws.spaceId;
    this.account.spaceViewId = ws.spaceViewId;
    this.account.spaceName = ws.spaceName;
    this.persistAccount();
    return true;
  }

  async handleLimitReached(): Promise<AccountContext> { if (!await this.rotate()) throw new Error("All workspaces are rate-limited"); return this.account; }
  markCurrentExhausted(): void { this.exhausted.add(this.account.spaceId); }
}
