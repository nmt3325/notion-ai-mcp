#!/usr/bin/env node
import { startMatrixBridge, type RunningMatrixBridge } from "./matrix-runtime.js";
import { installProcessGuards } from "./process-guards.js";

installProcessGuards("notion-ai-matrix");

let runtime: RunningMatrixBridge | null = null;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`notion-ai-matrix: received ${signal}, shutting down\n`);
  try {
    await runtime?.shutdown();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`notion-ai-matrix: shutdown failed: ${message}\n`);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

startMatrixBridge()
  .then((started) => {
    runtime = started;
    if (shuttingDown) {
      void started.shutdown().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`notion-ai-matrix: shutdown failed: ${message}\n`);
        process.exitCode = 1;
      });
    }
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`notion-ai-matrix: ${message}\n`);
    process.exitCode = 1;
  });
