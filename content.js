// The toolbar icon, keyboard shortcut, and right-click menu all enter the same
// devtools-like "inspect/pick" mode, driven from background.js.
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "ENTER_PICK_MODE") return;
  enterPickMode(message.shortcut);
});

// Copy the picked element's metadata header (page/selector/element/position) to the clipboard —
// just enough to point an AI at *which* element it is, without dumping its markup.
function copyElement(target) {
  const payload = buildHeader(target).trimEnd() + "\n\n";

  copyToClipboard(payload)
    .then(() => {
      highlight(target); // Highlight the copied element so the user can immediately see if the wrong one was picked.
      showToast(`Copied · ${describe(target)} (${payload.length.toLocaleString()} chars)`, true, payload);
    })
    .catch(() => {
      showToast("Failed to copy to clipboard.", false);
    });
}

// ---------------------------------------------------------------------------
// Pick mode: hover to highlight any element, click to copy it (like devtools "inspect").
// ---------------------------------------------------------------------------
let pickModeActive = false;
let pickOverlay = null;
let pickLabel = null;
let pickHovered = null;

function enterPickMode(shortcut) {
  if (pickModeActive) {
    exitPickMode();
    return;
  }
  pickModeActive = true;

  // A blue overlay box that follows the hovered element, plus a small label describing it.
  pickOverlay = document.createElement("div");
  pickOverlay.style.cssText = [
    "position:fixed",
    "z-index:2147483646",
    "border:2px solid #2563eb",
    "background:rgba(37,99,235,.12)",
    "border-radius:2px",
    "box-sizing:border-box",
    "pointer-events:none",
    "display:none",
  ].join(";");

  pickLabel = document.createElement("div");
  pickLabel.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "padding:3px 7px",
    "border-radius:4px",
    "background:#2563eb",
    "color:#fff",
    "font:12px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',monospace",
    "white-space:nowrap",
    "pointer-events:none",
    "box-shadow:0 2px 8px rgba(0,0,0,.25)",
    "display:none",
  ].join(";");

  document.documentElement.appendChild(pickOverlay);
  document.documentElement.appendChild(pickLabel);

  document.addEventListener("mousemove", onPickMove, true);
  document.addEventListener("click", onPickClick, true);
  document.addEventListener("keydown", onPickKey, true);
  document.addEventListener("scroll", onPickScroll, true);

  const hint = shortcut ? ` · toggle with ${shortcut}` : "";
  showToast(`Pick mode: hover an element and click to copy · Esc to cancel${hint}`, true);
}

function exitPickMode() {
  pickModeActive = false;
  pickHovered = null;
  document.removeEventListener("mousemove", onPickMove, true);
  document.removeEventListener("click", onPickClick, true);
  document.removeEventListener("keydown", onPickKey, true);
  document.removeEventListener("scroll", onPickScroll, true);
  if (pickOverlay) pickOverlay.remove();
  if (pickLabel) pickLabel.remove();
  pickOverlay = null;
  pickLabel = null;
}

function onPickMove(event) {
  const el = event.target;
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
  if (el === pickOverlay || el === pickLabel) return;
  pickHovered = el;
  drawPickOverlay(el);
}

// Keep the overlay aligned while the page scrolls under a still mouse.
function onPickScroll() {
  if (pickHovered) drawPickOverlay(pickHovered);
}

function drawPickOverlay(el) {
  const rect = el.getBoundingClientRect();
  pickOverlay.style.display = "block";
  pickOverlay.style.left = rect.left + "px";
  pickOverlay.style.top = rect.top + "px";
  pickOverlay.style.width = rect.width + "px";
  pickOverlay.style.height = rect.height + "px";

  pickLabel.textContent = `${describe(el)} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
  pickLabel.style.display = "block";
  // Place the label just above the box; flip below if there's no room at the top.
  const labelTop = rect.top - 24 < 0 ? rect.top + 4 : rect.top - 24;
  pickLabel.style.left = Math.max(0, rect.left) + "px";
  pickLabel.style.top = labelTop + "px";
}

function onPickClick(event) {
  if (!pickModeActive) return;
  // Swallow the click so the page itself doesn't react (no navigation, no button press).
  event.preventDefault();
  event.stopPropagation();
  const target = pickHovered || event.target;
  exitPickMode();
  if (target && target.nodeType === Node.ELEMENT_NODE) {
    copyElement(target);
  }
}

function onPickKey(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    exitPickMode();
    showToast("Pick mode cancelled.", false);
  }
}

// ---------------------------------------------------------------------------
// Metadata header: page URL + unique selector + match count
// ---------------------------------------------------------------------------
function buildHeader(el) {
  const selector = buildSelector(el);
  let count = -1;
  try {
    count = document.querySelectorAll(selector).length;
  } catch (_) {
    // Skip the count check in the rare case the selector is invalid.
  }
  const match =
    count === 1 ? "unique on page"
    : count > 1 ? `${count} matches on page`
    : "position unknown";

  const lines = [
    `<!-- AI UI-debugging reference for the element below. -->`,
    `<!-- page: ${location.href} -->`,
    `<!-- selector: ${selector} (${match}) -->`,
    `<!-- element: ${describeElement(el)} -->`,
  ];

  const cls = elementClasses(el);
  if (cls) lines.push(`<!-- class: ${cls} -->`);

  lines.push(`<!-- size: ${describeSize(el)} · viewport ${describeViewport()} -->`);

  for (const styleLine of describeStyles(el)) lines.push(styleLine);

  const region = describeRegion(el);
  if (region) lines.push(`<!-- region: ${region} -->`);

  const vis = describeVisibility(el);
  if (vis) lines.push(`<!-- ⚠ ${vis} -->`);

  if (window.top !== window.self) {
    lines.push(`<!-- inside an iframe -->`);
  }
  return lines.join("\n") + "\n";
}

// Trim to a short, human-readable length.
function shorten(s, max) {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Text to use as the element's name. For container-like elements (several child elements),
// innerText would just concatenate all descendants into noise, so skip it — leaf-ish elements
// (buttons, links, labels) keep their text since that text *is* their identity.
function nameText(el) {
  if (el.childElementCount > 2) return "";
  return el.innerText || el.textContent || "";
}

// The element's "identity": tag + role + accessible name (+ link/input extras).
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
      nameText(el),
    40
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

// Read the current state (selected, expanded, etc.) of tabs/checkboxes/accordions and the like.
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

// The element's rendered size in CSS pixels (independent of scroll position).
function describeSize(el) {
  const rect = el.getBoundingClientRect();
  return `${Math.round(rect.width)}×${Math.round(rect.height)}px`;
}

// The viewing context that makes size/visibility meaningful: screen size + form factor.
// (A desktop vs phone layout differ, so the element's size means little without it.)
function describeViewport() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const ua = navigator.userAgentData;
  const mobile =
    ua && typeof ua.mobile === "boolean"
      ? ua.mobile
      : /Mobi|Android|iPhone|iPod/i.test(navigator.userAgent);
  return `${w}×${h} ${mobile ? "mobile" : "desktop"}`;
}

// A visibility *warning* — returns "" when the element renders normally (no noise), and a concrete
// reason only when it's hidden or off-screen. This is the part of "position" that actually helps debug.
function describeVisibility(el) {
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const reasons = [];
  if (cs.display === "none") reasons.push("display:none");
  if (cs.visibility === "hidden") reasons.push("visibility:hidden");
  if (Number(cs.opacity) === 0) reasons.push("opacity:0");
  if (rect.width === 0 || rect.height === 0) reasons.push(`${Math.round(rect.width)}×${Math.round(rect.height)} size`);
  if (reasons.length) return `not visible (${reasons.join(", ")})`;

  const inViewport =
    rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  return inViewport ? "" : "off-screen (scroll into view)";
}

// The key computed styles for UI debugging. Defaults and zero values are skipped so only meaningful
// signal remains. Returns an array of comment lines (some sections omitted when not relevant).
function describeStyles(el) {
  const cs = getComputedStyle(el);
  const lines = [];

  // Layout: display, plus flex/grid alignment and overflow when they apply.
  let layout = `display:${cs.display}`;
  if (cs.display.includes("flex")) {
    layout += `; dir:${cs.flexDirection}`;
    if (cs.flexWrap !== "nowrap") layout += `; wrap:${cs.flexWrap}`;
    if (cs.justifyContent && cs.justifyContent !== "normal") layout += `; justify:${cs.justifyContent}`;
    if (cs.alignItems && cs.alignItems !== "normal") layout += `; align:${cs.alignItems}`;
    if (parseFloat(cs.gap)) layout += `; gap:${cs.gap}`;
  } else if (cs.display.includes("grid")) {
    if (cs.gridTemplateColumns && cs.gridTemplateColumns !== "none") layout += `; cols:${cs.gridTemplateColumns}`;
    if (parseFloat(cs.gap)) layout += `; gap:${cs.gap}`;
  }
  if (cs.overflow !== "visible") layout += `; overflow:${cs.overflow}`;
  lines.push(`<!-- layout: ${layout} -->`);

  // Box model: only the non-zero parts.
  const box = [];
  const pad = boxShorthand(cs, "padding");
  if (pad) box.push(`padding:${pad}`);
  const mar = boxShorthand(cs, "margin");
  if (mar) box.push(`margin:${mar}`);
  if (parseFloat(cs.borderTopWidth) || parseFloat(cs.borderRightWidth) ||
      parseFloat(cs.borderBottomWidth) || parseFloat(cs.borderLeftWidth)) {
    box.push(`border:${cs.borderTopWidth} ${cs.borderTopStyle} ${colorHex(cs.borderTopColor)}`);
  }
  if (cs.borderRadius && cs.borderRadius !== "0px") box.push(`radius:${cs.borderRadius}`);
  if (box.length) lines.push(`<!-- box: ${box.join("; ")} -->`);

  // Typography (always relevant for UI).
  lines.push(
    `<!-- text: ${cs.fontSize}/${cs.lineHeight} ${fontShort(cs.fontFamily)}; weight:${cs.fontWeight}; color:${colorHex(cs.color)} -->`
  );

  // Visual: background, opacity, shadow — only when set.
  const visual = [];
  if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") {
    visual.push(`background:${colorHex(cs.backgroundColor)}`);
  }
  if (cs.backgroundImage && cs.backgroundImage !== "none") visual.push("background-image");
  if (cs.opacity !== "1") visual.push(`opacity:${cs.opacity}`);
  if (cs.boxShadow && cs.boxShadow !== "none") visual.push("box-shadow");
  if (visual.length) lines.push(`<!-- visual: ${visual.join("; ")} -->`);

  // Positioning: only when not the default (static).
  if (cs.position !== "static") {
    let pos = `position:${cs.position}`;
    if (cs.zIndex !== "auto") pos += `; z-index:${cs.zIndex}`;
    const insets = ["top", "right", "bottom", "left"]
      .filter((s) => cs[s] !== "auto")
      .map((s) => `${s}:${cs[s]}`);
    if (insets.length) pos += `; ${insets.join("; ")}`;
    lines.push(`<!-- positioning: ${pos} -->`);
  }

  return lines;
}

// Collapse top/right/bottom/left into CSS shorthand; "" when all zero.
function boxShorthand(cs, prop) {
  const t = cs[prop + "Top"], r = cs[prop + "Right"], b = cs[prop + "Bottom"], l = cs[prop + "Left"];
  if (t === "0px" && r === "0px" && b === "0px" && l === "0px") return "";
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  return `${t} ${r} ${b} ${l}`;
}

// "rgb(145, 152, 161)" → "#9198a1"; keep rgba() as-is when it has real transparency.
function colorHex(c) {
  const m = String(c).match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (!m) return c;
  const [, r, g, b, a] = m;
  if (a !== undefined && Number(a) < 1) return c;
  const h = (n) => Number(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// First family name only (computed font-family lists every fallback).
function fontShort(ff) {
  return String(ff).split(",")[0].trim().replace(/^["']|["']$/g, "");
}

// All classes actually applied (the selector keeps only stable ones; debugging needs the full set).
function elementClasses(el) {
  if (!el.classList || !el.classList.length) return "";
  const all = Array.from(el.classList).join(" ");
  return all.length > 200 ? all.slice(0, 199) + "…" : all;
}

// The semantic region the element belongs to (nearest landmark) and that region's representative heading.
function describeRegion(el) {
  // Search upward from the parent so the element itself (its role, etc.) is not matched.
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

// Detect hashed classes/ids that change on every build.
// e.g. auto-generated identifiers like CSS Modules (foo-module__bar___AbC12),
//     styled-components (sc-abc123), emotion (css-1a2b3c) are not reproducible, so exclude them from selectors.
function isHashy(s) {
  if (/_{2,}[A-Za-z0-9_-]{4,}$/.test(s)) return true; // ...___AiQyW
  if (/-module__/.test(s)) return true;               // webpack CSS Modules
  if (/^sc-[A-Za-z0-9]{5,}$/.test(s)) return true;    // styled-components
  if (/^css-[a-z0-9]{5,}$/i.test(s)) return true;     // emotion
  if (/^[a-z0-9]*[0-9][a-z0-9]*$/i.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s) && s.length >= 6)
    return true; // random hash mixing upper/lower case and digits
  return false;
}

// Check whether this is a "clean" CSS identifier usable as-is without escaping.
// For Tailwind-style classes (w-1/2, md:flex) containing / : . etc., CSS.escape adds
// backslashes and makes the selector ugly (e.g. .w-1\/2), so exclude such classes from selectors.
function isSimpleIdent(s) {
  return /^-?[A-Za-z_][\w-]*$/.test(s);
}

// Pick up to 2 classes that are stable (not hashed) and clean (no escaping needed).
function stableClasses(node) {
  return Array.from(node.classList)
    .filter((c) => !isHashy(c) && isSimpleIdent(c))
    .slice(0, 2);
}

// Build a selector from stable identifying attributes (test-oriented data-*, name, aria-label, etc.).
const STABLE_ATTRS = ["data-testid", "data-test", "data-cy", "data-qa", "name", "aria-label"];
function stableAttrSelector(node) {
  for (const a of STABLE_ATTRS) {
    const v = node.getAttribute(a);
    if (v && v.length <= 40 && /^[\w\s./:-]+$/.test(v)) return `[${a}="${v}"]`;
  }
  return "";
}

// Build a unique CSS selector that points to the element.
// Priority: stable id → stable attribute → meaningful classes, then :nth-of-type to pin position when needed.
function buildSelector(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
    if (node.id && !isHashy(node.id) && !/["\\]/.test(node.id)) {
      // Use #id for clean ids; for ids with special characters, use the backslash-free [id="..."] form.
      parts.unshift(isSimpleIdent(node.id) ? `#${node.id}` : `[id="${node.id}"]`);
      break; // A stable id is assumed unique on the page, so end the path here.
    }

    const tag = node.tagName.toLowerCase();
    let part = tag + stableAttrSelector(node);
    if (part === tag) {
      const cls = stableClasses(node);
      if (cls.length) part += "." + cls.join(".");
    }

    // If the selector above also matches siblings within the same parent, add a position index.
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

// A short element description for the toast (e.g. div.card#main).
function describe(el) {
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  if (el.classList.length) s += "." + Array.from(el.classList).slice(0, 2).join(".");
  return s;
}

// ---------------------------------------------------------------------------
// Copy to clipboard (prefer navigator.clipboard, fall back to execCommand on failure).
// ---------------------------------------------------------------------------
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (_) {
    // If blocked in some contexts, fall back to execCommand.
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
// Briefly highlight the copied element on screen (so you can visually confirm the right one was picked).
// ---------------------------------------------------------------------------
function highlight(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return; // skip highlighting invisible elements
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
// Toast notification at the bottom-right of the screen.
// ---------------------------------------------------------------------------
let toastEl = null;
let toastTitleEl = null;
let toastBodyEl = null;
let toastTimer = null;

// text: short status line. detail (optional): the full copied content, shown in a scrollable box below.
function showToast(text, success, detail) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "max-width:480px",
      "padding:10px 14px",
      "border-radius:8px",
      "color:#fff",
      "box-shadow:0 4px 16px rgba(0,0,0,.25)",
      "transition:opacity .2s",
    ].join(";");

    toastTitleEl = document.createElement("div");
    toastTitleEl.style.cssText = "font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

    toastBodyEl = document.createElement("pre");
    toastBodyEl.style.cssText = [
      "margin:8px 0 0",
      "max-height:40vh",
      "overflow:auto",
      "white-space:pre-wrap",
      "word-break:break-all",
      "font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace",
      "background:rgba(0,0,0,.18)",
      "padding:8px 10px",
      "border-radius:4px",
    ].join(";");

    toastEl.appendChild(toastTitleEl);
    toastEl.appendChild(toastBodyEl);
    document.documentElement.appendChild(toastEl);

    // Pause the auto-hide timer while the pointer is over the toast (so the content can be read/scrolled).
    toastEl.addEventListener("mouseenter", () => clearTimeout(toastTimer));
    toastEl.addEventListener("mouseleave", () => {
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        if (toastEl) toastEl.style.opacity = "0";
      }, 1500);
    });

    // Clicking anywhere outside the toast dismisses it right away.
    document.addEventListener(
      "click",
      (e) => {
        if (toastEl && toastEl.style.opacity === "1" && !toastEl.contains(e.target)) {
          clearTimeout(toastTimer);
          toastEl.style.opacity = "0";
        }
      },
      true
    );
  }

  toastEl.style.background = success ? "#16a34a" : "#dc2626";
  toastTitleEl.textContent = text;

  if (detail) {
    toastBodyEl.textContent = detail;
    toastBodyEl.style.display = "block";
    toastEl.style.pointerEvents = "auto"; // allow scrolling / hover-to-keep
  } else {
    toastBodyEl.style.display = "none";
    toastEl.style.pointerEvents = "none"; // plain status toast: let clicks pass through
  }
  toastEl.style.opacity = "1";

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (toastEl) toastEl.style.opacity = "0";
  }, detail ? 7000 : 2600);
}
