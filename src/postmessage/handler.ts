// F-NRA-002-04 postMessage handler — origin → schema → type 분기 → CustomEvent 발행.

import type { NikkeRaidPayload } from "../types";
import {
  isAllowedOrigin,
  isProgressMessage,
  validateNikkeRaidPayload,
} from "./validator";

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

  // 수집 진행 메시지는 payload 검증 경로 진입 전에 가로채 별도 이벤트로 발행한다 (정상 payload 흐름 무영향).
  if (isProgressMessage(data)) {
    window.dispatchEvent(new CustomEvent("nraProgressUpdated", { detail: data }));
    return;
  }

  if (!validateNikkeRaidPayload(data)) {
    console.warn("[NRA-SPA] postMessage: payload schema 실패", data);
    window.dispatchEvent(
      new CustomEvent("payloadValidationFailed", { detail: data })
    );
    return;
  }

  const payload: NikkeRaidPayload = data;

  // 유저스크립트 버전 감지 — 모든 유효 메시지에 piggyback 된 scriptVersion 추출 (구버전은 없음 → null).
  const sv = (payload as { scriptVersion?: unknown }).scriptVersion;
  window.dispatchEvent(
    new CustomEvent("userscriptVersionDetected", {
      detail: { version: typeof sv === "string" ? sv : null },
    })
  );

  switch (payload.type) {
    case "nikke-raid-data":
    case "nikke-raid-multi":
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
