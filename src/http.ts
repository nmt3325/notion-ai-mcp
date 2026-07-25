#!/usr/bin/env node
import { runHttpServer } from "./http-server.js";

runHttpServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`notion-ai-mcp-http: ${message}\n`);
  process.exitCode = 1;
});
