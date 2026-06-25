// 마지막으로 우클릭된 요소를 추적한다.
// capture 단계에서 가장 깊은 target을 기록해 두었다가, 메뉴 클릭 시 사용한다.
let lastRightClicked = null;

document.addEventListener(
  "contextmenu",
  (event) => {
    lastRightClicked = event.target;
  },
  true
);

// background.js에서 보낸 메뉴 클릭 메시지를 처리한다.
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "COPY_ELEMENT") return;

  let target = lastRightClicked;
  if (!target || target.nodeType !== Node.ELEMENT_NODE) {
    showToast("No element found. Right-click directly on an element and try again.", false);
    return;
  }

  // "부모 요소" 메뉴: 안쪽 작은 요소가 잘못 잡혔을 때 한 단계 위를 복사한다.
  if (message.action === "copy-parent-clean") {
    if (!target.parentElement || target.parentElement === document.documentElement) {
      showToast("No parent element to go up to.", false);
      return;
    }
    target = target.parentElement;
  }
  const mode = message.action === "copy-outerhtml" ? "outer" : "clean";

  let html;
  try {
    html = mode === "outer" ? target.outerHTML : cleanSerialize(target);
  } catch (err) {
    showToast("Failed to extract HTML.", false);
    return;
  }

  // 페이지 URL·고유 선택자·요소 정보를 헤더로 붙여, AI가 "어느 페이지의 어떤 요소가
  // 화면 어디에 어떻게 보이는지"까지 파악할 수 있게 한다.
  const payload = buildHeader(target) + html;

  copyToClipboard(payload)
    .then(() => {
      highlight(target); // 복사된 요소를 화면에 표시해 잘못 잡았는지 바로 확인하게 한다.
      showToast(`Copied · ${describe(target)} (${payload.length.toLocaleString()} chars)`, true);
    })
    .catch(() => {
      showToast("Failed to copy to clipboard.", false);
    });
});

// ---------------------------------------------------------------------------
// HTML 정리: AI에게 설명하기 좋게 노이즈를 줄이고 들여쓰기로 정리한다.
// ---------------------------------------------------------------------------
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);
const NOISE_TAGS = new Set(["script", "style", "noscript"]);

function cleanSerialize(root) {
  const lines = [];
  walk(root, 0, lines);
  return lines.join("\n");
}

function walk(node, depth, lines) {
  const pad = "  ".repeat(depth);

  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (text) lines.push(pad + text);
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const tag = node.tagName.toLowerCase();
  if (NOISE_TAGS.has(tag)) return; // script/style 등은 통째로 생략

  const attrs = formatAttrs(node);

  // svg 등 내부 데이터가 큰 경우는 자식을 접어둔다.
  if (tag === "svg") {
    lines.push(`${pad}<svg${attrs}>…</svg>`);
    return;
  }

  if (VOID_ELEMENTS.has(tag)) {
    lines.push(`${pad}<${tag}${attrs}>`);
    return;
  }

  const children = Array.from(node.childNodes).filter((c) => {
    if (c.nodeType === Node.TEXT_NODE) return c.textContent.trim() !== "";
    if (c.nodeType === Node.ELEMENT_NODE) {
      return !NOISE_TAGS.has(c.tagName.toLowerCase());
    }
    return false;
  });

  if (children.length === 0) {
    lines.push(`${pad}<${tag}${attrs}></${tag}>`);
    return;
  }

  // 텍스트 하나만 있는 경우는 한 줄로 합친다.
  if (children.length === 1 && children[0].nodeType === Node.TEXT_NODE) {
    const text = children[0].textContent.replace(/\s+/g, " ").trim();
    lines.push(`${pad}<${tag}${attrs}>${text}</${tag}>`);
    return;
  }

  lines.push(`${pad}<${tag}${attrs}>`);
  for (const child of children) walk(child, depth + 1, lines);
  lines.push(`${pad}</${tag}>`);
}

function formatAttrs(el) {
  const parts = [];
  for (const attr of el.attributes) {
    let value = attr.value;
    // base64 / 매우 긴 값은 잘라낸다 (구조 파악에 불필요).
    if (value.length > 100) value = value.slice(0, 97) + "…";
    parts.push(value === "" ? attr.name : `${attr.name}="${value}"`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

// ---------------------------------------------------------------------------
// 메타데이터 헤더: 페이지 URL + 고유 선택자 + 일치 개수
// ---------------------------------------------------------------------------
function buildHeader(el) {
  const selector = buildSelector(el);
  let count = -1;
  try {
    count = document.querySelectorAll(selector).length;
  } catch (_) {
    // 선택자가 유효하지 않은 드문 경우는 개수 확인을 건너뛴다.
  }
  const match =
    count === 1 ? "unique on page"
    : count > 1 ? `${count} matches on page`
    : "position unknown";

  const lines = [
    `<!-- page: ${location.href} -->`,
    `<!-- selector: ${selector} (${match}) -->`,
    `<!-- element: ${describeElement(el)} -->`,
    `<!-- position: ${describePosition(el)} -->`,
  ];
  const region = describeRegion(el);
  if (region) lines.push(`<!-- region: ${region} -->`);
  if (window.top !== window.self) {
    lines.push(`<!-- inside an iframe -->`);
  }
  return lines.join("\n") + "\n";
}

// 사람이 읽을 수 있게 짧게 자른다.
function shorten(s, max) {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// 요소의 "정체": 태그 + role + 접근성 이름(+ 링크/입력 부가정보).
function describeElement(el) {
  const tag = el.tagName.toLowerCase();
  let s = tag;
  const role = el.getAttribute("role");
  if (role) s += ` role=${role}`;

  const name = shorten(
    el.getAttribute("aria-label") ||
      el.getAttribute("alt") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.innerText ||
      el.textContent ||
      "",
    50
  );
  if (name) s += ` "${name}"`;

  const states = ariaStates(el);
  if (states) s += ` [${states}]`;

  if (tag === "a" && el.getAttribute("href")) s += ` → ${shorten(el.getAttribute("href"), 60)}`;
  if (tag === "input" || tag === "select" || tag === "textarea") {
    if (el.type) s += ` [type=${el.type}]`;
    if (el.disabled) s += " [disabled]";
    if (el.checked) s += " [checked]";
    if (el.value) s += ` value="${shorten(el.value, 30)}"`;
  }
  return s;
}

// 탭/체크박스/아코디언 등의 현재 상태(선택됨·펼쳐짐 등)를 읽는다.
function ariaStates(el) {
  const out = [];
  if (el.getAttribute("aria-selected") === "true") out.push("selected");
  const exp = el.getAttribute("aria-expanded");
  if (exp === "true") out.push("expanded");
  else if (exp === "false") out.push("collapsed");
  if (el.getAttribute("aria-checked") === "true") out.push("checked");
  const cur = el.getAttribute("aria-current");
  if (cur && cur !== "false") out.push("current");
  if (el.getAttribute("aria-disabled") === "true" || el.disabled) out.push("disabled");
  if (el.getAttribute("aria-hidden") === "true") out.push("aria-hidden");
  return out.join(", ");
}

// 요소의 화면상 위치/크기/표시 여부. "안 보인다"류 문제 파악에 쓰인다.
function describePosition(el) {
  const rect = el.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  const cs = getComputedStyle(el);

  if (w === 0 || h === 0 || cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) {
    return `${w}×${h}px · not visible (hidden or zero-size)`;
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
  const vert = cy < vh / 3 ? "top" : cy < (vh * 2) / 3 ? "middle" : "bottom";
  const horiz = cx < vw / 3 ? "left" : cx < (vw * 2) / 3 ? "center" : "right";
  const spot = vert === "middle" && horiz === "center" ? "center" : `${vert} ${horiz}`;
  const where = inViewport ? `${spot} of viewport` : "off-screen (scroll to view)";
  return `${w}×${h}px · ${where}`;
}

// 요소가 속한 시맨틱 영역(가장 가까운 랜드마크)과 그 영역의 대표 제목.
function describeRegion(el) {
  // 자기 자신(role 등)이 잡히지 않도록 부모부터 위로 올라가며 찾는다.
  const start = el.parentElement || el;
  const landmark = start.closest(
    "header,nav,main,footer,aside,section,article,form,dialog,[role]"
  );
  if (!landmark || landmark === el) return "";
  let s = landmark.tagName.toLowerCase();
  const lr = landmark.getAttribute("role");
  if (lr) s += `[role=${lr}]`;
  const heading = landmark.querySelector("h1,h2,h3,[aria-label]");
  const ht = heading
    ? shorten(heading.getAttribute("aria-label") || heading.textContent, 30)
    : "";
  return ht ? `inside <${s}> "${ht}"` : `inside <${s}>`;
}

// 빌드마다 바뀌는 해시 클래스/id 를 가려낸다.
// 예) CSS Modules(foo-module__bar___AbC12), styled-components(sc-abc123),
//     emotion(css-1a2b3c) 같은 자동 생성 식별자는 재현성이 없어 선택자에서 제외한다.
function isHashy(s) {
  if (/_{2,}[A-Za-z0-9_-]{4,}$/.test(s)) return true; // ...___AiQyW
  if (/-module__/.test(s)) return true;               // webpack CSS Modules
  if (/^sc-[A-Za-z0-9]{5,}$/.test(s)) return true;    // styled-components
  if (/^css-[a-z0-9]{5,}$/i.test(s)) return true;     // emotion
  if (/^[a-z0-9]*[0-9][a-z0-9]*$/i.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s) && s.length >= 6)
    return true; // 대소문자+숫자가 섞인 무작위 해시
  return false;
}

// 이스케이프 없이 그대로 쓸 수 있는 "깨끗한" CSS 식별자인지 본다.
// Tailwind 류(w-1/2, md:flex)처럼 / : . 등이 들어가면 CSS.escape 가 백슬래시를
// 붙여 선택자가 .w-1\/2 처럼 지저분해지므로, 그런 클래스는 선택자에서 제외한다.
function isSimpleIdent(s) {
  return /^-?[A-Za-z_][\w-]*$/.test(s);
}

// 안정적이고(해시 아님) 깨끗한(이스케이프 불필요) 클래스만 최대 2개까지 추린다.
function stableClasses(node) {
  return Array.from(node.classList)
    .filter((c) => !isHashy(c) && isSimpleIdent(c))
    .slice(0, 2);
}

// 안정적인 식별 속성(테스트용 data-*, name, aria-label 등)을 선택자로 만든다.
const STABLE_ATTRS = ["data-testid", "data-test", "data-cy", "data-qa", "name", "aria-label"];
function stableAttrSelector(node) {
  for (const a of STABLE_ATTRS) {
    const v = node.getAttribute(a);
    if (v && v.length <= 40 && /^[\w\s./:-]+$/.test(v)) return `[${a}="${v}"]`;
  }
  return "";
}

// 요소를 가리키는 고유 CSS 선택자를 만든다.
// 우선순위: 안정적인 id → 안정적인 속성 → 의미 있는 클래스, 그리고 필요 시 :nth-of-type 으로 위치 고정.
function buildSelector(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
    if (node.id && !isHashy(node.id) && !/["\\]/.test(node.id)) {
      // 깨끗한 id는 #id, 특수문자가 섞이면 백슬래시 없는 [id="..."] 표기를 쓴다.
      parts.unshift(isSimpleIdent(node.id) ? `#${node.id}` : `[id="${node.id}"]`);
      break; // 안정적인 id는 페이지 내 유일하다고 보고 경로를 종료한다.
    }

    const tag = node.tagName.toLowerCase();
    let part = tag + stableAttrSelector(node);
    if (part === tag) {
      const cls = stableClasses(node);
      if (cls.length) part += "." + cls.join(".");
    }

    // 같은 부모 안에서 위 선택자가 형제와 겹치면 위치 번호를 붙인다.
    const parent = node.parentElement;
    if (parent) {
      let twins;
      try {
        twins = Array.from(parent.children).filter((c) => c.matches(part));
      } catch (_) {
        twins = [];
      }
      if (twins.length !== 1) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ") || el.tagName.toLowerCase();
}

// 토스트에 표시할 간단한 요소 설명 (예: div.card#main)
function describe(el) {
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  if (el.classList.length) s += "." + Array.from(el.classList).slice(0, 2).join(".");
  return s;
}

// ---------------------------------------------------------------------------
// 클립보드 복사 (navigator.clipboard 우선, 실패 시 execCommand fallback)
// ---------------------------------------------------------------------------
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (_) {
    // 일부 컨텍스트에서 막히면 execCommand로 대체한다.
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.top = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  if (!ok) throw new Error("execCommand copy failed");
}

// ---------------------------------------------------------------------------
// 복사된 요소를 화면에 잠깐 표시한다. (잘못 잡았는지 눈으로 바로 확인)
// ---------------------------------------------------------------------------
function highlight(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return; // 보이지 않는 요소는 표시 생략
  const box = document.createElement("div");
  box.style.cssText = [
    "position:fixed",
    `left:${rect.left}px`,
    `top:${rect.top}px`,
    `width:${rect.width}px`,
    `height:${rect.height}px`,
    "border:2px solid #16a34a",
    "background:rgba(22,163,74,.12)",
    "border-radius:2px",
    "box-sizing:border-box",
    "z-index:2147483646",
    "pointer-events:none",
    "transition:opacity .3s",
  ].join(";");
  document.documentElement.appendChild(box);
  setTimeout(() => (box.style.opacity = "0"), 650);
  setTimeout(() => box.remove(), 1000);
}

// ---------------------------------------------------------------------------
// 화면 우측 하단 토스트 알림
// ---------------------------------------------------------------------------
let toastEl = null;
let toastTimer = null;

function showToast(text, success) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "max-width:360px",
      "padding:10px 14px",
      "border-radius:8px",
      "font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "color:#fff",
      "box-shadow:0 4px 16px rgba(0,0,0,.25)",
      "pointer-events:none",
      "transition:opacity .2s",
    ].join(";");
    document.documentElement.appendChild(toastEl);
  }
  toastEl.style.background = success ? "#16a34a" : "#dc2626";
  toastEl.textContent = text;
  toastEl.style.opacity = "1";

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (toastEl) toastEl.style.opacity = "0";
  }, 2200);
}
