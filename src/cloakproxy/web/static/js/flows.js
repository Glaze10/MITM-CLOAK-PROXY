/* The history table: rendering, selection, highlighting, and the right-click menu. */
import {
  $, $$, api, asCurl, asFetch, asPowerShell, asPython, asRawRequest, asRawResponse,
  asResponseBody, askText, copy, esc, fmtSize, MARKS, state, toast,
} from "./core.js";
import { showDetail } from "./detail.js";
import { addRepeaterTab } from "./repeater.js";
import { markDirty } from "./save.js";

/* ── rendering ─────────────────────────────────────────────────────────── */
const CELLS = 10;

function rowClass(f) {
  return [
    state.selected.has(f.id) ? "sel" : "",
    (f.intercepted || f.state === "paused") ? "paused" : "",
    f.imported ? "imported" : "",
    f.marked ? "m-" + f.marked : "",
  ].filter(Boolean).join(" ");
}

function fillRow(tr, f) {
  const td = tr.children;
  const cls = rowClass(f);
  if (tr.className !== cls) tr.className = cls;
  const dot = f.marked ? `<span class="markdot mark-${f.marked}"></span>` : "";
  if (td[0].dataset.mark !== (f.marked || "")) {
    td[0].innerHTML = dot;
    td[0].dataset.mark = f.marked || "";
  }
  const via = (f.cloak || {}).via || "";
  const set = (i, text, cls2) => {
    if (td[i].textContent !== text) td[i].textContent = text;
    if (cls2 !== undefined && td[i].className !== cls2) td[i].className = cls2;
  };
  set(1, f.method || "");
  set(2, f.host || "");
  set(3, f.path || "");
  set(4, String(f.status ?? (f.state === "paused" ? "···" : "—")),
      "status-" + (f.status ? String(f.status)[0] : "0"));
  set(5, f.mime || "");
  set(6, fmtSize(f.size));
  set(7, f.ms != null ? f.ms + " ms" : "");
  // The column names which client this is, not the digest of its handshake.
  // How firmly it's known varies, and the styling says so: a preset match is
  // certain, a self-reported library is probably right, a family is an
  // inference from the bytes.
  const cloak = f.cloak || {};
  set(8, cloak.label || "", "tls-" + via + (cloak.label_source
    ? " src-" + cloak.label_source : ""));
  if (td[8].title !== tlsTitle(cloak)) td[8].title = tlsTitle(cloak);
  // a note the user wrote, kept on the flow's comment field
  const note = f.comment || "";
  if (td[9].textContent !== note) td[9].textContent = note;
  if (td[9].title !== note) td[9].title = note;
  td[9].className = note ? "has-note" : "";
}

const HOW = {
  tls: "recognised by its TLS handshake",
  preset: "the preset every connection is presenting",
  ua: "named by its own User-Agent; its TLS stack isn't one Cloak recognises",
  family: "inferred from its TLS handshake — the stack family, not the product",
  shape: "all its handshake gives away; the stack isn't one Cloak can name",
};

function tlsTitle(cloak) {
  if (!cloak.preset) return "";
  const how = HOW[cloak.label_source] || "";
  const went = cloak.via === "mirror"
    ? "Mirrored: this client's own handshake went upstream."
    : "A preset went upstream in place of the client's own handshake.";
  return `${cloak.label || "unnamed"}${how ? ` — ${how}` : ""}
${went}` +
         `
${cloak.preset}${cloak.upstream ? ` · ${cloak.upstream}` : ""}`;
}

/** Remember what the newest connection used, for the title bar. */
function noteIdentity(cloak) {
  if (!cloak.preset || !cloak.via) return;
  const last = state.lastTls;
  if (last && last.preset === cloak.preset && last.via === cloak.via) return;
  state.lastTls = { preset: cloak.preset, via: cloak.via, label: cloak.label || "",
                    source: cloak.label_source || "" };
  // settings.js owns the title bar; an event keeps the two from importing
  // each other in a circle
  document.dispatchEvent(new CustomEvent("cloak:identity"));
}

/* ── virtual scrolling ─────────────────────────────────────────────────────
   A full capture is thousands of requests, and a row is ten cells; putting all
   of them in the DOM at once (11k nodes for 1000 flows) is what made the window
   freeze on a loaded project. Only the rows on screen are ever rendered. The
   rest is height: two spacer rows stand in for everything above and below the
   window, so the scrollbar and scroll position stay honest. */
const rowEls = new Map();          // id -> <tr>, only for rows near the viewport
let ROW_H = 24;                    // measured after the first real row exists
let spacerTop, spacerBottom;
let freshId = null;                // the one row that just arrived live
let scheduled = false;

function ensureSpacers() {
  const body = $("#rows");
  if (!spacerTop || spacerTop.parentNode !== body) {
    body.innerHTML = "";
    const mk = () => {
      const tr = document.createElement("tr");
      tr.className = "spacer";
      const td = document.createElement("td");
      td.colSpan = CELLS; td.style.padding = "0"; td.style.border = "0";
      tr.appendChild(td);
      return tr;
    };
    spacerTop = mk(); spacerBottom = mk();
    body.appendChild(spacerTop); body.appendChild(spacerBottom);
  }
}

function rowFor(id) {
  let tr = rowEls.get(id);
  if (!tr) {
    tr = document.createElement("tr");
    tr.dataset.id = id;
    for (let i = 0; i < CELLS; i++) tr.appendChild(document.createElement("td"));
    rowEls.set(id, tr);
  }
  fillRow(tr, state.flows.get(id) || { id });
  tr.classList.toggle("fresh", id === freshId);
  return tr;
}

function atBottom(pane) {
  return pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 40;
}

function paintCounts() {
  $("#histCount").textContent = state.order.length;
  $("#noFlows").classList.toggle("hidden", state.order.length > 0);
  const n = state.selected.size;
  const info = $("#selInfo");
  const text = n > 1 ? `${n} selected` : "";
  if (info.textContent !== text) info.textContent = text;
}

/** Render only the slice of rows visible in the pane, with spacers for the rest. */
let lastStart = -1, lastEnd = -1, lastTotal = -1;

function paint(force) {
  scheduled = false;
  const body = $("#rows");
  const pane = $("#flowPane");
  ensureSpacers();
  const total = state.order.length;

  const view = pane.clientHeight || 400;
  const buffer = 10;                                   // rows above/below, for smooth scroll
  let start = Math.max(0, Math.floor(pane.scrollTop / ROW_H) - buffer);
  let count = Math.ceil(view / ROW_H) + buffer * 2;
  let end = Math.min(total, start + count);
  if (end <= start) { start = 0; end = Math.min(total, count); }

  // The common case while scrolling is that the visible window hasn't actually
  // moved by a whole row — do nothing then, rather than tear down and rebuild
  // the same rows every frame.
  if (!force && start === lastStart && end === lastEnd && total === lastTotal) {
    paintCounts();
    return;
  }
  lastStart = start; lastEnd = end; lastTotal = total;

  // clear the current visible rows (keep spacers), then lay out the slice
  for (const tr of [...body.children]) if (!tr.classList.contains("spacer")) tr.remove();
  spacerTop.firstChild.style.height = (start * ROW_H) + "px";
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) frag.appendChild(rowFor(state.order[i]));
  body.insertBefore(frag, spacerBottom);
  spacerBottom.firstChild.style.height = Math.max(0, (total - end) * ROW_H) + "px";

  // trim the element cache so it can't grow without bound on a huge capture
  if (rowEls.size > count + 200) {
    const keep = new Set(state.order.slice(start, end));
    for (const id of rowEls.keys()) if (!keep.has(id)) rowEls.delete(id);
  }

  // learn the true row height once, then correct the layout if it was off
  if (end > start) {
    const h = body.querySelector("tr[data-id]")?.offsetHeight;
    if (h && Math.abs(h - ROW_H) > 1) { ROW_H = h; schedulePaint(); }
  }
  paintCounts();
}

function schedulePaint() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(paint);
}

export function renderFlows() { paint(); }

/** Re-style rows after a selection or highlight change — just repaint the slice. */
/** Re-style the rows already on screen — for selection and highlight changes,
    which don't move the scroll window, so paint()'s skip would ignore them. */
export function repaintRows() {
  const body = $("#rows");
  for (const tr of body.children) {
    const id = tr.dataset.id;
    const f = id && state.flows.get(id);
    if (f) fillRow(tr, f);
  }
  paintCounts();
}

export function setFlows(rows) {
  state.flows = new Map(rows.map((r) => [r.id, r]));
  state.order = rows.map((r) => r.id);
  for (const id of [...state.selected]) if (!state.flows.has(id)) state.selected.delete(id);
  rowEls.clear();
  $("#flowPane").scrollTop = 0;
  paint();
}

export function upsertFlow(f) {
  const known = state.flows.has(f.id);
  const merged = { ...(state.flows.get(f.id) || {}), ...f };
  state.flows.set(f.id, merged);
  const pane = $("#flowPane");
  const was = atBottom(pane);
  if (!known) {
    state.order.push(f.id);
    freshId = f.id;
    noteIdentity(merged.cloak || {});    // title bar follows the newest connection
    markDirty();
    setTimeout(() => { if (freshId === f.id) { freshId = null; schedulePaint(); } }, 700);
    const max = state.prefs.maxRows || 2000;
    while (state.order.length > max) {
      const gone = state.order.shift();
      state.flows.delete(gone);
      rowEls.delete(gone);
    }
  }
  paint();
  if (state.prefs.follow && was) { pane.scrollTop = pane.scrollHeight; paint(); }
  if (state.detail && state.detail.id === f.id) showDetail(f.id);
}

/* ── loading ─────────────────────────────────────────────────────────── */
export async function loadFlows() {
  const spec = { ...state.filter, text: state.quick || state.filter.text || "" };
  const r = await api("/api/flows", { method: "POST", body: spec });
  setFlows(r.flows || []);
  $("#chips").innerHTML = (r.chips || []).map((c) => `<span class="chip">${esc(c)}</span>`).join("");
  $("#btnFilter").classList.toggle("on", !!r.filtered);
}

/* ── selection ───────────────────────────────────────────────────────── */
function selectRow(id, ev) {
  const before = state.selected;
  if (ev.shiftKey && state.anchor) {
    const a = state.order.indexOf(state.anchor), b = state.order.indexOf(id);
    if (a > -1 && b > -1) {
      state.selected = new Set(state.order.slice(Math.min(a, b), Math.max(a, b) + 1));
    }
  } else if (ev.ctrlKey || ev.metaKey) {
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
    state.anchor = id;
  } else {
    state.selected = new Set([id]);
    state.anchor = id;
  }
  repaintRows([...new Set([...before, ...state.selected])]);
  if (state.selected.size === 1) showDetail([...state.selected][0]);
}

export const selectedIds = () => [...state.selected];

/* ── highlight ───────────────────────────────────────────────────────── */
export async function markSelection(colour) {
  const ids = selectedIds();
  if (!ids.length) return;
  for (const id of ids) {
    const f = state.flows.get(id);
    if (f) f.marked = colour || "";
  }
  repaintRows(ids);                       // the colour lands under the cursor
  markDirty();
  await api("/api/mark", { method: "POST", body: { ids, colour } });
}

/** Write a note onto the selected flows (mitmproxy's comment field). */
export async function setNote(ids, text) {
  if (!ids.length) return;
  for (const id of ids) {
    const f = state.flows.get(id);
    if (f) f.comment = text || "";
  }
  repaintRows(ids);
  if (state.detail && ids.includes(state.detail.id)) state.detail.comment = text || "";
  markDirty();
  await api("/api/note", { method: "POST", body: { ids, text } });
}

/* ── context menu ────────────────────────────────────────────────────── */
/* Which format is wanted depends on where the request is going next, so the
   menu offers the handful that cover it rather than guessing. */
const COPY_AS = [
  ["curl", "cURL"],
  ["powershell", "PowerShell"],
  ["python", "Python requests"],
  ["fetch", "JavaScript fetch"],
  ["raw", "Raw request"],
  ["response", "Raw response"],
  ["body", "Response body"],
];

const FORMATTERS = {
  curl: asCurl, powershell: asPowerShell, python: asPython, fetch: asFetch,
  raw: asRawRequest, response: asRawResponse, body: asResponseBody,
};
function closeCtx() { $("#ctx").classList.add("hidden"); }

function openCtx(x, y, id) {
  if (!state.selected.has(id)) {
    const before = state.selected;
    state.selected = new Set([id]);
    state.anchor = id;
    repaintRows([...before, id]);
    showDetail(id);
  }
  const n = state.selected.size;
  const f = state.flows.get(id) || {};
  const parked = f.intercepted || f.state === "paused";
  const ctx = $("#ctx");
  ctx.innerHTML = `
    <div class="label">${n > 1 ? `${n} flows` : esc(f.method + " " + (f.host || ""))}</div>
    <div class="swatches">
      ${MARKS.map((c) => `<div class="swatch mark-${c}" data-mark="${c}" title="${c}"></div>`).join("")}
      <div class="swatch none" data-mark="" title="clear"></div>
    </div>
    <div class="sep"></div>
    <button data-act="note">${f.comment ? "Edit note…" : "Add note…"}</button>
    ${f.comment ? `<button data-act="note-clear">Clear note</button>` : ""}
    <div class="sep"></div>
    <button data-act="repeater">Send to Repeater</button>
    <button data-act="replay">Replay${n > 1 ? ` (${n})` : ""}</button>
    ${parked ? `<button data-act="forward">Forward</button>
                <button data-act="drop">Drop</button>` : ""}
    <div class="sep"></div>
    <div class="submenu">
      <button class="parent">Copy as<span class="arrow">›</span></button>
      <div class="ctx flyout">
        ${COPY_AS.map(([key, label]) =>
          `<button data-act="copy:${key}">${label}${n > 1 ? ` (${n})` : ""}</button>`).join("")}
      </div>
    </div>
    <button data-act="copy-url">Copy URL${n > 1 ? "s" : ""}</button>
    <button data-act="export">Export ${n > 1 ? `these ${n}` : "this"} as HAR</button>
    <div class="sep"></div>
    <button data-act="select-host">Select all from this host</button>
    <button data-act="filter-host">Filter to this host</button>`;
  ctx.style.left = Math.min(x, window.innerWidth - 240) + "px";
  ctx.style.top = Math.min(y, window.innerHeight - ctx.offsetHeight - 20) + "px";
  ctx.classList.remove("hidden");
  // open the submenu to whichever side has room for it
  ctx.classList.toggle("flip-sub", x + 240 + 178 > window.innerWidth);
}

async function runCtxAction(act, id) {
  const ids = selectedIds();
  const f = state.flows.get(id) || {};
  if (act === "note") {
    const text = await askText(
      ids.length > 1 ? `Note for ${ids.length} requests` : "Note for this request",
      f.comment || "", { multiline: true });
    if (text === null) return;                      // cancelled
    await setNote(ids, text);
  } else if (act === "note-clear") {
    await setNote(ids, "");
  } else if (act === "repeater") {
    for (const i of ids.slice(0, 5)) await addRepeaterTab(i);
  } else if (act === "replay") {
    for (const i of ids) await api(`/api/flows/${i}`, { method: "POST", body: { action: "replay" } });
    toast(`Replayed ${ids.length}`);
  } else if (act === "forward" || act === "drop") {
    for (const i of ids) await api(`/api/flows/${i}`, { method: "POST", body: { action: act === "forward" ? "resume" : "drop" } });
    toast(act === "forward" ? "Forwarded" : "Dropped");
  } else if (act === "copy-url") {
    copy(ids.map((i) => (state.flows.get(i) || {}).url).join("\n"), `Copied ${ids.length} URL(s)`);
  } else if (act.startsWith("copy:")) {
    // the row only carries a summary, so fetch the whole flow to format it
    const key = act.slice(5);
    const label = (COPY_AS.find(([k]) => k === key) || [key, key])[1];
    const full = await Promise.all(ids.slice(0, 50).map((i) => api(`/api/flows/${i}`)));
    const text = full.map(FORMATTERS[key]).filter(Boolean).join("\n\n");
    if (!text) return toast(`Nothing to copy as ${label}`, true);
    copy(text, `Copied ${ids.length > 1 ? `${ids.length} flows` : ""} as ${label}`);
  } else if (act === "export") {
    window.location = `/api/har?name=cloak-selection.har&ids=${ids.join(",")}`;
  } else if (act === "select-host") {
    state.selected = new Set(state.order.filter((i) => (state.flows.get(i) || {}).host === f.host));
    repaintRows();
  } else if (act === "filter-host") {
    state.filter = { ...state.filter, host: f.host || "" };
    await loadFlows();
  }
  closeCtx();
}

/* ── column widths ───────────────────────────────────────────────────────
   Every column but Path has a set width, and Path takes what's left — the
   path is what you scan, so it should have the room. But "what's left" is a
   guess about someone else's screen, so the header is draggable and what you
   choose is remembered.

   The drag freezes the table first. At width:100% the browser owns the
   leftover space and redistributes it as you pull, so the edge lags behind
   the pointer and then catches up — it feels like the column is resisting.
   Pinning every column and the table's total width makes the edge track the
   pointer exactly, because nothing is left for the browser to decide. */
const WIDTH_KEY = "cloak.colWidths";
const MIN_COL = 34;

function savedWidths() {
  try { return JSON.parse(localStorage.getItem(WIDTH_KEY)) || {}; }
  catch { return {}; }                      // private windows can throw on read
}

function storeWidths(map) {
  try {
    if (map) localStorage.setItem(WIDTH_KEY, JSON.stringify(map));
    else localStorage.removeItem(WIDTH_KEY);
  } catch { /* nothing to do if storage is unavailable */ }
}

const colKey = (th, i) => th.className || `col${i}`;

/** Pin every column to the width it currently has, and the table to their sum. */
function freeze(table, heads) {
  const widths = heads.map((th) => th.offsetWidth);
  heads.forEach((th, i) => { th.style.width = widths[i] + "px"; });
  const total = widths.reduce((a, b) => a + b, 0);
  table.style.width = total + "px";
  return total;
}

function initColumns() {
  const table = $("#historySplit table.flows");
  const heads = $$("#historySplit thead th");
  const saved = savedWidths();
  if (Object.keys(saved).length) {
    heads.forEach((th, i) => {
      const w = saved[colKey(th, i)];
      if (w) th.style.width = w + "px";
    });
    freeze(table, heads);                   // restore the frozen layout as a whole
  }

  heads.forEach((th, i) => {
    if (i === heads.length - 1) return;     // nothing to take space from
    const grab = document.createElement("div");
    grab.className = "colgrab";
    grab.title = "Drag to resize · double-click to reset all";
    th.appendChild(grab);

    grab.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { grab.setPointerCapture(e.pointerId); } catch { /* capture is a bonus */ }
      const startX = e.clientX;
      const startTotal = freeze(table, heads);
      const startW = th.offsetWidth;
      grab.classList.add("dragging");
      document.body.classList.add("resizing");

      let pending = 0, dx = 0;
      const apply = () => {
        pending = 0;
        const w = Math.max(MIN_COL, startW + dx);
        th.style.width = w + "px";
        table.style.width = (startTotal + (w - startW)) + "px";
      };
      const move = (ev) => {
        dx = ev.clientX - startX;
        // one update per frame: a pointer can outrun the renderer, and the
        // extra layouts are what make a drag feel heavy
        if (!pending) pending = requestAnimationFrame(apply);
      };
      const done = () => {
        if (pending) { cancelAnimationFrame(pending); apply(); }
        grab.classList.remove("dragging");
        document.body.classList.remove("resizing");
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", done, true);
        window.removeEventListener("pointercancel", done, true);
        window.removeEventListener("blur", done);
        const map = {};
        heads.forEach((h, j) => { map[colKey(h, j)] = h.offsetWidth; });
        storeWidths(map);
      };
      // Listen on the window, not the handle. Pointer capture should keep the
      // events coming, but a fast drag that outruns the renderer can still slip
      // the element, and then the column stops following the cursor — which is
      // exactly what "the cursor overcomes it" feels like.
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", done, true);
      window.addEventListener("pointercancel", done, true);
      window.addEventListener("blur", done);
    });

    grab.addEventListener("dblclick", (e) => {
      e.preventDefault();                   // back to the stylesheet's widths
      heads.forEach((h) => { h.style.width = ""; });
      table.style.width = "";
      storeWidths(null);
      toast("Columns reset");
    });
  });
}

/* ── wiring ──────────────────────────────────────────────────────────── */
export function initFlows() {
  initColumns();
  // repaint the visible slice as the pane scrolls — the heart of virtual scrolling
  $("#flowPane").addEventListener("scroll", schedulePaint, { passive: true });
  window.addEventListener("resize", schedulePaint);
  $("#rows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) selectRow(tr.dataset.id, e);
  });

  // Click-and-drag to select a range of rows. The range is computed from
  // state.order by index, so it works even across rows that virtual scrolling
  // hasn't rendered.
  let dragging = false, dragAnchor = null;
  const rangeTo = (id) => {
    const a = state.order.indexOf(dragAnchor), b = state.order.indexOf(id);
    if (a < 0 || b < 0) return;
    state.selected = new Set(state.order.slice(Math.min(a, b), Math.max(a, b) + 1));
    repaintRows();
  };
  $("#rows").addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;  // click handles those
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    dragging = true; dragAnchor = tr.dataset.id; state.anchor = dragAnchor;
    state.selected = new Set([dragAnchor]);
    repaintRows();
    e.preventDefault();                     // no text selection while dragging
  });
  $("#rows").addEventListener("mouseover", (e) => {
    if (!dragging) return;
    const tr = e.target.closest("tr[data-id]");
    if (tr) rangeTo(tr.dataset.id);
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    if (state.selected.size === 1) showDetail([...state.selected][0]);
  });

  $("#rows").addEventListener("contextmenu", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    e.preventDefault();
    openCtx(e.clientX, e.clientY, tr.dataset.id);
  });
  $("#ctx").addEventListener("click", (e) => {
    const sw = e.target.closest("[data-mark]");
    if (sw) { markSelection(sw.dataset.mark); return closeCtx(); }
    const btn = e.target.closest("button[data-act]");
    if (btn) runCtxAction(btn.dataset.act, state.anchor);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#ctx")) closeCtx();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCtx();
    // typing in a field is not a shortcut; guard the check itself, since the
    // event target isn't always an element
    if (e.target?.matches?.("input, textarea, select")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      state.selected = new Set(state.order);
      repaintRows();
    }
    const n = "123456".indexOf(e.key);          // 1-6 highlight, 0 clears
    if (n > -1 && state.selected.size) markSelection(MARKS[n]);
    if (e.key === "0" && state.selected.size) markSelection("");
  });
}
