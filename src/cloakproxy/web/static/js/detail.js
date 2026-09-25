/* The detail area: request on the left, response on the right, both at once. */
import { $, api, copy, draggable, esc, fmtSize, pretty, state, toast } from "./core.js";
import { addRepeaterTab } from "./repeater.js";
import { setNote } from "./flows.js";

let raw = false;          // pretty vs raw, shared by both halves
let lastId = null;        // whose content the panes are currently showing

const headerTable = (pairs) =>
  `<table class="kv">${(pairs || []).map(([k, v]) =>
    `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>`;

// headers minus the cookie lines, which are shown in their own block above
const noCookies = (pairs) => (pairs || []).filter(
  ([k]) => !["cookie", "set-cookie"].includes(k.toLowerCase()));

/* Cookies get their own block above the headers. A request's Cookie header is
   often the longest line on the page and a wall of name=value pairs; pulling it
   out and splitting it makes the actual headers readable, and makes a single
   cookie easy to find. Set-Cookie on a response is treated the same way. */
function cookieRows(headers) {
  const out = [];
  for (const [k, v] of headers || []) {
    const key = k.toLowerCase();
    if (key === "cookie") {
      for (const part of String(v).split(";")) {
        const i = part.indexOf("=");
        if (i < 0) continue;
        out.push([part.slice(0, i).trim(), part.slice(i + 1).trim()]);
      }
    } else if (key === "set-cookie") {
      const pair = String(v).split(";")[0];      // the rest is attributes
      const i = pair.indexOf("=");
      if (i >= 0) out.push([pair.slice(0, i).trim(), pair.slice(i + 1).trim()]);
    }
  }
  return out;
}

function cookieBlock(headers) {
  const rows = cookieRows(headers);
  if (!rows.length) return "";
  return `<div class="cookies"><h4 class="sec">Cookies <span class="dim">${rows.length}</span></h4>` +
    `<table class="kv">${rows.map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table></div>`;
}

function bodyBlock(b, mime) {
  if (!b || !b.text) return `<p class="empty">No body.</p>`;
  const note = b.encoding === "base64" ? "[binary — base64]\n" : "";
  const text = b.encoding === "base64" ? b.text : pretty(b.text, mime, state.prefs.pretty && !raw);
  const size = b.size ? ` (${fmtSize(b.size)}${b.truncated ? ", truncated" : ""})` : "";
  return `<h4 class="sec">Body${size}</h4><pre>${esc(note + text)}</pre>`;
}

function rawRequest(d) {
  const lines = [`${d.request.method} ${d.request.url} ${d.request.http_version}`];
  for (const [k, v] of d.request.headers || []) lines.push(`${k}: ${v}`);
  return lines.join("\n") + "\n\n" + ((d.request.body || {}).text || "");
}

function rawResponse(d) {
  if (!d.response) return d.error ? `(failed) ${d.error}` : "(no response)";
  const lines = [`${d.response.http_version} ${d.response.status} ${d.response.reason || ""}`];
  for (const [k, v] of d.response.headers || []) lines.push(`${k}: ${v}`);
  return lines.join("\n") + "\n\n" + ((d.response.body || {}).text || "");
}

const KNOWN_BY = {
  tls: "recognised by its handshake",
  preset: "the preset in force",
  ua: "named by its own User-Agent",
  family: "inferred from its handshake",
  shape: "all its handshake gives away",
};

function cloakLine(d) {
  const c = d.cloak || {};
  if (!c.via) return "";
  const went = c.via === "mirror"
    ? "mirrored from this client's own handshake"
    : "a preset, in place of the client's";
  const knownBy = KNOWN_BY[c.label_source];
  const who = c.label
    ? `<b>${esc(c.label)}</b>${knownBy ? ` (${esc(knownBy)})` : ""}`
    : `<b>unnamed client</b>`;
  // the minted name is the precise answer, so it stays where there's room for it
  const exact = c.preset && c.preset !== c.label ? ` · ${esc(c.preset)}` : "";
  return `<p class="hint">TLS: ${who} — ${went}${exact}${
    c.upstream ? ` · ${esc(c.upstream)}` : ""}${c.ms != null ? ` · ${c.ms} ms` : ""}</p>`;
}

/** Keep the reader's place when a flow updates under them.

    A response arriving on the flow you're already reading re-renders both
    halves; without this the pane scrolls itself back to the top mid-read. */
function keepingScroll(fn) {
  const req = $("#reqBody"), res = $("#resBody");
  const same = state.detail && state.detail.id === lastId;
  const top = [req.scrollTop, res.scrollTop];
  fn();
  lastId = state.detail ? state.detail.id : null;
  if (same) { req.scrollTop = top[0]; res.scrollTop = top[1]; }
}

export function renderDetail() {
  keepingScroll(() => renderDetailNow());
  paintNote();
  reapplyFind();
}

/* ── the note pane ─────────────────────────────────────────────────────────
   The note is shown in full, always, beside the response — reading it should
   not mean opening an editor. It's also editable here directly, and saves as
   you go. */
function paintNote() {
  const ta = $("#noteEdit");
  if (!ta) return;
  if (document.activeElement === ta) return;    // don't clobber while typing
  ta.value = state.detail ? (state.detail.comment || "") : "";
  ta.disabled = !state.detail;
}

/* ── find within a pane ────────────────────────────────────────────────────
   A capture body can be thousands of lines; a search box under each pane finds
   text in it, counts the hits, and steps through them. It re-runs after the
   pane re-renders, so a query stays live as responses arrive. */
const finds = { reqBody: { q: "", idx: 0 }, resBody: { q: "", idx: 0 } };

function clearMarks(pane) {
  pane.querySelectorAll("mark.find").forEach((m) => m.replaceWith(
    document.createTextNode(m.textContent)));
  pane.normalize();
}

function runFind(paneId) {
  const pane = $("#" + paneId);
  const st = finds[paneId];
  clearMarks(pane);
  const count = $(`.findbar[data-find="${paneId}"] .findcount`);
  const q = st.q.toLowerCase();
  if (!q) { count.textContent = ""; return; }
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  let total = 0;
  for (const node of nodes) {
    const text = node.nodeValue, lower = text.toLowerCase();
    let i = lower.indexOf(q);
    if (i < 0) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (i >= 0) {
      if (i > last) frag.appendChild(document.createTextNode(text.slice(last, i)));
      const mk = document.createElement("mark");
      mk.className = "find";
      mk.textContent = text.slice(i, i + q.length);
      frag.appendChild(mk);
      total++;
      last = i + q.length;
      i = lower.indexOf(q, last);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  }
  if (st.idx >= total) st.idx = 0;
  highlightCurrent(paneId, total);
}

function highlightCurrent(paneId, total) {
  const pane = $("#" + paneId);
  const marks = [...pane.querySelectorAll("mark.find")];
  marks.forEach((m, i) => m.classList.toggle("current", i === finds[paneId].idx));
  $(`.findbar[data-find="${paneId}"] .findcount`).textContent = total ? `${finds[paneId].idx + 1}/${total}` : "0";
  marks[finds[paneId].idx]?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function step(paneId, dir) {
  const marks = $("#" + paneId).querySelectorAll("mark.find");
  if (!marks.length) return;
  finds[paneId].idx = (finds[paneId].idx + dir + marks.length) % marks.length;
  highlightCurrent(paneId, marks.length);
}

function reapplyFind() {
  for (const id of ["reqBody", "resBody"]) if (finds[id].q) runFind(id);
}

function initFind() {
  document.querySelectorAll(".findbar").forEach((bar) => {
    const paneId = bar.dataset.find;
    const input = bar.querySelector("input");
    input.addEventListener("input", () => { finds[paneId].q = input.value; finds[paneId].idx = 0; runFind(paneId); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); step(paneId, e.shiftKey ? -1 : 1); }
      if (e.key === "Escape") { input.value = ""; finds[paneId].q = ""; runFind(paneId); }
    });
    bar.querySelector("[data-find-next]").onclick = () => step(paneId, 1);
    bar.querySelector("[data-find-prev]").onclick = () => step(paneId, -1);
  });
}

function renderDetailNow() {
  const d = state.detail;
  if (!d) {
    $("#reqBody").innerHTML = `<p class="empty">Pick a flow.</p>`;
    $("#resBody").innerHTML = `<p class="empty">—</p>`;
    return;
  }
  if (raw) {
    $("#reqBody").innerHTML = `<pre>${esc(rawRequest(d))}</pre>`;
    $("#resBody").innerHTML = `<pre>${esc(rawResponse(d))}</pre>`;
    return;
  }
  const reqMime = (d.request.headers || []).find(([k]) => k.toLowerCase() === "content-type")?.[1] || "";
  $("#reqBody").innerHTML = `
    <div class="statusline">${esc(d.request.method)} <span class="url">${esc(d.request.url)}</span></div>
    ${cloakLine(d)}
    ${cookieBlock(d.request.headers)}
    <h4 class="sec">Headers</h4>${headerTable(noCookies(d.request.headers))}
    ${bodyBlock(d.request.body, reqMime)}`;

  if (!d.response) {
    $("#resBody").innerHTML = `<p class="empty">${
      d.error ? "Failed: " + esc(d.error)
      : (d.state === "paused" || d.intercepted) ? "Parked — forward it to get a response."
      : "Waiting for a response…"}</p>`;
    return;
  }
  const resMime = (d.response.headers || []).find(([k]) => k.toLowerCase() === "content-type")?.[1] || "";
  $("#resBody").innerHTML = `
    <div class="statusline status-${String(d.response.status)[0]}">${d.response.status} ${
      esc(d.response.reason || "")}</div>
    ${cookieBlock(d.response.headers)}
    <h4 class="sec">Headers</h4>${headerTable(noCookies(d.response.headers))}
    ${bodyBlock(d.response.body, resMime)}`;
}

export async function showDetail(id) {
  state.detail = await api(`/api/flows/${id}`);
  renderDetail();
}

export function initDetail() {
  draggable($("#gutterH"), $("#flowPane"), "y");
  draggable($("#gutterV"), $("#reqHalf"), "x");
  draggable($("#gutterN"), $("#noteHalf"), "x", true);   // note pane is right of its gutter
  initFind();

  // the note pane can be closed to give the request/response the full width;
  // the choice is remembered, and a "Note" button in the response bar brings
  // it back
  const setNotePane = (open) => {
    $("#noteHalf").classList.toggle("hidden", !open);
    $("#gutterN").classList.toggle("hidden", !open);
    $("#btnNoteShow").classList.toggle("hidden", open);
    try { localStorage.setItem("cloak.notePane", open ? "1" : "0"); } catch { /* ignore */ }
  };
  let noteOpen = true;
  try { noteOpen = localStorage.getItem("cloak.notePane") !== "0"; } catch { /* ignore */ }
  setNotePane(noteOpen);
  $("#btnNoteClose").onclick = () => setNotePane(false);
  $("#btnNoteShow").onclick = () => setNotePane(true);

  // edit the note in place; save shortly after you stop typing
  let noteTimer = null;
  $("#noteEdit").addEventListener("input", () => {
    if (!state.detail) return;
    clearTimeout(noteTimer);
    const id = state.detail.id, text = $("#noteEdit").value;
    noteTimer = setTimeout(() => setNote([id], text), 500);
  });

  document.querySelectorAll("[data-view-mode]").forEach((b) => {
    b.onclick = () => {
      raw = b.dataset.viewMode === "raw";
      document.querySelectorAll("[data-view-mode]").forEach((x) =>
        x.classList.toggle("on", x.dataset.viewMode === b.dataset.viewMode));
      renderDetail();
    };
  });
  document.querySelector('[data-view-mode="pretty"]').classList.add("on");

  document.querySelectorAll("[data-copy]").forEach((b) => {
    b.onclick = () => {
      if (!state.detail) return;
      copy(b.dataset.copy === "request" ? rawRequest(state.detail) : rawResponse(state.detail),
           `Copied ${b.dataset.copy}`);
    };
  });

  $("#btnToRepeater").onclick = () => {
    if (!state.detail) return toast("Pick a flow first", true);
    addRepeaterTab(state.detail.id);
  };
}
