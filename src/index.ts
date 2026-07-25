#!/usr/bin/env node
import { runServer } from "./server.js";

runServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`notion-ai-mcp: ${message}\n`);
  process.exitCode = 1;
});
