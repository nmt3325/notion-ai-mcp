/**
 * Last-words logging for the two entry points.
 *
 * Background chat turns run detached from the request that started them, so a stray rejection used to
 * take the server down with no trace and no automatic recovery. Logging a structured line keeps the
 * stack, and keeping the process alive keeps the other tools answering.
 */
export function installProcessGuards(component: string): void {
  const log = (event: string, error: unknown): void => {
    const detail = error instanceof Error
      ? { message: error.message, stack: error.stack }
      : { message: String(error) };
    try {
      process.stderr.write(`${JSON.stringify({ level: "error", component, event, time: new Date().toISOString(), pid: process.pid, ...detail })}\n`);
    } catch { /* logging must never throw */ }
  };
  process.on("unhandledRejection", (reason: unknown) => { log("unhandledRejection", reason); });
  process.on("uncaughtException", (error: unknown) => { log("uncaughtException", error); });
}
