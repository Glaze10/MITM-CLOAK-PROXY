/* The detail area: request on the left, response on the right, both at once. */
import { $, api, copy, draggable, esc, fmtSize, pretty, state, toast } from "./core.js";
import { addRepeaterTab } from "./repeater.js";

let raw = false;          // pretty vs raw, shared by both halves
let lastId = null;        // whose content the panes are currently showing

const headerTable = (pairs) =>
  `<table class="kv">${(pairs || []).map(([k, v]) =>
    `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>`;

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

function cloakLine(d) {
  const c = d.cloak || {};
  if (!c.via) return "";
  const how = c.via === "mirror"
    ? "mirrored from this client's own handshake"
    : "a preset, in place of the client's";
  return `<p class="hint">TLS: <b>${esc(c.preset || "—")}</b> (${esc(c.via)}) — ${how}${
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
    <h4 class="sec">Headers</h4>${headerTable(d.request.headers)}
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
    <h4 class="sec">Headers</h4>${headerTable(d.response.headers)}
    ${bodyBlock(d.response.body, resMime)}`;
}

export async function showDetail(id) {
  state.detail = await api(`/api/flows/${id}`);
  renderDetail();
}

export function initDetail() {
  draggable($("#gutterH"), $("#flowPane"), "y");
  draggable($("#gutterV"), $("#reqHalf"), "x");

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
