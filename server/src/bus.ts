/** Tiny in-process event bus: the keeper and webhook handler publish, the SSE endpoint subscribes. */

import { EventEmitter } from "node:events";

export type AppEvent =
  | { type: "authorization"; payload: unknown }
  | { type: "accrued"; payload: unknown }
  | { type: "settled"; payload: unknown }
  | { type: "claimed"; payload: unknown }
  | { type: "log"; payload: { level: "info" | "warn" | "error"; message: string } };

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export function publish(event: AppEvent): void {
  emitter.emit("event", { ...event, ts: Date.now() });
}

export function subscribe(fn: (e: AppEvent & { ts: number }) => void): () => void {
  emitter.on("event", fn);
  return () => emitter.off("event", fn);
}

export function log(level: "info" | "warn" | "error", message: string): void {
  const tag = level === "error" ? "ERR " : level === "warn" ? "WARN" : "INFO";
  console.log(`[${tag}] ${message}`);
  publish({ type: "log", payload: { level, message } });
}
