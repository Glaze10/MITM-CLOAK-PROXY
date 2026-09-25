/* The history table: rendering, selection, highlighting, and the right-click menu. */
import {
  $, $$, api, asCurl, asFetch, asPowerShell, asPython, asRawRequest, asRawResponse,
  asResponseBody, copy, esc, fmtSize, MARKS, state, toast,
} from "./core.js";
import { showDetail } from "./detail.js";
import { addRepeaterTab } from "./repeater.js";

/* ── rendering ───────────────────────────────────────────────────────────
   Rows are kept as live elements and patched in place. Rebuilding the table's
   innerHTML on every event — twice per request, since a request and its
   response both arrive — is what made the whole view look like it was
   reloading itself while traffic came in. */
const rowEls = new Map();          // flow id -> <tr>

const CELLS = 9;

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
  set(8, via === "mirror" ? "mirror" : via === "static" ? "preset" : "", "tls-" + via);
}

function rowFor(id) {
  let tr = rowEls.get(id);
  if (!tr) {
    tr = document.createElement("tr");
    tr.dataset.id = id;
    for (let i = 0; i < CELLS; i++) tr.appendChild(document.createElement("td"));
    rowEls.set(id, tr);
    tr.classList.add("fresh");     // a brief settle, so new traffic reads as new
    setTimeout(() => tr.classList.remove("fresh"), 700);
  }
  fillRow(tr, state.flows.get(id) || { id });
  return tr;
}

function atBottom(pane) {
  return pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 40;
}

function follow(pane, was) {
  if (state.prefs.follow && was) pane.scrollTop = pane.scrollHeight;
}

function paintCounts() {
  $("#histCount").textContent = state.order.length;
  // an empty grid looks broken; say what the proxy is waiting for instead
  $("#noFlows").classList.toggle("hidden", state.order.length > 0);
  const n = state.selected.size;
  const info = $("#selInfo");
  const text = n > 1 ? `${n} selected` : "";
  if (info.textContent !== text) info.textContent = text;
}

/** Bring the table in line with state.order, touching as little as possible. */
export function renderFlows() {
  const body = $("#rows");
  const pane = $("#flowPane");
  const was = atBottom(pane);
  for (const id of rowEls.keys()) if (!state.flows.has(id)) rowEls.delete(id);
  let i = 0;
  for (const id of state.order) {
    const want = rowFor(id);
    if (body.children[i] !== want) body.insertBefore(want, body.children[i] || null);
    i++;
  }
  while (body.children.length > state.order.length) body.lastChild.remove();
  paintCounts();
  follow(pane, was);
}

/** Re-style only the rows whose selection or highlight changed. */
export function repaintRows(ids) {
  for (const id of ids || state.order) {
    const tr = rowEls.get(id), f = state.flows.get(id);
    if (tr && f) fillRow(tr, f);
  }
  paintCounts();
}

export function setFlows(rows) {
  state.flows = new Map(rows.map((r) => [r.id, r]));
  state.order = rows.map((r) => r.id);
  for (const id of [...state.selected]) if (!state.flows.has(id)) state.selected.delete(id);
  renderFlows();
}

export function upsertFlow(f) {
  const known = state.flows.has(f.id);
  const merged = { ...(state.flows.get(f.id) || {}), ...f };
  state.flows.set(f.id, merged);
  const body = $("#rows"), pane = $("#flowPane");
  const was = atBottom(pane);
  if (known) {
    const tr = rowEls.get(f.id);
    if (tr) fillRow(tr, merged);
    else renderFlows();
  } else {
    state.order.push(f.id);
    body.appendChild(rowFor(f.id));
    const max = state.prefs.maxRows || 2000;
    while (state.order.length > max) {
      const gone = state.order.shift();
      state.flows.delete(gone);
      rowEls.get(gone)?.remove();
      rowEls.delete(gone);
    }
    paintCounts();
  }
  follow(pane, was);
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
  await api("/api/mark", { method: "POST", body: { ids, colour } });
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
  if (act === "repeater") {
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

/* ── wiring ──────────────────────────────────────────────────────────── */
export function initFlows() {
  $("#rows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) selectRow(tr.dataset.id, e);
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
