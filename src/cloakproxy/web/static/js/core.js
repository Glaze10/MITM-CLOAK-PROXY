/* Shared plumbing: DOM helpers, the API, and the state every view reads. */

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export const fmtSize = (n) => !n ? "" : n < 1024 ? n + " B"
  : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";

export const MARKS = ["red", "orange", "yellow", "green", "blue", "purple"];

export async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const ct = r.headers.get("content-type") || "";
  return ct.includes("json") ? r.json() : r.text();
}

export function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2800);
}

/** Pretty-print when it's JSON and the user asked for pretty. */
export function pretty(text, mime = "", on = true) {
  if (!text || !on) return text || "";
  if (mime.includes("json") || /^\s*[{[]/.test(text)) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* as-is */ }
  }
  return text;
}

/** One place for everything the views share, so nothing has to guess. */
export const state = {
  flows: new Map(),          // id -> summary row
  order: [],                 // ids, in arrival order
  selected: new Set(),       // multi-select
  anchor: null,              // for shift-click ranges
  detail: null,              // the open flow's full record
  filter: {},                // the dialog's spec
  quick: "",
  prefs: { pretty: true, follow: true, maxRows: 2000 },
  proxy: {},                 // last known proxy state
  lastTls: null,             // the identity the most recent connection used
  repeater: [],              // open repeater tabs
};

/** Build a curl command from a flow — the one thing everyone copies out. */
export function asCurl(d) {
  const parts = [`curl -X ${d.request.method}`, `'${d.request.url}'`];
  for (const [k, v] of d.request.headers || []) {
    if (k.toLowerCase() === "content-length") continue;
    parts.push(`-H '${k}: ${String(v).replace(/'/g, "'\\''")}'`);
  }
  const body = (d.request.body || {}).text;
  if (body && (d.request.body || {}).encoding !== "base64") {
    parts.push(`--data-raw '${body.replace(/'/g, "'\\''")}'`);
  }
  return parts.join(" \\\n  ");
}

/* Other shapes of the same request. Which one is wanted depends entirely on
   where it goes next — a terminal, a notebook, a PowerShell prompt, a bug
   report — so Cloak offers the handful that cover almost every case rather
   than picking one. Content-Length is dropped throughout: every client
   recomputes it, and a stale one breaks the replay. */

const NL = "\n";

const reqHeaders = (d) =>
  (d.request.headers || []).filter(([k]) => k.toLowerCase() !== "content-length");

function reqBody(d) {
  const b = d.request.body || {};
  return b.text && b.encoding !== "base64" ? b.text : "";
}

export function asPowerShell(d) {
  const headers = reqHeaders(d)
    .map(([k, v]) => `  '${k}' = '${String(v).replace(/'/g, "''")}'`).join(NL);
  const body = reqBody(d);
  const out = [`$headers = @{${NL}${headers}${NL}}`];
  if (body) out.push(`$body = @'${NL}${body}${NL}'@`);
  out.push(`Invoke-WebRequest -Uri '${d.request.url}' -Method ${d.request.method}` +
           ` -Headers $headers${body ? " -Body $body" : ""}`);
  return out.join(NL + NL);
}

export function asPython(d) {
  const headers = reqHeaders(d)
    .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(String(v))},`).join(NL);
  const body = reqBody(d);
  const out = ["import requests", "", `headers = {${NL}${headers}${NL}}`];
  if (body) out.push(`data = ${JSON.stringify(body)}`);
  out.push("", `response = requests.request(${JSON.stringify(d.request.method)}, ` +
                `${JSON.stringify(d.request.url)}, headers=headers` +
                (body ? ", data=data" : "") + ")",
           "print(response.status_code)", "print(response.text)");
  return out.join(NL);
}

export function asFetch(d) {
  const init = {
    method: d.request.method,
    headers: Object.fromEntries(reqHeaders(d).map(([k, v]) => [k, String(v)])),
  };
  const body = reqBody(d);
  if (body) init.body = body;
  return `await fetch(${JSON.stringify(d.request.url)}, ${JSON.stringify(init, null, 2)});`;
}

export function asRawRequest(d) {
  const lines = [`${d.request.method} ${d.request.url} ${d.request.http_version}`];
  for (const [k, v] of d.request.headers || []) lines.push(`${k}: ${v}`);
  return lines.join(NL) + NL + NL + ((d.request.body || {}).text || "");
}

export function asRawResponse(d) {
  if (!d.response) return d.error ? `(failed) ${d.error}` : "(no response)";
  const lines = [`${d.response.http_version} ${d.response.status} ${d.response.reason || ""}`];
  for (const [k, v] of d.response.headers || []) lines.push(`${k}: ${v}`);
  return lines.join(NL) + NL + NL + ((d.response.body || {}).text || "");
}

export const asResponseBody = (d) => ((d.response || {}).body || {}).text || "";

export async function copy(text, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    // clipboard is blocked in some embedded webviews; fall back to a selection
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast(what);
  }
}

/** Make a gutter drag-resize the element before it. */
export function draggable(gutter, target, axis = "y") {
  let start = 0, startSize = 0, dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const delta = (axis === "y" ? e.clientY : e.clientX) - start;
    const size = Math.max(80, startSize + delta);
    if (axis === "y") target.style.height = size + "px";
    else target.style.flex = `0 0 ${size}px`;
  };
  const stop = () => {
    dragging = false;
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", stop);
  };
  gutter.addEventListener("mousedown", (e) => {
    dragging = true;
    start = axis === "y" ? e.clientY : e.clientX;
    startSize = axis === "y" ? target.offsetHeight : target.offsetWidth;
    document.body.style.cursor = axis === "y" ? "row-resize" : "col-resize";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", stop);
    e.preventDefault();
  });
}
