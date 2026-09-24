import assert from "node:assert/strict";
import test from "node:test";
import { NotionClient } from "../src/notion-client.js";
import type { NotionConfig } from "../src/config.js";
import type { ChatResult, ThreadSignals } from "../src/types.js";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";

function client(): NotionClient {
  return new NotionClient({
    apiBase: "https://example.test/api/v3",
    defaultModel: "test-model",
    requestTimeoutMs: 5000,
    defaultWebSearch: false,
    defaultWorkspaceSearch: false,
    defaultReadOnly: false,
    stateFilePath: undefined,
    keepAwake: {
      enabled: true,
      interrupt: false,
      autoContinue: true,
      maxContinues: 2,
      continueCooldownMs: 0,
      idleMs: 120000,
      pollMs: 30000,
      cooldownMs: 60000,
      maxNudges: 4,
      deadlineMs: 3600000
    },
    account: {
      tokenV2: "test-token",
      userId: "22222222-2222-4222-8222-222222222222",
      userName: "Test",
      userEmail: "test@example.com",
      spaceId: "33333333-3333-4333-8333-333333333333",
      spaceName: "Test",
      spaceViewId: "44444444-4444-4444-8444-444444444444",
      timezone: "UTC",
      clientVersion: "test",
      browserId: "55555555-5555-4555-8555-555555555555",
      deviceId: "66666666-6666-4666-8666-666666666666"
    }
  } as NotionConfig, async () => { throw new Error("unexpected network request"); });
}

const initial: ChatResult = {
  conversationId: CONVERSATION,
  text: "part one",
  model: "test-model",
  usage: { inputTokens: 10, outputTokens: 20 }
};

test("ordinary chat jobs press native Continue without a keep-awake watchdog and aggregate the result", async () => {
  const instance = client() as any;
  const decisions = [true, true, false];
  const continuationOptions: any[] = [];
  instance.shouldAutoContinueConversation = async () => decisions.shift() ?? false;
  instance.chat = async (options: any): Promise<ChatResult> => {
    continuationOptions.push(options);
    const index = continuationOptions.length + 1;
    return {
      conversationId: CONVERSATION,
      text: `part ${index}`,
      model: "test-model",
      usage: { inputTokens: index, outputTokens: index * 2 }
    };
  };

  const result = await instance.autoContinueChatResult(initial);
  assert.equal(continuationOptions.length, 2);
  assert.ok(continuationOptions.every((options) => options.conversationId === CONVERSATION));
  assert.ok(continuationOptions.every((options) => typeof options._continueTraceId === "string"));
  assert.ok(continuationOptions.every((options) => options._continueTraceId.length > 0));
  assert.ok(continuationOptions.every((options) => !("attachments" in options) && !("fileIds" in options)));
  assert.equal(result.text, "part one\n\npart 2\n\npart 3");
  assert.deepEqual(result.usage, { inputTokens: 15, outputTokens: 30 });
});

test("the global switch and Continue budget apply without creating a watchdog", async () => {
  const instance = client() as any;
  let chats = 0;
  instance.keepAwakeDefaults = () => ({ autoContinue: false, maxContinues: 100 });
  instance.shouldAutoContinueConversation = async () => true;
  instance.chat = async () => { chats += 1; return initial; };
  assert.deepEqual(await instance.autoContinueChatResult(initial), initial);
  assert.equal(chats, 0);

  instance.keepAwakeDefaults = () => ({ autoContinue: true, maxContinues: 1, continueCooldownMs: 0 });
  const capped = await instance.autoContinueChatResult(initial);
  assert.equal(chats, 1);
  assert.equal(capped.text, "part one");
});

test("only an unfinished native step-limit stop is approved automatically", async () => {
  const instance = client() as any;
  instance.sessions.set(CONVERSATION, {
    threadId: CONVERSATION,
    configId: "config",
    contextId: "context",
    originalDatetime: new Date(0).toISOString(),
    model: "test-model",
    updatedConfigIds: [],
    turnCount: 1,
    transport: "inference_transcript"
  });
  const signals: ThreadSignals = {
    serverNow: 1000,
    updatedTime: 900,
    currentInferenceId: null,
    leaseExpiration: null,
    lastUserMessageTime: 100,
    lastTurnOutcome: {
      status: "completed",
      completedTime: 900,
      stepCount: 100,
      inferenceId: "inference",
      finalStepId: "final"
    }
  };
  instance.threadSignals = async () => signals;
  let nativeReads = 0;
  instance.nativeContinuationState = async () => { nativeReads += 1; return true; };

  instance.finalStepShape = async () => ({
    stepId: "final", type: "agent-tool-result", state: "awaiting_permission", hasAnswerText: false, finishedAt: null
  });
  assert.equal(await instance.shouldAutoContinueConversation(CONVERSATION), false);
  assert.equal(nativeReads, 0);

  instance.finalStepShape = async () => ({
    stepId: "final", type: "agent-inference", state: "", hasAnswerText: true, finishedAt: 900
  });
  assert.equal(await instance.shouldAutoContinueConversation(CONVERSATION), false);
  assert.equal(nativeReads, 0);

  instance.finalStepShape = async () => ({
    stepId: "final", type: "agent-tool-result", state: "streaming", hasAnswerText: false, finishedAt: null
  });
  assert.equal(await instance.shouldAutoContinueConversation(CONVERSATION), true);
  assert.equal(nativeReads, 1);
});
