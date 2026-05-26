// F-NRA-002-04 postMessage handler — origin → schema → type 분기 → CustomEvent 발행.

import type { NikkeRaidPayload } from "../types";
import { isAllowedOrigin, validateNikkeRaidPayload } from "./validator";

export function handleMessage(event: MessageEvent): void {
  if (!isAllowedOrigin(event.origin)) {
    console.warn(`[NRA-SPA] postMessage: blocked origin ${event.origin}`);
    return;
  }

  let data: unknown = event.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      console.warn("[NRA-SPA] postMessage: JSON.parse 실패");
      return;
    }
  }

  if (!validateNikkeRaidPayload(data)) {
    console.warn("[NRA-SPA] postMessage: payload schema 실패", data);
    window.dispatchEvent(
      new CustomEvent("payloadValidationFailed", { detail: data })
    );
    return;
  }

  const payload: NikkeRaidPayload = data;
  switch (payload.type) {
    case "nikke-raid-data":
      window.dispatchEvent(new CustomEvent("payloadReceived", { detail: payload }));
      break;
    case "need-login":
      window.dispatchEvent(new CustomEvent("payloadNeedLogin", { detail: payload }));
      break;
    case "no-data":
      window.dispatchEvent(new CustomEvent("payloadNoData", { detail: payload }));
      break;
    case "error":
      window.dispatchEvent(new CustomEvent("payloadError", { detail: payload }));
      break;
    default:
      console.warn("[NRA-SPA] postMessage: unknown type");
      return;
  }
}
