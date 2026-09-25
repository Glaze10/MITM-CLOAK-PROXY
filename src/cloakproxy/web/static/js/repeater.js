/* Repeater: a tab per request you're poking at. Edit, send, read, send again.

   One message editor, not two boxes — headers and body live together as the raw
   request, the way Burp's editor and an actual HTTP request both are. The method
   is a dropdown, since it's one of a known handful. The original captured flow is
   never touched; each send makes its own flow. */
import { $, esc, api, pretty, state, toast } from "./core.js";

let active = null;
let seq = 0;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function renderTabs() {
  const bar = $("#repeaterTabs");
  if (!state.repeater.length) {
    bar.innerHTML = `<span class="hint pad">Send a request here from History — right-click a
      flow, or open it and press Send to Repeater.</span>`;
    return;
  }
  bar.innerHTML = state.repeater.map((t) =>
    `<button data-rid="${t.key}" class="reptab ${t.key === active ? "on" : ""}">
      <span class="repmethod m-${t.method.toLowerCase()}">${esc(t.method)}</span>
      <span class="reptitle">${esc(t.host)}</span>
      <span class="badge" data-close="${t.key}">✕</span></button>`).join("");
}

function methodOptions(current) {
  const all = METHODS.includes(current) ? METHODS : [current, ...METHODS];
  return all.map((m) => `<option${m === current ? " selected" : ""}>${esc(m)}</option>`).join("");
}

function responseHtml(d) {
  if (d && d.response) {
    const mime = (d.response.headers || [])
      .find(([k]) => k.toLowerCase() === "content-type")?.[1] || "";
    const cls = "status-" + String(d.response.status)[0];
    const size = (d.response.body || {}).size;
    return `
      <div class="repstatus ${cls}">
        <span class="code">${d.response.status}</span>
        <span class="reason">${esc(d.response.reason || "")}</span>
        <span class="spacer"></span>
        <span class="dim">${d.ms != null ? d.ms + " ms" : ""}${
          size ? ` · ${size} B` : ""}</span>
      </div>
      <table class="kv">${(d.response.headers || []).map(([k, v]) =>
        `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
      <pre class="repbody">${esc(pretty((d.response.body || {}).text || "", mime,
        state.prefs.pretty))}</pre>`;
  }
  if (d && d.error) return `<p class="empty">Failed: ${esc(d.error)}</p>`;
  return `<p class="empty">Press Send.</p>`;
}

function renderPane() {
  const t = state.repeater.find((x) => x.key === active);
  const body = $("#repeaterBody");
  if (!t) {
    body.innerHTML = `<p class="empty pad">Nothing here yet. In History, right-click a flow and
      choose <b>Send to Repeater</b>.</p>`;
    return;
  }
  body.innerHTML = `
    <div class="repeaterPane">
      <div class="reptoolbar">
        <select data-r="method" class="repmethodsel">${methodOptions(t.method)}</select>
        <input data-r="url" class="grow" value="${esc(t.url)}" spellcheck="false">
        <button data-r="send" class="primary">Send</button>
      </div>
      <div class="split-h" style="flex:1 1 auto; min-height:0">
        <div class="half" id="repReqHalf">
          <div class="halfbar"><span>Request</span>
            <span class="spacer"></span>
            <span class="hint">headers, a blank line, then the body</span></div>
          <div class="halfbody nopad">
            <textarea data-r="raw" class="repraw" spellcheck="false">${esc(t.raw)}</textarea>
          </div>
        </div>
        <div class="gutter-v" id="repGutter"></div>
        <div class="half">
          <div class="halfbar"><span>Response</span>
            <span class="spacer"></span>
            <span class="hint">${t.sentAt ? "sent " + t.sentAt : "not sent yet"}</span></div>
          <div class="halfbody" id="repResponse">${t.responseHtml || responseHtml(null)}</div>
        </div>
      </div>
    </div>`;

  const get = (n) => body.querySelector(`[data-r="${n}"]`);
  const keep = () => { t.method = get("method").value; t.url = get("url").value;
                       t.raw = get("raw").value; };
  ["method", "url", "raw"].forEach((n) => { get(n).onchange = keep; });
  get("send").onclick = () => send(t, get);
  // Ctrl/Cmd+Enter sends, from anywhere in the editor
  get("raw").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(t, get); }
  });
  draggable($("#repGutter"), $("#repReqHalf"), "x");
}

/** Split the raw editor into headers + body at the first blank line. */
function parseRaw(raw) {
  const nl = raw.indexOf("\n\n");
  const head = nl < 0 ? raw : raw.slice(0, nl);
  const body = nl < 0 ? "" : raw.slice(nl + 2);
  const headers = head.split("\n").map((l) => {
    const i = l.indexOf(":");
    return i < 0 ? null : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }).filter(Boolean);
  return { headers, body };
}

async function send(t, get) {
  t.method = get("method").value; t.url = get("url").value; t.raw = get("raw").value;
  const { headers, body } = parseRaw(t.raw);
  const r = await api("/api/repeater", {
    method: "POST",
    body: { id: t.flowId, method: t.method, url: t.url, headers, body },
  });
  if (r.error) return toast(r.error, true);
  t.sentAt = new Date().toLocaleTimeString();
  $("#repResponse").innerHTML = `<p class="empty">Sent — waiting…</p>`;
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 250));
    const d = await api(`/api/flows/${r.id}`);
    if (d && (d.response || d.error)) {
      t.responseHtml = responseHtml(d);
      $("#repResponse").innerHTML = t.responseHtml;
      return;
    }
  }
  $("#repResponse").innerHTML = `<p class="empty">No response yet — check History.</p>`;
}

export async function addRepeaterTab(flowId) {
  const d = await api(`/api/flows/${flowId}`);
  if (!d || d.error) return toast("Couldn't open that flow", true);
  const headers = (d.request.headers || []).map(([k, v]) => `${k}: ${v}`).join("\n");
  const reqBody = (d.request.body || {}).encoding === "base64"
    ? "" : (d.request.body || {}).text || "";
  const key = `r${++seq}`;
  state.repeater.push({
    key, flowId,
    host: (d.host || "").slice(0, 22),
    method: d.request.method,
    url: d.request.url,
    raw: reqBody ? `${headers}\n\n${reqBody}` : `${headers}\n`,
    responseHtml: "", sentAt: "",
  });
  active = key;
  renderTabs();
  renderPane();
  document.querySelector('.tabs.top button[data-tab="repeater"]').click();
  toast("Opened in Repeater");
}

/* a tiny local copy of the gutter drag, so the response pane resizes too */
function draggable(gutter, target, axis) {
  if (!gutter || !target) return;
  gutter.onmousedown = (e) => {
    e.preventDefault();
    const start = e.clientX, startW = target.offsetWidth;
    const move = (ev) => { target.style.flex = `0 0 ${Math.max(120, startW + ev.clientX - start)}px`; };
    const up = () => { document.removeEventListener("mousemove", move);
                       document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
}

export function initRepeater() {
  $("#repeaterTabs").addEventListener("click", (e) => {
    const close = e.target.closest("[data-close]");
    if (close) {
      state.repeater = state.repeater.filter((t) => t.key !== close.dataset.close);
      if (active === close.dataset.close) active = state.repeater.at(-1)?.key || null;
      renderTabs(); renderPane();
      return;
    }
    const tab = e.target.closest("[data-rid]");
    if (tab) { active = tab.dataset.rid; renderTabs(); renderPane(); }
  });
}
