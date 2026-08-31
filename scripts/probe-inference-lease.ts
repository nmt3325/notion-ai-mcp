import { loadConfig } from "../src/config.js";
import { NotionClient } from "../src/notion-client.js";

const threadId = process.argv[2] ?? "";
const mode = process.argv[3] ?? "read";
if (!threadId) {
  console.error("usage: probe-inference-lease.ts <threadId> [interrupt]");
  process.exit(1);
}
const client = new NotionClient(loadConfig());
const show = (phase: string, value: unknown): void => { console.log(phase, JSON.stringify(value)); };
const before = await client.threadSignals(threadId);
show("before", {
  currentInferenceId: before.currentInferenceId,
  leaseExpiration: before.leaseExpiration,
  leaseRemainingMs: before.leaseExpiration === null ? null : before.leaseExpiration - before.serverNow,
  idleMs: before.updatedTime === null ? null : before.serverNow - before.updatedTime,
  messageCount: before.messageCount,
  lastTurnOutcome: before.lastTurnOutcome
});
if (mode === "interrupt") {
  const result = await client.interruptTurn(threadId);
  show("interrupt", result);
  const after = await client.threadSignals(threadId);
  show("after", {
    currentInferenceId: after.currentInferenceId,
    leaseExpiration: after.leaseExpiration,
    updatedTime: after.updatedTime,
    messageCount: after.messageCount
  });
}
