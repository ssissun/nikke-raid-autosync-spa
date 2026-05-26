// F-NRA-002-04 공개 API — main.ts에서 initMessageListener 호출.

import type { NikkeRaidPayload } from "../types";
import { handleMessage } from "./handler";

let lastPayload: NikkeRaidPayload | null = null;
let initialized = false;

export function initMessageListener(): void {
  if (initialized) return;
  window.addEventListener("message", handleMessage);
  window.addEventListener("payloadReceived", (e) => {
    lastPayload = (e as CustomEvent).detail as NikkeRaidPayload;
  });
  initialized = true;
}

export function getLastPayload(): NikkeRaidPayload | null {
  return lastPayload;
}

export function clearPayload(): void {
  lastPayload = null;
}

export { isAllowedOrigin, validateNikkeRaidPayload } from "./validator";
