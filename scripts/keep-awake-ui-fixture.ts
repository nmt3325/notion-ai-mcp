/**
 * Runs the real HTTP listener against a stubbed Notion client.
 *
 * The extension panel is easiest to judge with watchdogs already on screen, but arming a real one
 * spends credits and writes into a real conversation. This serves the same routes, the same
 * responses and the same CORS rules from the same code, while every Notion read is answered locally
 * and every nudge is dropped, so the panel can be exercised against a browser with no side effects.
 *
 * Usage: npm run build is not required; run it with tsx.
 *   NOTION_MCP_HTTP_BEARER_TOKEN=... node --import tsx scripts/keep-awake-ui-fixture.ts
 */
import { createRemoteMcpHttpServer } from "../src/http-server.js";
import type { NotionClient } from "../src/notion-client.js";

const token = process.env.NOTION_MCP_HTTP_BEARER_TOKEN ?? "ui-fixture-not-a-secret-bearer-token-00000000";
const host = process.env.NOTION_MCP_HTTP_HOST ?? "127.0.0.1";
const port = Number(process.env.NOTION_MCP_HTTP_PORT ?? 3000);
const allowedOrigins = (process.env.NOTION_MCP_HTTP_ALLOWED_ORIGINS ?? "https://www.notion.so,https://notion.so,https://app.notion.com,chrome-extension://*")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

/** Conversations the fixture pretends to know about, so the list is never empty on first paint. */
const seeds = (process.env.KEEP_AWAKE_FIXTURE_SEEDS ?? "22222222-2222-4222-8222-222222222222,33333333-3333-4333-8333-333333333333")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

function fixtureClient(): NotionClient {
  return {
    startWebConfirmations: () => undefined,
    stopWebConfirmations: () => undefined,
    chatDefaults: () => ({ webSearch: true, workspaceSearch: true, readOnly: false }),
    listChatJobs: () => [],
    chatStatePath: () => null,
    chatStateError: () => null,
    keepAwakeDefaults: () => ({
      interrupt: true,
      idleMs: 120_000,
      pollMs: 30_000,
      cooldownMs: 60_000,
      maxNudges: 40,
      deadlineMs: 10_800_000,
      enabled: true,
      autoContinue: true,
      maxContinues: 10
    }),
    keepAliveStatePath: () => null,
    // A thread that just answered: the watchdog stays armed and never decides to nudge.
    threadSignals: async (threadId: string) => ({
      threadId,
      updatedTime: Date.now(),
      serverNow: Date.now(),
      messageCount: 6,
      lastTurnOutcome: null,
      credits: null,
      currentInferenceId: "",
      leaseExpiration: null,
      lastUserMessageTime: Date.now() - 30_000
    }),
    sendChatNudge: async () => ({ acceptedAt: Date.now() }),
    sendChatContinue: async () => ({ acceptedAt: Date.now() }),
    nativeContinuationState: async () => null,
    finalStepShape: async () => null,
    interruptTurn: async (threadId: string) => ({ threadId, cleared: false, inferenceId: "" }),
    getConversation: async (id: string) => ({ id, title: "Fixture thread", type: "workflow", createdAt: null, updatedAt: null, messages: [] })
  } as unknown as NotionClient;
}

async function main(): Promise<void> {
  const remote = createRemoteMcpHttpServer({
    host,
    port,
    path: "/mcp",
    bearerToken: token,
    sessionTtlMs: 600_000,
    maxSessions: 5,
    allowedOrigins,
    clientFactory: fixtureClient,
    logger: () => undefined
  });
  const address = await remote.listen();
  const base = `http://${host}:${address.port}`;

  for (const conversationId of seeds) {
    const response = await fetch(`${base}/keep-awake`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ conversationId, deadlineMinutes: 60 })
    });
    console.log(`seed ${conversationId}: ${response.status}`);
  }

  console.log(`keep-awake fixture listening on ${base} (bearer ${token})`);

  const shutdown = (): void => {
    void remote.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
