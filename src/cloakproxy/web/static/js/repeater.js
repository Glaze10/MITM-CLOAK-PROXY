/* Repeater: a tab per request you're poking at. Edit, send, read, send again. */
import { $, api, esc, pretty, state, toast } from "./core.js";

let active = null;
let seq = 0;

function renderTabs() {
  const bar = $("#repeaterTabs");
  if (!state.repeater.length) {
    bar.innerHTML = `<span class="hint pad">Send a request here from History, then edit and resend it.</span>`;
    return;
  }
  bar.innerHTML = state.repeater.map((t) =>
    `<button data-rid="${t.key}" class="${t.key === active ? "on" : ""}">${esc(t.title)}
      <span class="badge" data-close="${t.key}">✕</span></button>`).join("");
}

function renderPane() {
  const t = state.repeater.find((x) => x.key === active);
  const body = $("#repeaterBody");
  if (!t) {
    body.innerHTML = `<p class="empty pad">Nothing here yet. In History, pick a flow and press
      <b>Send to Repeater</b>.</p>`;
    return;
  }
  body.innerHTML = `
    <div class="repeaterPane">
      <div class="toolbar">
        <input data-r="method" value="${esc(t.method)}" style="max-width:110px">
        <input data-r="url" class="grow" value="${esc(t.url)}">
        <button data-r="send" class="primary">Send</button>
      </div>
      <div class="split-h" style="flex:1 1 auto; min-height:0">
        <div class="half">
          <div class="halfbar"><span>Request</span></div>
          <div class="halfbody">
            <h4 class="sec">Headers</h4>
            <textarea data-r="headers" style="min-height:130px">${esc(t.headers)}</textarea>
            <h4 class="sec">Body</h4>
            <textarea data-r="body" style="min-height:170px">${esc(t.body)}</textarea>
          </div>
        </div>
        <div class="gutter-v"></div>
        <div class="half">
          <div class="halfbar"><span>Response</span>
            <span class="spacer"></span>
            <span class="hint">${t.sentAt ? "sent " + t.sentAt : "not sent yet"}</span>
          </div>
          <div class="halfbody" id="repResponse">${t.responseHtml ||
            `<p class="empty">Press Send.</p>`}</div>
        </div>
      </div>
    </div>`;

  const get = (n) => body.querySelector(`[data-r="${n}"]`);
  const keep = () => {
    t.method = get("method").value;
    t.url = get("url").value;
    t.headers = get("headers").value;
    t.body = get("body").value;
  };
  ["method", "url", "headers", "body"].forEach((n) => { get(n).onchange = keep; });
  get("send").onclick = async () => {
    keep();
    const headers = t.headers.split("\n").map((l) => {
      const i = l.indexOf(":");
      return i < 0 ? null : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }).filter(Boolean);
    const r = await api("/api/repeater", {
      method: "POST",
      body: { id: t.flowId, method: t.method, url: t.url, headers, body: t.body },
    });
    if (r.error) return toast(r.error, true);
    t.sentAt = new Date().toLocaleTimeString();
    $("#repResponse").innerHTML = `<p class="empty">Sent — waiting…</p>`;
    // the reply comes back as its own flow; poll briefly for it
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 250));
      const d = await api(`/api/flows/${r.id}`);
      if (d && d.response) {
        const mime = (d.response.headers || [])
          .find(([k]) => k.toLowerCase() === "content-type")?.[1] || "";
        t.responseHtml = `
          <div class="statusline status-${String(d.response.status)[0]}">${d.response.status} ${
            esc(d.response.reason || "")}</div>
          <h4 class="sec">Headers</h4>
          <table class="kv">${(d.response.headers || []).map(([k, v]) =>
            `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
          <h4 class="sec">Body</h4>
          <pre>${esc(pretty((d.response.body || {}).text || "", mime, state.prefs.pretty))}</pre>`;
        $("#repResponse").innerHTML = t.responseHtml;
        return;
      }
      if (d && d.error) {
        t.responseHtml = `<p class="empty">Failed: ${esc(d.error)}</p>`;
        $("#repResponse").innerHTML = t.responseHtml;
        return;
      }
    }
    $("#repResponse").innerHTML = `<p class="empty">No response yet — check History.</p>`;
  };
}

export async function addRepeaterTab(flowId) {
  const d = await api(`/api/flows/${flowId}`);
  if (!d || d.error) return toast("Couldn't open that flow", true);
  const key = `r${++seq}`;
  state.repeater.push({
    key,
    flowId,
    title: `${d.request.method} ${(d.host || "").slice(0, 18)}`,
    method: d.request.method,
    url: d.request.url,
    headers: (d.request.headers || []).map(([k, v]) => `${k}: ${v}`).join("\n"),
    body: (d.request.body || {}).encoding === "base64" ? "" : (d.request.body || {}).text || "",
    responseHtml: "",
    sentAt: "",
  });
  active = key;
  renderTabs();
  renderPane();
  document.querySelector('.tabs.top button[data-tab="repeater"]').click();
  toast("Opened in Repeater");
}

export function initRepeater() {
  $("#repeaterTabs").addEventListener("click", (e) => {
    const close = e.target.closest("[data-close]");
    if (close) {
      state.repeater = state.repeater.filter((t) => t.key !== close.dataset.close);
      if (active === close.dataset.close) active = state.repeater.at(-1)?.key || null;
      renderTabs();
      renderPane();
      return;
    }
    const tab = e.target.closest("[data-rid]");
    if (tab) {
      active = tab.dataset.rid;
      renderTabs();
      renderPane();
    }
  });
}
