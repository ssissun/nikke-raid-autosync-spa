// NIKKE Portal 안내 토스트 — 직접 들어온 방문자에게 잠시 뒤 우측 하단에 띄운다 (마크업은 index.html).
// Portal 화면 안(iframe)에서 열렸으면 띄우지 않는다. '다시 보지 않기'나 링크를 누르면 이 브라우저에선 다시 안 띄운다.
// 같은 주소(ssissun.github.io) 아래 nikke-storyline과 저장 공간을 같이 쓰므로 키에 사이트 이름을 붙여 따로 기억한다.
// 버튼을 누른 횟수만 Umami 이벤트 portal-toast(action: open | never | close)로 센다 — 계정·시트 데이터는 보내지 않는다.

const STORAGE_KEY = "nikke-portal-toast:raid";
const SHOW_DELAY_MS = 3000;

type Umami = { track: (event: string, data: Record<string, string>) => void };

function track(action: "open" | "never" | "close"): void {
  (window as Window & { umami?: Umami }).umami?.track("portal-toast", { action });
}

function isDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dismissed";
  } catch {
    return false;
  }
}

function dismissForever(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "dismissed");
  } catch {
    // 저장 실패는 무시 (이번 방문에서만 닫힘)
  }
}

export function initPortalToast(): void {
  const toast = document.querySelector<HTMLElement>("[data-portal-toast]");
  if (!toast || window.self !== window.top || isDismissed()) return;

  const hide = (): void => {
    toast.hidden = true;
  };
  setTimeout(() => {
    toast.hidden = false;
  }, SHOW_DELAY_MS);

  toast.querySelector("[data-portal-toast-close]")?.addEventListener("click", () => {
    track("close");
    hide();
  });
  toast.querySelector("[data-portal-toast-never]")?.addEventListener("click", () => {
    track("never");
    dismissForever();
    hide();
  });
  toast.querySelector("[data-portal-toast-open]")?.addEventListener("click", () => {
    track("open");
    dismissForever();
    hide();
  });
}
