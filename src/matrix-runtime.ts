import { createMatrixAdapter, type MatrixAdapter } from "@beeper/chat-adapter-matrix";
import { Chat, ConsoleLogger, type Adapter } from "chat";
import { loadConfig } from "./config.js";
import { createFileState } from "./file-state.js";
import {
  MatrixConversationStore,
  MatrixNotionBridge,
  type MatrixBridgeSink
} from "./matrix-bridge.js";
import { loadMatrixConfig } from "./matrix-config.js";
import { NotionClient } from "./notion-client.js";

class MatrixAdapterSink implements MatrixBridgeSink {
  constructor(private readonly adapter: MatrixAdapter) {}

  async postMarkdown(threadId: string, markdown: string): Promise<void> {
    await this.adapter.postMessage(threadId, { markdown });
  }

  async startTyping(threadId: string): Promise<void> {
    await this.adapter.startTyping(threadId);
  }
}

export interface RunningMatrixBridge {
  shutdown(): Promise<void>;
}

export async function startMatrixBridge(): Promise<RunningMatrixBridge> {
  const matrixConfig = loadMatrixConfig();
  const notionConfig = loadConfig();
  const logger = new ConsoleLogger(matrixConfig.logLevel, "notion-ai-matrix");
  const matrix = createMatrixAdapter(matrixConfig.adapter);
  const notion = new NotionClient(notionConfig);
  const state = createFileState(matrixConfig.stateFilePath);
  await state.connect();

  const store = new MatrixConversationStore(state);
  await store.initialize();

  notion.startWebConfirmations((event) => logger.debug(event));
  const bridge = new MatrixNotionBridge(
    notion,
    new MatrixAdapterSink(matrix),
    store,
    matrixConfig.bridge,
    logger
  );
  const chat = new Chat({
    userName: matrixConfig.botUserName,
    logger,
    state,
    concurrency: "concurrent",
    // Adapter 0.2.0 declares botUserId as string | undefined while Chat marks it optional.
    // They are runtime-compatible; the cast only bridges exactOptionalPropertyTypes.
    adapters: { matrix: matrix as unknown as Adapter }
  });

  const forward = async (
    thread: { id: string },
    message: { id: string; text: string }
  ): Promise<void> => {
    await bridge.handleMessage({
      threadId: thread.id,
      messageId: message.id,
      text: message.text
    });
  };

  chat.onDirectMessage(async (thread, message) => {
    if (!(await thread.isSubscribed())) await thread.subscribe();
    await forward(thread, message);
  });

  chat.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await forward(thread, message);
  });

  chat.onSubscribedMessage(forward);

  try {
    await chat.initialize();
  } catch (error) {
    notion.stopWebConfirmations();
    await matrix.shutdown().catch(() => undefined);
    await state.disconnect().catch(() => undefined);
    throw error;
  }

  logger.info("Matrix/Beeper bridge started", {
    stateFile: matrixConfig.stateFilePath,
    e2ee: Boolean(matrixConfig.adapter.recoveryKey)
  });

  void bridge.resumePending().catch((error: unknown) => {
    logger.error("Failed to resume pending Matrix turns", error);
  });

  let shutdownPromise: Promise<void> | null = null;
  return {
    shutdown(): Promise<void> {
      bridge.stop();
      shutdownPromise ??= (async () => {
        notion.stopWebConfirmations();
        const failures: unknown[] = [];
        try { await matrix.shutdown(); }
        catch (error) { failures.push(error); }
        try { await chat.shutdown(); }
        catch (error) { failures.push(error); }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, "Matrix adapter and Chat state shutdown both failed");
        }
      })();
      return shutdownPromise;
    }
  };
}
