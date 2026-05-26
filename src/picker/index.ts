// Google Picker — drive.file scope 요건 충족 (사용자 명시 선택한 시트만 접근 가능).
// gapi.load + ViewId.SPREADSHEETS 단일 선택 패턴.
// setDeveloperKey + setAppId 필수 — 누락 시 Picker UI는 작동하나 drive.file
// server-side 등록이 불완전하여 후속 Sheets API call이 404 떨어짐.

import { GOOGLE_API_KEY, GOOGLE_PROJECT_NUMBER } from "../config";
import { saveSheetSelection } from "../storage";

declare global {
  interface Window {
    gapi?: {
      load: (lib: string, callback: () => void) => void;
    };
  }
}

let pickerLoaded = false;

export function initPicker(): Promise<void> {
  if (pickerLoaded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (typeof window.gapi === "undefined") {
      reject(new Error("gapi SDK not loaded — index.html script 태그 확인"));
      return;
    }
    window.gapi.load("picker", () => {
      pickerLoaded = true;
      resolve();
    });
  });
}

export interface PickedSheet {
  id: string;
  name: string;
}

export async function openPicker(
  accessToken: string,
  onSelect: (sheet: PickedSheet) => void,
  onCancel?: () => void
): Promise<void> {
  if (accessToken.length === 0) {
    throw new Error("accessToken 비어있음 — login() 먼저 호출");
  }
  await initPicker();

  if (typeof google === "undefined" || typeof google.picker === "undefined") {
    throw new Error("google.picker namespace 미로드");
  }

  const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS);

  const picker = new google.picker.PickerBuilder()
    .setDeveloperKey(GOOGLE_API_KEY)
    .setAppId(GOOGLE_PROJECT_NUMBER)
    .setOAuthToken(accessToken)
    .addView(view)
    .setCallback((data) => {
      const action = data[google.picker.Response.ACTION];
      if (action === google.picker.Action.PICKED) {
        const docs = data[google.picker.Response.DOCUMENTS];
        if (Array.isArray(docs) && docs.length > 0) {
          const doc = docs[0];
          const id = String(doc[google.picker.Document.ID] ?? "");
          const name = String(doc[google.picker.Document.NAME] ?? "");
          if (id.length > 0) {
            saveSheetSelection(id, name);
            onSelect({ id, name });
          }
        }
      } else if (action === google.picker.Action.CANCEL) {
        onCancel?.();
      }
    })
    .build();

  picker.setVisible(true);
}
