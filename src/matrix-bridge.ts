import type { StateAdapter } from "chat";
import type { MatrixBridgeOptions } from "./matrix-config.js";
import type { ChatJobLookup, ChatStartResult } from "./types.js";

const THREAD_STATE_KEY = "notion-ai-matrix:bridge:threads:v1";
const MAX_PROCESSED_MESSAGE_IDS = 64;
const SAFE_ERROR_MESSAGE = "Notion AI couldn't complete that request. Check the bridge logs and try again.";

export interface NotionBridgeClient {
  startChat(options: {
    prompt: string;
    conversationId?: string;
    model?: string;
    reasoningEffort?: string;
    webSearch?: boolean;
    workspaceSearch?: boolean;
    readOnly?: boolean;
  }): Promise<ChatStartResult>;
  chatResult(options: {
    jobId?: string;
    conversationId?: string;
    waitMs?: number;
  }): Promise<ChatJobLookup>;
}

export interface MatrixBridgeSink {
  postMarkdown(threadId: string, markdown: string): Promise<void>;
  startTyping(threadId: string): Promise<void>;
}

export interface MatrixInboundMessage {
  threadId: string;
  messageId: string;
  text: string;
}

export interface PendingMatrixTurn {
  jobId: string;
  conversationId: string;
  messageId: string;
  startedAt: number;
}

export interface MatrixThreadState {
  conversationId?: string;
  pending?: PendingMatrixTurn;
  processedMessageIds?: string[];
  updatedAt: number;
}

interface BridgeLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sanitizePending(value: unknown): PendingMatrixTurn | undefined {
  const pending = object(value);
  if (
    !pending
    || typeof pending.jobId !== "string"
    || typeof pending.conversationId !== "string"
    || typeof pending.messageId !== "string"
    || typeof pending.startedAt !== "number"
  ) return undefined;
  return {
    jobId: pending.jobId,
    conversationId: pending.conversationId,
    messageId: pending.messageId,
    startedAt: pending.startedAt
  };
}

function sanitizeMessageIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))]
    .slice(-MAX_PROCESSED_MESSAGE_IDS);
}

function sanitizeThreads(value: unknown): Record<string, MatrixThreadState> {
  const source = object(value) ?? {};
  const result: Record<string, MatrixThreadState> = {};
  for (const [threadId, raw] of Object.entries(source)) {
    const record = object(raw);
    if (!record || typeof record.updatedAt !== "number") continue;
    const conversationId = typeof record.conversationId === "string"
      ? record.conversationId
      : undefined;
    const pending = sanitizePending(record.pending);
    const processedMessageIds = sanitizeMessageIds(record.processedMessageIds);
    if (!conversationId && !pending && processedMessageIds.length === 0) continue;
    result[threadId] = {
      updatedAt: record.updatedAt,
      ...(conversationId ? { conversationId } : {}),
      ...(pending ? { pending } : {}),
      ...(processedMessageIds.length > 0 ? { processedMessageIds } : {})
    };
  }
  return result;
}

function cloneState(value: MatrixThreadState | undefined): MatrixThreadState | null {
  if (!value) return null;
  return {
    updatedAt: value.updatedAt,
    ...(value.conversationId ? { conversationId: value.conversationId } : {}),
    ...(value.pending ? { pending: { ...value.pending } } : {}),
    ...(value.processedMessageIds ? { processedMessageIds: [...value.processedMessageIds] } : {})
  };
}

export class MatrixConversationStore {
  private threads: Record<string, MatrixThreadState> = {};
  private loaded = false;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly state: StateAdapter) {}

  private async exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const previous = this.operationTail;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  private ensureLoaded(): void {
    if (!this.loaded) throw new Error("MatrixConversationStore is not initialized");
  }

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      if (this.loaded) return;
      this.threads = sanitizeThreads(await this.state.get(THREAD_STATE_KEY));
      this.loaded = true;
    });
  }

  async get(threadId: string): Promise<MatrixThreadState | null> {
    return this.exclusive(() => {
      this.ensureLoaded();
      return cloneState(this.threads[threadId]);
    });
  }

  async markProcessed(threadId: string, messageId: string): Promise<void> {
    await this.exclusive(async () => {
      this.ensureLoaded();
      const current = this.threads[threadId];
      if (current?.processedMessageIds?.includes(messageId)) return;
      const processedMessageIds = [
        ...(current?.processedMessageIds ?? []),
        messageId
      ].slice(-MAX_PROCESSED_MESSAGE_IDS);
      this.threads[threadId] = {
        ...(current?.conversationId ? { conversationId: current.conversationId } : {}),
        ...(current?.pending ? { pending: { ...current.pending } } : {}),
        processedMessageIds,
        updatedAt: Date.now()
      };
      await this.state.set(THREAD_STATE_KEY, this.threads);
    });
  }

  async pending(): Promise<Array<{ threadId: string; pending: PendingMatrixTurn }>> {
    return this.exclusive(() => {
      this.ensureLoaded();
      return Object.entries(this.threads)
        .filter((entry): entry is [string, MatrixThreadState & { pending: PendingMatrixTurn }] => Boolean(entry[1].pending))
        .map(([threadId, state]) => ({ threadId, pending: { ...state.pending } }));
    });
  }

  async setPending(threadId: string, pending: PendingMatrixTurn): Promise<void> {
    await this.exclusive(async () => {
      this.ensureLoaded();
      const current = this.threads[threadId];
      const processedMessageIds = [
        ...(current?.processedMessageIds ?? []).filter((messageId) => messageId !== pending.messageId),
        pending.messageId
      ].slice(-MAX_PROCESSED_MESSAGE_IDS);
      this.threads[threadId] = {
        conversationId: pending.conversationId,
        pending: { ...pending },
        processedMessageIds,
        updatedAt: Date.now()
      };
      await this.state.set(THREAD_STATE_KEY, this.threads);
    });
  }

  async finishPending(
    threadId: string,
    jobId: string,
    conversationId?: string
  ): Promise<boolean> {
    return this.exclusive(async () => {
      this.ensureLoaded();
      const current = this.threads[threadId];
      if (!current?.pending || current.pending.jobId !== jobId) return false;
      const resolvedConversationId = conversationId || current.conversationId || current.pending.conversationId;
      this.threads[threadId] = {
        ...(resolvedConversationId ? { conversationId: resolvedConversationId } : {}),
        ...(current.processedMessageIds ? { processedMessageIds: [...current.processedMessageIds] } : {}),
        updatedAt: Date.now()
      };
      await this.state.set(THREAD_STATE_KEY, this.threads);
      return true;
    });
  }

  async reset(threadId: string, processedMessageId?: string): Promise<void> {
    await this.exclusive(async () => {
      this.ensureLoaded();
      const current = this.threads[threadId];
      const processedMessageIds = [
        ...(current?.processedMessageIds ?? []).filter((messageId) => messageId !== processedMessageId),
        ...(processedMessageId ? [processedMessageId] : [])
      ].slice(-MAX_PROCESSED_MESSAGE_IDS);
      if (processedMessageIds.length > 0) {
        this.threads[threadId] = {
          processedMessageIds,
          updatedAt: Date.now()
        };
      } else {
        delete this.threads[threadId];
      }
      await this.state.set(THREAD_STATE_KEY, this.threads);
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function splitMarkdown(markdown: string, maxChars: number): string[] {
  const source = markdown.trim();
  if (!source) return ["_(Notion AI returned an empty response.)_"];
  if (source.length <= maxChars) return [source];

  const chunks: string[] = [];
  let remaining = source;
  while (remaining.length > maxChars) {
    let boundary = remaining.lastIndexOf("\n\n", maxChars);
    if (boundary < Math.floor(maxChars / 2)) boundary = remaining.lastIndexOf("\n", maxChars);
    if (boundary < Math.floor(maxChars / 2)) boundary = maxChars;
    const chunk = remaining.slice(0, boundary).trimEnd();
    chunks.push(chunk || remaining.slice(0, maxChars));
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

type CollectionResult = "completed" | "failed" | "pending";

interface CollectionOptions {
  budgetMs: number;
  notifyTimeout: boolean;
  notifyLookupError: boolean;
}

export class MatrixNotionBridge {
  private readonly threadTails = new Map<string, Promise<void>>();
  private readonly resumeTimers = new Map<string, {
    jobId: string;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private stopped = false;

  constructor(
    private readonly notion: NotionBridgeClient,
    private readonly sink: MatrixBridgeSink,
    private readonly store: MatrixConversationStore,
    private readonly options: MatrixBridgeOptions,
    private readonly logger: BridgeLogger = console,
    private readonly sleep: (ms: number) => Promise<void> = delay,
    private readonly now: () => number = Date.now
  ) {}

  stop(): void {
    this.stopped = true;
    for (const { timer } of this.resumeTimers.values()) clearTimeout(timer);
    this.resumeTimers.clear();
  }

  handleMessage(message: MatrixInboundMessage): Promise<void> {
    return this.enqueue(message.threadId, () => this.processMessage(message));
  }

  async resumePending(): Promise<void> {
    const pending = await this.store.pending();
    await Promise.all(pending.map(({ threadId, pending: turn }) => this.enqueue(
      threadId,
      async () => {
        const outcome = await this.collectPending(threadId, turn, {
          budgetMs: 0,
          notifyTimeout: false,
          notifyLookupError: false
        });
        if (outcome === "pending") this.schedulePendingResume(threadId, turn);
      }
    )));
  }

  private enqueue(threadId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.threadTails.get(threadId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(operation);
    this.threadTails.set(threadId, current);
    void current.finally(() => {
      if (this.threadTails.get(threadId) === current) this.threadTails.delete(threadId);
    }).catch(() => undefined);
    return current;
  }

  private async processMessage(message: MatrixInboundMessage): Promise<void> {
    const text = message.text.trim();
    if (!text || this.stopped) return;

    let current = await this.store.get(message.threadId);
    if (current?.processedMessageIds?.includes(message.messageId)) {
      if (current.pending?.messageId === message.messageId) {
        this.schedulePendingResume(message.threadId, current.pending);
      }
      return;
    }

    const command = text.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
    if (command === "!help") {
      await this.sink.postMarkdown(message.threadId, [
        "**Notion AI bridge commands**",
        "- `!new` — start a new Notion conversation for this Matrix thread",
        "- `!status` — show the current conversation and generation state",
        "- `!help` — show this help",
        "",
        "Any other text is sent to Notion AI."
      ].join("\n"));
      await this.store.markProcessed(message.threadId, message.messageId);
      return;
    }
    if (command === "!status") {
      const current = await this.store.get(message.threadId);
      if (current?.pending) {
        const outcome = await this.collectPending(message.threadId, current.pending, {
          budgetMs: 0,
          notifyTimeout: false,
          notifyLookupError: false
        });
        if (outcome === "pending") this.schedulePendingResume(message.threadId, current.pending);
      }
      await this.postStatus(message.threadId);
      await this.store.markProcessed(message.threadId, message.messageId);
      return;
    }
    if (command === "!new") {
      this.cancelPendingResume(message.threadId);
      await this.store.reset(message.threadId, message.messageId);
      await this.sink.postMarkdown(
        message.threadId,
        "Started a new Notion AI conversation. Your next message will create the thread."
      );
      return;
    }
    if (command.startsWith("!")) {
      await this.sink.postMarkdown(message.threadId, "Unknown command. Send `!help` for available commands.");
      await this.store.markProcessed(message.threadId, message.messageId);
      return;
    }

    if (current?.pending) {
      const outcome = await this.collectPending(message.threadId, current.pending, {
        budgetMs: 0,
        notifyTimeout: false,
        notifyLookupError: false
      });
      if (outcome === "pending" || this.stopped) {
        this.schedulePendingResume(message.threadId, current.pending);
        await this.sink.postMarkdown(
          message.threadId,
          "The previous Notion AI response is still running, so this message was not sent. Try again after it completes."
        );
        await this.store.markProcessed(message.threadId, message.messageId);
        return;
      }
      current = await this.store.get(message.threadId);
    }

    await this.sink.startTyping(message.threadId).catch(() => undefined);
    let started: ChatStartResult;
    try {
      started = await this.notion.startChat({
        prompt: text,
        ...(current?.conversationId ? { conversationId: current.conversationId } : {}),
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.reasoningEffort ? { reasoningEffort: this.options.reasoningEffort } : {}),
        ...(this.options.webSearch !== undefined ? { webSearch: this.options.webSearch } : {}),
        ...(this.options.workspaceSearch !== undefined ? { workspaceSearch: this.options.workspaceSearch } : {}),
        ...(this.options.readOnly !== undefined ? { readOnly: this.options.readOnly } : {})
      });
    } catch (error) {
      this.logger.error?.("Failed to start Notion AI Matrix turn", { error: errorMessage(error) });
      await this.sink.postMarkdown(message.threadId, SAFE_ERROR_MESSAGE);
      return;
    }

    const pending: PendingMatrixTurn = {
      jobId: started.jobId,
      conversationId: started.conversationId,
      messageId: message.messageId,
      startedAt: started.startedAt
    };
    await this.store.setPending(message.threadId, pending);
    const outcome = await this.collectPending(message.threadId, pending, {
      budgetMs: this.options.responseTimeoutMs,
      notifyTimeout: true,
      notifyLookupError: true
    });
    if (outcome === "pending") this.schedulePendingResume(message.threadId, pending);
  }

  private async postStatus(threadId: string): Promise<void> {
    const state = await this.store.get(threadId);
    if (!state?.conversationId) {
      await this.sink.postMarkdown(threadId, "No Notion AI conversation is linked to this Matrix thread yet.");
      return;
    }
    const lines = [
      `Notion conversation: \`${state.conversationId}\``,
      state.pending
        ? `Status: generating (${Math.max(0, Math.round((this.now() - state.pending.startedAt) / 1000))}s elapsed)`
        : "Status: ready"
    ];
    await this.sink.postMarkdown(threadId, lines.join("\n"));
  }

  private cancelPendingResume(threadId: string, jobId?: string): void {
    const scheduled = this.resumeTimers.get(threadId);
    if (!scheduled || (jobId && scheduled.jobId !== jobId)) return;
    clearTimeout(scheduled.timer);
    this.resumeTimers.delete(threadId);
  }

  private schedulePendingResume(threadId: string, pending: PendingMatrixTurn): void {
    if (this.stopped) return;
    const existing = this.resumeTimers.get(threadId);
    if (existing?.jobId === pending.jobId) return;
    if (existing) clearTimeout(existing.timer);

    const scheduled = {
      jobId: pending.jobId,
      timer: setTimeout(() => {
        if (this.resumeTimers.get(threadId) !== scheduled) return;
        this.resumeTimers.delete(threadId);
        void this.enqueue(threadId, async () => {
          if (this.stopped) return;
          const current = await this.store.get(threadId);
          if (current?.pending?.jobId !== pending.jobId) return;
          const outcome = await this.collectPending(threadId, pending, {
            budgetMs: 0,
            notifyTimeout: false,
            notifyLookupError: false
          });
          if (outcome === "pending") this.schedulePendingResume(threadId, pending);
        }).catch((error: unknown) => {
          this.logger.error?.("Failed to resume a pending Notion AI Matrix turn", {
            threadId,
            conversationId: pending.conversationId,
            error: errorMessage(error)
          });
          this.schedulePendingResume(threadId, pending);
        });
      }, this.options.pollIntervalMs)
    };
    scheduled.timer.unref?.();
    this.resumeTimers.set(threadId, scheduled);
  }

  private async lookupPending(pending: PendingMatrixTurn): Promise<ChatJobLookup> {
    try {
      return await this.notion.chatResult({
        jobId: pending.jobId,
        conversationId: pending.conversationId,
        waitMs: 0
      });
    } catch (error) {
      if (!errorMessage(error).includes("Unknown jobId")) throw error;
      this.logger.warn?.("Notion AI job cache entry is missing; falling back to thread recovery", {
        jobId: pending.jobId,
        conversationId: pending.conversationId
      });
      return this.notion.chatResult({ conversationId: pending.conversationId, waitMs: 0 });
    }
  }

  private async collectPending(
    threadId: string,
    pending: PendingMatrixTurn,
    options: CollectionOptions
  ): Promise<CollectionResult> {
    const deadline = this.now() + options.budgetMs;
    for (;;) {
      if (this.stopped) return "pending";
      await this.sink.startTyping(threadId).catch(() => undefined);
      let result: ChatJobLookup;
      try {
        result = await this.lookupPending(pending);
      } catch (error) {
        this.logger.error?.("Failed to collect Notion AI Matrix turn", {
          threadId,
          jobId: pending.jobId,
          conversationId: pending.conversationId,
          error: errorMessage(error)
        });
        if (options.notifyLookupError) {
          await this.sink.postMarkdown(threadId, SAFE_ERROR_MESSAGE);
        }
        return "pending";
      }
      if (this.stopped) return "pending";

      if (result.status === "completed") {
        try {
          for (const chunk of splitMarkdown(result.text ?? "", this.options.maxMessageChars)) {
            await this.sink.postMarkdown(threadId, chunk);
          }
          await this.store.finishPending(
            threadId,
            pending.jobId,
            result.conversationId || pending.conversationId
          );
          this.cancelPendingResume(threadId, pending.jobId);
          return "completed";
        } catch (error) {
          this.schedulePendingResume(threadId, pending);
          throw error;
        }
      }

      if (result.status === "failed") {
        this.logger.error?.("Notion AI Matrix turn failed", {
          threadId,
          conversationId: result.conversationId,
          error: result.error ?? "Unknown Notion AI error"
        });
        try {
          await this.sink.postMarkdown(threadId, SAFE_ERROR_MESSAGE);
          await this.store.finishPending(
            threadId,
            pending.jobId,
            result.conversationId || pending.conversationId
          );
          this.cancelPendingResume(threadId, pending.jobId);
          return "failed";
        } catch (error) {
          this.schedulePendingResume(threadId, pending);
          throw error;
        }
      }

      const remaining = deadline - this.now();
      if (remaining <= 0) {
        if (options.notifyTimeout) {
          await this.sink.postMarkdown(
            threadId,
            "Notion AI is still generating. The bridge saved this turn and will recover the answer in the background; send `!status` to check it."
          );
        }
        return "pending";
      }
      await this.sleep(Math.min(this.options.pollIntervalMs, remaining));
    }
  }
}
