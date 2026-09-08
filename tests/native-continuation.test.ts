import assert from "node:assert/strict";
import test from "node:test";
import { buildNativeContinuationRequest, nativeIterationLimitReached } from "../src/native-continuation.js";
const script = { type: "workflow", enableScriptAgent: true };
const inference = (traceId: string, i: number) => ({ id: `${traceId}-${i}`, type: "agent-inference", traceId, value: [{ type: "tool_use" }] });
const steps = (n: number, traceId = "current") => Array.from({ length: n }, (_, i) => inference(traceId, i));

test("native Continue sends an empty partial transcript without approval fields", () => {
  const body = buildNativeContinuationRequest("space", "thread", "trace");
  assert.deepEqual(body.transcript, []);
  assert.equal(body.traceId, "trace");
  assert.equal(body.threadId, "thread");
  assert.equal(body.createThread, false);
  assert.equal(body.isPartialTranscript, true);
  assert.equal(body.asPatchResponse, false);
  assert.equal(body.generateTitle, false);
  for (const key of ["confirmToolStepIds", "rejectToolStepIds", "initialAgentActions", "threadParentPointer"]) assert.equal(key in body, false);
});
test("native script limit counts 100 AI iterations rather than workflow effects", () => {
  assert.equal(nativeIterationLimitReached(script, steps(99)), false);
  assert.equal(nativeIterationLimitReached(script, steps(100)), true);
  assert.equal(nativeIterationLimitReached(script, [...steps(2), ...Array.from({ length: 3000 }, () => ({ type: "workflow-effect-called" }))]), false);
});
test("a resumed execution inherits the iterations its turn already spent", () => {
  assert.equal(nativeIterationLimitReached(script, [...steps(101, "first"), ...steps(26, "second")]), true);
  assert.equal(nativeIterationLimitReached(script, steps(26, "second")), false);
});
test("finished answers and quoted confirmation text are not native step limits", () => {
  const history = [...steps(100), { type: "agent-inference", traceId: "current", value: [{ type: "text", content: "This task is taking a lot of steps. Please confirm you want the agent to keep going." }] }];
  assert.equal(nativeIterationLimitReached(script, history), false);
});
test("non-script workflow limits follow the native 15/50 distinction", () => {
  const config = { type: "workflow", enableScriptAgent: false };
  assert.equal(nativeIterationLimitReached(config, steps(14)), false);
  assert.equal(nativeIterationLimitReached(config, steps(15)), true);
  assert.equal(nativeIterationLimitReached(config, [{ type: "agent-trigger" }, ...steps(49)]), false);
  assert.equal(nativeIterationLimitReached(config, [{ type: "agent-trigger" }, ...steps(50)]), true);
});
test("missing native metadata is unknown rather than an invented pause", () => {
  assert.equal(nativeIterationLimitReached({}, steps(100)), null);
  assert.equal(nativeIterationLimitReached(script, [...steps(99), { type: "agent-inference", traceId: "current" }]), null);
  assert.equal(nativeIterationLimitReached(script, []), false);
});
