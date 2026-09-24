import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Message, type Lock, type QueueEntry, type SerializedMessage, type StateAdapter } from "chat";

interface CacheEntry {
  value: unknown;
  expiresAt: number | null;
}

interface PersistedState {
  version: 1;
  subscriptions: string[];
  cache: Record<string, CacheEntry>;
  queues: Record<string, QueueEntry[]>;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function reviveValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveValue);
  const record = object(value);
  if (!record) return value;
  if (record._type === "chat:Message") {
    return Message.fromJSON(record as unknown as SerializedMessage);
  }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, reviveValue(child)]));
}

function parseState(raw: string, filePath: string): PersistedState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot parse Matrix state file ${filePath}: ${message}`);
  }
  const root = object(parsed);
  if (!root || root.version !== 1) {
    throw new Error(`Unsupported Matrix state file format in ${filePath}`);
  }

  const subscriptions = Array.isArray(root.subscriptions)
    ? root.subscriptions.filter((value): value is string => typeof value === "string")
    : [];

  const cache: Record<string, CacheEntry> = {};
  const rawCache = object(root.cache) ?? {};
  for (const [key, rawEntry] of Object.entries(rawCache)) {
    const entry = object(rawEntry);
    if (!entry || !("value" in entry)) continue;
    const expiresAt = entry.expiresAt === null || typeof entry.expiresAt === "number"
      ? entry.expiresAt
      : null;
    cache[key] = { value: reviveValue(entry.value), expiresAt };
  }

  const queues: Record<string, QueueEntry[]> = {};
  const rawQueues = object(root.queues) ?? {};
  for (const [threadId, rawQueue] of Object.entries(rawQueues)) {
    if (!Array.isArray(rawQueue)) continue;
    const queue: QueueEntry[] = [];
    for (const rawEntry of rawQueue) {
      const entry = object(rawEntry);
      const message = entry ? reviveValue(entry.message) : null;
      if (
        entry
        && typeof entry.enqueuedAt === "number"
        && typeof entry.expiresAt === "number"
        && message instanceof Message
      ) {
        queue.push({ enqueuedAt: entry.enqueuedAt, expiresAt: entry.expiresAt, message });
      }
    }
    if (queue.length > 0) queues[threadId] = queue;
  }

  return { version: 1, subscriptions, cache, queues };
}

/**
 * A single-process, durable Chat SDK state adapter backed by one mode-0600 JSON file.
 * Every mutation is serialized in-process and persisted with fsync + atomic rename.
 */
export class FileStateAdapter implements StateAdapter {
  private readonly subscriptions = new Set<string>();
  private readonly locks = new Map<string, Lock>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly queues = new Map<string, QueueEntry[]>();
  private connected = false;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {
    if (!filePath.trim()) throw new Error("Matrix state file path is required");
  }

  private async exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const previous = this.operationTail;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error("FileStateAdapter is not connected. Call connect() first.");
    }
  }

  private removeExpired(now = Date.now()): boolean {
    let changed = false;
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.cache.delete(key);
        changed = true;
      }
    }
    for (const [threadId, queue] of this.queues) {
      const live = queue.filter((entry) => entry.expiresAt > now);
      if (live.length !== queue.length) changed = true;
      if (live.length > 0) this.queues.set(threadId, live);
      else this.queues.delete(threadId);
    }
    return changed;
  }

  private document(): PersistedState {
    return {
      version: 1,
      subscriptions: [...this.subscriptions].sort(),
      cache: Object.fromEntries(this.cache),
      queues: Object.fromEntries(this.queues)
    };
  }

  private async persist(): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify(this.document())}\n`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporaryPath, "w", 0o600);
      await handle.writeFile(body, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
      try {
        const directoryHandle = await open(directory, "r");
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } catch {
        // Directory fsync is unavailable on some platforms; the file rename is still atomic.
      }
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async connect(): Promise<void> {
    await this.exclusive(async () => {
      if (this.connected) return;
      this.subscriptions.clear();
      this.locks.clear();
      this.cache.clear();
      this.queues.clear();
      let existed = true;
      try {
        const saved = parseState(await readFile(this.filePath, "utf8"), this.filePath);
        for (const threadId of saved.subscriptions) this.subscriptions.add(threadId);
        for (const [key, entry] of Object.entries(saved.cache)) this.cache.set(key, entry);
        for (const [threadId, queue] of Object.entries(saved.queues)) this.queues.set(threadId, queue);
        await chmod(this.filePath, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        existed = false;
      }
      this.connected = true;
      const changed = this.removeExpired();
      if (!existed || changed) await this.persist();
    });
  }

  async disconnect(): Promise<void> {
    await this.exclusive(async () => {
      if (!this.connected) return;
      this.removeExpired();
      await this.persist();
      this.locks.clear();
      this.connected = false;
    });
  }

  async subscribe(threadId: string): Promise<void> {
    await this.exclusive(async () => {
      this.ensureConnected();
      if (this.subscriptions.has(threadId)) return;
      this.subscriptions.add(threadId);
      await this.persist();
    });
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.exclusive(async () => {
      this.ensureConnected();
      if (!this.subscriptions.delete(threadId)) return;
      await this.persist();
    });
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return this.exclusive(() => {
      this.ensureConnected();
      return this.subscriptions.has(threadId);
    });
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    return this.exclusive(() => {
      this.ensureConnected();
      const now = Date.now();
      const existing = this.locks.get(threadId);
      if (existing && existing.expiresAt > now) return null;
      const lock = { threadId, token: randomUUID(), expiresAt: now + ttlMs };
      this.locks.set(threadId, lock);
      return { ...lock };
    });
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await this.exclusive(() => {
      this.ensureConnected();
      this.locks.delete(threadId);
    });
  }

  async releaseLock(lock: Lock): Promise<void> {
    await this.exclusive(() => {
      this.ensureConnected();
      const existing = this.locks.get(lock.threadId);
      if (existing?.token === lock.token) this.locks.delete(lock.threadId);
    });
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    return this.exclusive(() => {
      this.ensureConnected();
      const existing = this.locks.get(lock.threadId);
      if (!existing || existing.token !== lock.token || existing.expiresAt <= Date.now()) {
        if (existing?.token === lock.token) this.locks.delete(lock.threadId);
        return false;
      }
      existing.expiresAt = Date.now() + ttlMs;
      lock.expiresAt = existing.expiresAt;
      return true;
    });
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return this.exclusive(async () => {
      this.ensureConnected();
      const entry = this.cache.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        this.cache.delete(key);
        await this.persist();
        return null;
      }
      return entry.value as T;
    });
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    await this.exclusive(async () => {
      this.ensureConnected();
      this.cache.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
      await this.persist();
    });
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    return this.exclusive(async () => {
      this.ensureConnected();
      const existing = this.cache.get(key);
      if (existing && (existing.expiresAt === null || existing.expiresAt > Date.now())) return false;
      this.cache.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
      await this.persist();
      return true;
    });
  }

  async delete(key: string): Promise<void> {
    await this.exclusive(async () => {
      this.ensureConnected();
      if (!this.cache.delete(key)) return;
      await this.persist();
    });
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number }
  ): Promise<void> {
    await this.exclusive(async () => {
      this.ensureConnected();
      const existing = this.cache.get(key);
      let list = existing
        && (existing.expiresAt === null || existing.expiresAt > Date.now())
        && Array.isArray(existing.value)
        ? [...existing.value]
        : [];
      list.push(value);
      if (options?.maxLength && list.length > options.maxLength) {
        list = list.slice(-options.maxLength);
      }
      this.cache.set(key, {
        value: list,
        expiresAt: options?.ttlMs ? Date.now() + options.ttlMs : null
      });
      await this.persist();
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const value = await this.get<unknown[]>(key);
    return Array.isArray(value) ? value as T[] : [];
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    return this.exclusive(async () => {
      this.ensureConnected();
      const queue = [...(this.queues.get(threadId) ?? []), entry];
      const limit = Math.max(1, maxSize);
      const trimmed = queue.length > limit ? queue.slice(-limit) : queue;
      this.queues.set(threadId, trimmed);
      await this.persist();
      return trimmed.length;
    });
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    return this.exclusive(async () => {
      this.ensureConnected();
      const queue = this.queues.get(threadId);
      if (!queue) return null;
      const now = Date.now();
      let entry: QueueEntry | undefined;
      while ((entry = queue.shift())) {
        if (entry.expiresAt > now) break;
        entry = undefined;
      }
      if (queue.length === 0) this.queues.delete(threadId);
      else this.queues.set(threadId, queue);
      await this.persist();
      return entry ?? null;
    });
  }

  async queueDepth(threadId: string): Promise<number> {
    return this.exclusive(async () => {
      this.ensureConnected();
      const queue = this.queues.get(threadId);
      if (!queue) return 0;
      const live = queue.filter((entry) => entry.expiresAt > Date.now());
      if (live.length !== queue.length) {
        if (live.length > 0) this.queues.set(threadId, live);
        else this.queues.delete(threadId);
        await this.persist();
      }
      return live.length;
    });
  }
}

export function createFileState(filePath: string): FileStateAdapter {
  return new FileStateAdapter(filePath);
}
