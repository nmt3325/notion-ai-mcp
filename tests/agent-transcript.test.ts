import assert from "node:assert/strict";
import test from "node:test";
import { agentTranscriptError, applyAgentTranscriptPatches, createAgentTranscriptState, isAgentTranscriptTurnComplete, latestAgentTranscriptText } from "../src/agent-transcript.js";

test("Agent Service transcript applies append patches and detects completion", () => {
  const state = createAgentTranscriptState();
  applyAgentTranscriptPatches(state, [
    { op: "put", entity: { id: "assistant-1", kind: "assistant_message", source: "provisional", sequence: 2, content: [{ type: "text", text: "" }] } },
    { op: "patch", id: "assistant-1", ops: [{ op: "append", path: "/content/0/text", value: "File " }, { op: "append", path: "/content/0/text", value: "seen" }] },
    { op: "put", entity: { id: "done-1", kind: "turn_completed", source: "committed", sequence: 3, stop_reason: "completed" } }
  ]);
  assert.equal(latestAgentTranscriptText(state), "File seen");
  assert.equal(isAgentTranscriptTurnComplete(state), true);
});

test("Agent Service transcript handles pending patches, rewinds, and errors", () => {
  const state = createAgentTranscriptState();
  applyAgentTranscriptPatches(state, [
    { op: "patch", id: "tool-1", ops: [{ op: "replace", path: "/status", value: "completed" }] },
    { op: "put", entity: { id: "tool-1", kind: "tool", source: "committed", sequence: 2, status: "running" } },
    { op: "put", entity: { id: "old", kind: "assistant_message", source: "committed", sequence: 4, content: [{ type: "text", text: "old" }] } },
    { op: "rewind", event_sequence: 5, rewind_to_sequence: 3 },
    { op: "put", entity: { id: "error-1", kind: "error", source: "committed", sequence: 6, message: "boom" } }
  ]);
  assert.equal(state.entities.get("tool-1")?.status, "completed");
  assert.equal(state.entities.has("old"), false);
  assert.equal(agentTranscriptError(state), "boom");
});


test("Agent Service transcript rejects invalid rewind and orphan provisional append", () => {
  const state = createAgentTranscriptState();
  assert.throws(() => applyAgentTranscriptPatches(state, [
    { op: "rewind", event_sequence: 3, rewind_to_sequence: 3 }
  ]), /rewind bounds/);
  assert.throws(() => applyAgentTranscriptPatches(state, [
    { op: "patch", id: "missing", ops: [{ op: "append", path: "/content/0/text", value: "x" }] }
  ]), /Cannot stash/);
});
