/* Cloak UI — flow list, detail, intercept, HAR, projects. No framework on purpose:
   one file you can read start to finish, and no build step between you and a fix. */
const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
};

const state = { flows: new Map(), selected: null, detail: null, tab: "request", filter: "" };

/* ── helpers ─────────────────────────────────────────────────────────── */
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const size = (n) => !n ? "" : n < 1024 ? n + " B" : n < 1048576
  ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
const toast = (msg, bad = false) => {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.classList.remove("hidden");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add("hidden"), 2600);
};
const pretty = (text, mime) => {
  if (!text) return "";
  if ((mime || "").includes("json") || /^\s*[{[]/.test(text)) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* leave it */ }
  }
  return text;
};

/* ── flow table ──────────────────────────────────────────────────────── */
function rowHtml(f) {
  const cls = [f.intercepted || f.state === "paused" ? "paused" : "",
               f.imported ? "imported" : "", state.selected === f.id ? "sel" : ""]
              .filter(Boolean).join(" ");
  const sc = f.status ? String(f.status)[0] : "0";
  return `<tr data-id="${f.id}" class="${cls}">
    <td>${esc(f.method)}</td><td>${esc(f.host)}</td><td>${esc(f.path)}</td>
    <td class="status-${sc}">${f.status ?? (f.state === "paused" ? "…" : "—")}</td>
    <td>${esc(f.mime || "")}</td><td>${size(f.size)}</td>
    <td>${f.ms != null ? f.ms + " ms" : ""}</td></tr>`;
}

function render() {
  const rows = [...state.flows.values()];
  $("#rows").innerHTML = rows.map(rowHtml).join("");
  $("#count").textContent = `${rows.length} flow${rows.length === 1 ? "" : "s"}`;
}

async function loadFlows() {
  const q = encodeURIComponent(state.filter);
  const { flows } = await api(`/api/flows?q=${q}`);
  state.flows = new Map(flows.map((f) => [f.id, f]));
  render();
}

function upsert(f) {
  if (state.filter) {                       // a filtered view only takes matches
    const hay = `${f.method} ${f.url} ${f.status ?? ""} ${f.mime ?? ""}`.toLowerCase();
    if (!hay.includes(state.filter.toLowerCase())) return;
  }
  state.flows.set(f.id, { ...(state.flows.get(f.id) || {}), ...f });
  render();
}

/* ── detail ──────────────────────────────────────────────────────────── */
function headersTable(pairs) {
  return `<table class="kv">${(pairs || [])
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>`;
}

function paneRequest(d) {
  const b = d.request.body || {};
  return `<h4>${esc(d.request.method)} ${esc(d.request.http_version)}</h4>
    <div class="url">${esc(d.request.url)}</div>
    <h4>Headers</h4>${headersTable(d.request.headers)}
    <h4>Body ${b.size ? `(${size(b.size)}${b.truncated ? ", truncated" : ""})` : ""}</h4>
    ${b.text ? `<pre>${esc(b.encoding === "base64" ? "[binary, base64]\n" + b.text : pretty(b.text))}</pre>`
             : `<p class="empty">No body.</p>`}`;
}

function paneResponse(d) {
  if (!d.response) {
    return `<p class="empty">${d.error ? "Failed: " + esc(d.error)
      : d.state === "paused" ? "Parked — forward it to get a response."
      : "No response yet."}</p>`;
  }
  const b = d.response.body || {};
  const mime = (d.response.headers.find(([k]) => k.toLowerCase() === "content-type") || [])[1];
  return `<h4>${d.response.status} ${esc(d.response.reason || "")}</h4>
    <h4>Headers</h4>${headersTable(d.response.headers)}
    <h4>Body ${b.size ? `(${size(b.size)}${b.truncated ? ", truncated" : ""})` : ""}</h4>
    ${b.text ? `<pre>${esc(b.encoding === "base64" ? "[binary, base64]\n" + b.text : pretty(b.text, mime))}</pre>`
             : `<p class="empty">Empty body.</p>`}`;
}

function paneEdit(d) {
  const b = d.request.body || {};
  const hdrs = (d.request.headers || []).map(([k, v]) => `${k}: ${v}`).join("\n");
  return `<div class="row">
      <input id="eMethod" value="${esc(d.request.method)}" style="max-width:110px">
      <input id="eUrl" value="${esc(d.request.url)}">
    </div>
    <h4>Headers — one per line</h4>
    <textarea id="eHeaders">${esc(hdrs)}</textarea>
    <h4>Body</h4>
    <textarea id="eBody">${esc(b.encoding === "base64" ? "" : b.text || "")}</textarea>
    <div class="row" style="margin-top:10px">
      <button id="eApply">Apply</button>
      <button id="eApplyGo" class="ok">Apply &amp; forward</button>
      <button id="eReplay">Apply &amp; replay</button>
    </div>
    <p class="empty">Editing applies to the live flow. Forward is for a parked request;
      replay sends a fresh copy.</p>`;
}

function renderDetail() {
  const d = state.detail;
  const pane = $("#pane");
  if (!d) { pane.innerHTML = `<p class="empty">Pick a flow.</p>`; return; }
  const paused = d.state === "paused" || d.intercepted;
  $("#resume").classList.toggle("hidden", !paused);
  $("#drop").classList.toggle("hidden", !paused);
  $("#replay").classList.toggle("hidden", !!d.imported);
  pane.innerHTML = { request: paneRequest, response: paneResponse, edit: paneEdit }[state.tab](d);
  if (state.tab === "edit") wireEdit(d);
}

function collectEdit() {
  const headers = $("#eHeaders").value.split("\n").map((l) => {
    const i = l.indexOf(":");
    return i < 0 ? null : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }).filter(Boolean);
  return { method: $("#eMethod").value.trim(), url: $("#eUrl").value.trim(),
           headers, body: $("#eBody").value };
}

function wireEdit(d) {
  const send = async (then_resume, replay) => {
    const r = await api(`/api/flows/${d.id}`, {
      method: "POST", body: { action: "edit", ...collectEdit(), then_resume },
    });
    if (!r.ok) return toast("Couldn't apply the edit", true);
    if (replay) await api(`/api/flows/${d.id}`, { method: "POST", body: { action: "replay" } });
    toast(replay ? "Replayed" : then_resume ? "Forwarded" : "Applied");
    select(d.id);
  };
  $("#eApply").onclick = () => send(false, false);
  $("#eApplyGo").onclick = () => send(true, false);
  $("#eReplay").onclick = () => send(false, true);
}

async function select(id) {
  state.selected = id;
  render();
  state.detail = await api(`/api/flows/${id}`);
  renderDetail();
}

/* ── proxy + intercept ───────────────────────────────────────────────── */
function paintState(s) {
  $("#dot").classList.toggle("on", !!s.running);
  $("#toggle").textContent = s.running ? "Stop" : "Start";
  $("#toggle").classList.toggle("primary", !s.running);
  $("#port").value = s.port;
  $("#mode").value = s.mode;
  if (s.presets && $("#preset").options.length !== s.presets.length) {
    $("#preset").innerHTML = s.presets.map((p) =>
      `<option value="${p}"${p === s.preset ? " selected" : ""}>${p}</option>`).join("");
  }
  const btn = $("#intercept");
  btn.textContent = `Intercept: ${s.intercept ? "on" : "off"}` +
    (s.paused ? ` (${s.paused} parked)` : "");
  btn.classList.toggle("on", !!s.intercept);
  if (s.error) toast(s.error, true);
}

/* ── wiring ──────────────────────────────────────────────────────────── */
$("#toggle").onclick = async () => {
  const running = $("#dot").classList.contains("on");
  paintState(await api(running ? "/api/proxy/stop" : "/api/proxy/start", {
    method: "POST",
    body: { port: +$("#port").value, mode: $("#mode").value, preset: $("#preset").value },
  }));
};
$("#intercept").onclick = async () => {
  const on = !$("#intercept").classList.contains("on");
  paintState(await api("/api/intercept", {
    method: "POST", body: { enabled: on, filter: $("#interceptFilter").value },
  }));
};
$("#interceptFilter").onchange = async () => {
  paintState(await api("/api/intercept", {
    method: "POST", body: { filter: $("#interceptFilter").value },
  }));
};
$("#filter").oninput = (e) => {
  state.filter = e.target.value.trim();
  clearTimeout(window._ft);
  window._ft = setTimeout(loadFlows, 180);
};
$("#clear").onclick = async () => {
  await api("/api/flows", { method: "DELETE" });
  state.flows.clear(); state.detail = null; state.selected = null;
  render(); renderDetail();
};
$("#rows").onclick = (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (tr) select(tr.dataset.id);
};
document.querySelectorAll(".tabs button[data-tab]").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".tabs button[data-tab]").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    state.tab = b.dataset.tab;
    renderDetail();
  };
});
$("#resume").onclick = async () => {
  await api(`/api/flows/${state.selected}`, { method: "POST", body: { action: "resume" } });
  toast("Forwarded");
};
$("#drop").onclick = async () => {
  await api(`/api/flows/${state.selected}`, { method: "POST", body: { action: "drop" } });
  toast("Dropped");
};
$("#replay").onclick = async () => {
  const r = await api(`/api/flows/${state.selected}`, { method: "POST", body: { action: "replay" } });
  toast(r.ok ? "Replayed" : "Replay needs the proxy running", !r.ok);
};
$("#exportHar").onclick = () => { window.location = "/api/har?name=cloak.har"; };
$("#importHar").onclick = async () => {
  const path = prompt("Path to a .har file on this machine:");
  if (!path) return;
  const r = await api("/api/har", { method: "POST", body: { path } });
  r.error ? toast(r.error, true) : toast(`Imported ${r.imported} entries`);
  loadFlows();
};
$("#saveProject").onclick = async () => {
  const name = $("#projectName").value.trim() || prompt("Project name:") || "";
  if (!name) return;
  const r = await api("/api/projects", { method: "POST", body: { action: "save", name } });
  toast(`Saved ${r.project.flows} flows to ${r.project.name}`);
  loadProjects();
};
$("#projects").onchange = async (e) => {
  if (!e.target.value) return;
  const r = await api("/api/projects", { method: "POST", body: { action: "load", name: e.target.value } });
  toast(`Loaded ${r.flows} flows`);
  loadFlows();
};
$("#cert").onclick = async () => {
  const c = await api("/api/cert");
  if (!c.exists) return toast("Start the proxy once — the CA is made on first run", true);
  toast(`CA: ${c.dir} — on the device, browse to mitm.it through the proxy`);
  window.location = "/api/cert?download=1";
};

async function loadProjects() {
  const { projects } = await api("/api/projects");
  $("#projects").innerHTML = `<option value="">open project…</option>` +
    projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} · ${p.flows} flows</option>`).join("");
}

/* ── live events ─────────────────────────────────────────────────────── */
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const { type, data } = JSON.parse(ev.data);
    if (type === "proxy") return paintState(data);
    if (type === "cleared") { state.flows.clear(); return render(); }
    if (type === "imported" || type === "loaded") return loadFlows();
    if (data && data.id) {
      upsert(data);
      if (state.selected === data.id) select(data.id);
      if (type === "intercepted") toast(`Parked ${data.method} ${data.host}`);
    }
  };
  ws.onclose = () => setTimeout(connect, 1200);
}

(async function boot() {
  paintState(await api("/api/state"));
  await Promise.all([loadFlows(), loadProjects()]);
  connect();
})();
