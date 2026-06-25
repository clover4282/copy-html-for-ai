// 우클릭 메뉴를 "AI용 HTML 복사" 하위의 서브메뉴로 구성한다.
const ROOT_ID = "ai-copy-root";
const MENU_ITEMS = [
  { id: "copy-clean", title: "This element (cleaned up)" },
  { id: "copy-outerhtml", title: "This element (raw outerHTML)" },
  { id: "copy-parent-clean", title: "Parent element (one level up)" },
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: ROOT_ID,
      title: "Copy HTML for AI",
      contexts: ["all"],
    });
    for (const item of MENU_ITEMS) {
      chrome.contextMenus.create({
        id: item.id,
        parentId: ROOT_ID,
        title: item.title,
        contexts: ["all"],
      });
    }
  });
});

// 메뉴 클릭 → 우클릭이 일어난 프레임의 content script로 메시지 전달.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  chrome.tabs.sendMessage(
    tab.id,
    { type: "COPY_ELEMENT", action: info.menuItemId },
    { frameId: info.frameId ?? 0 },
    () => {
      // sendMessage 콜백에서 lastError를 읽어 콘솔 경고를 막는다.
      void chrome.runtime.lastError;
    }
  );
});
