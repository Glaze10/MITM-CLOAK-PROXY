/* The history table: rendering, selection, highlighting, and the right-click menu. */
import { $, $$, api, asCurl, copy, esc, fmtSize, MARKS, state, toast } from "./core.js";
import { showDetail } from "./detail.js";
import { addRepeaterTab } from "./repeater.js";

/* ── rendering ───────────────────────────────────────────────────────── */
function rowHtml(f) {
  const cls = [
    state.selected.has(f.id) ? "sel" : "",
    (f.intercepted || f.state === "paused") ? "paused" : "",
    f.imported ? "imported" : "",
    f.marked ? "m-" + f.marked : "",
  ].filter(Boolean).join(" ");
  const via = (f.cloak || {}).via || "";
  const tls = via === "mirror" ? "mirror" : via === "static" ? "preset" : "";
  const sc = f.status ? String(f.status)[0] : "0";
  return `<tr data-id="${f.id}" class="${cls}">
    <td>${f.marked ? `<span class="markdot mark-${f.marked}"></span>` : ""}</td>
    <td>${esc(f.method)}</td><td>${esc(f.host)}</td><td>${esc(f.path)}</td>
    <td class="status-${sc}">${f.status ?? (f.state === "paused" ? "···" : "—")}</td>
    <td>${esc(f.mime || "")}</td><td>${fmtSize(f.size)}</td>
    <td>${f.ms != null ? f.ms + " ms" : ""}</td>
    <td class="tls-${via}">${tls}</td></tr>`;
}

export function renderFlows() {
  const body = $("#rows");
  const atBottom = body.parentElement.parentElement.scrollTop + 40 >=
    body.parentElement.parentElement.scrollHeight - body.parentElement.parentElement.clientHeight;
  body.innerHTML = state.order.map((id) => rowHtml(state.flows.get(id))).filter(Boolean).join("");
  $("#histCount").textContent = state.order.length;
  const n = state.selected.size;
  $("#selInfo").textContent = n > 1 ? `${n} selected` : "";
  if (state.prefs.follow && atBottom) {
    const pane = $("#flowPane");
    pane.scrollTop = pane.scrollHeight;
  }
}

export function setFlows(rows) {
  state.flows = new Map(rows.map((r) => [r.id, r]));
  state.order = rows.map((r) => r.id);
  for (const id of [...state.selected]) if (!state.flows.has(id)) state.selected.delete(id);
  renderFlows();
}

export function upsertFlow(f) {
  const known = state.flows.has(f.id);
  state.flows.set(f.id, { ...(state.flows.get(f.id) || {}), ...f });
  if (!known) {
    state.order.push(f.id);
    const max = state.prefs.maxRows || 2000;
    while (state.order.length > max) state.flows.delete(state.order.shift());
  }
  renderFlows();
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
  renderFlows();
  if (state.selected.size === 1) showDetail([...state.selected][0]);
}

export const selectedIds = () => [...state.selected];

/* ── highlight ───────────────────────────────────────────────────────── */
export async function markSelection(colour) {
  const ids = selectedIds();
  if (!ids.length) return;
  await api("/api/mark", { method: "POST", body: { ids, colour } });
  for (const id of ids) {
    const f = state.flows.get(id);
    if (f) f.marked = colour || "";
  }
  renderFlows();
}

/* ── context menu ────────────────────────────────────────────────────── */
function closeCtx() { $("#ctx").classList.add("hidden"); }

function openCtx(x, y, id) {
  if (!state.selected.has(id)) {
    state.selected = new Set([id]);
    state.anchor = id;
    renderFlows();
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
    <button data-act="copy-url">Copy URL${n > 1 ? "s" : ""}</button>
    <button data-act="copy-curl">Copy as curl</button>
    <button data-act="export">Export ${n > 1 ? `these ${n}` : "this"} as HAR</button>
    <div class="sep"></div>
    <button data-act="select-host">Select all from this host</button>
    <button data-act="filter-host">Filter to this host</button>`;
  ctx.style.left = Math.min(x, window.innerWidth - 240) + "px";
  ctx.style.top = Math.min(y, window.innerHeight - ctx.offsetHeight - 20) + "px";
  ctx.classList.remove("hidden");
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
  } else if (act === "copy-curl") {
    const d = await api(`/api/flows/${id}`);
    copy(asCurl(d), "Copied as curl");
  } else if (act === "export") {
    window.location = `/api/har?name=cloak-selection.har&ids=${ids.join(",")}`;
  } else if (act === "select-host") {
    state.selected = new Set(state.order.filter((i) => (state.flows.get(i) || {}).host === f.host));
    renderFlows();
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
    if (e.target.matches("input, textarea, select")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      state.selected = new Set(state.order);
      renderFlows();
    }
    const n = "123456".indexOf(e.key);          // 1-6 highlight, 0 clears
    if (n > -1 && state.selected.size) markSelection(MARKS[n]);
    if (e.key === "0" && state.selected.size) markSelection("");
  });
}
