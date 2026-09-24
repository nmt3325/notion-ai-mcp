import { register } from "node:module";
import type { MatrixAdapter } from "@beeper/chat-adapter-matrix";

export type { MatrixAdapter };

type MatrixAdapterModule = typeof import("@beeper/chat-adapter-matrix");
let adapterModule: Promise<MatrixAdapterModule> | null = null;

/** Load the Beeper adapter after installing its narrowly-scoped Node ESM compatibility hook. */
export function loadMatrixAdapter(): Promise<MatrixAdapterModule> {
  if (!adapterModule) {
    register(new URL("./matrix-sdk-resolver.js", import.meta.url));
    adapterModule = import("@beeper/chat-adapter-matrix");
  }
  return adapterModule;
}
