const ADAPTER_EXTENSIONLESS_IMPORTS = new Set([
  "matrix-js-sdk/lib/http-api/errors",
  "matrix-js-sdk/lib/crypto-api/recovery-key",
  "matrix-js-sdk/lib/logger",
  "matrix-js-sdk/lib/sync-accumulator",
  "matrix-js-sdk/lib/store/memory"
]);

type NextResolve = (specifier: string, context: unknown) => Promise<unknown>;

/**
 * @beeper/chat-adapter-matrix 0.2.0 publishes five ESM imports without the
 * .js suffix required by native Node. Keep the compatibility hook restricted
 * to those exact upstream imports and let Node resolve everything else.
 */
export async function resolve(
  specifier: string,
  context: unknown,
  nextResolve: NextResolve
): Promise<unknown> {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
      && ADAPTER_EXTENSIONLESS_IMPORTS.has(specifier)
    ) {
      return nextResolve(`${specifier}.js`, context);
    }
    throw error;
  }
}
