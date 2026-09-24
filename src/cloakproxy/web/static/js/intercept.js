/* The intercept tab: what's parked, and the editor for whichever one you pick. */
import { $, api, esc, state, toast } from "./core.js";

let current = null;

function parked() {
  return state.order.map((id) => state.flows.get(id))
    .filter((f) => f && (f.intercepted || f.state === "paused"));
}

export function renderQueue() {
  const rows = parked();
  $("#queueCount").textContent = rows.length;
  $("#parkedCount").textContent = rows.length;
  $("#parkedCount").classList.toggle("hidden", !rows.length);
  $("#queue").innerHTML = rows.map((f) => `
    <li data-id="${f.id}" class="${current === f.id ? "on" : ""}">
      <b>${esc(f.method)}</b> ${esc(f.host)}<br><span class="hint">${esc(f.path)}</span>
    </li>`).join("");
  if (!rows.length) {
    current = null;
    $("#interceptEditor").innerHTML =
      `<p class="empty">Nothing parked. Arm intercept, then make a request.</p>`;
  } else if (!current || !rows.some((f) => f.id === current)) {
    openEditor(rows[0].id);
  }
}

async function openEditor(id) {
  current = id;
  const d = await api(`/api/flows/${id}`);
  const headers = (d.request.headers || []).map(([k, v]) => `${k}: ${v}`).join("\n");
  const body = (d.request.body || {}).encoding === "base64" ? "" : (d.request.body || {}).text || "";
  $("#interceptEditor").innerHTML = `
    <div class="row">
      <input id="iMethod" value="${esc(d.request.method)}" style="max-width:110px">
      <input id="iUrl" value="${esc(d.request.url)}">
    </div>
    <h4 class="sec">Headers</h4>
    <textarea id="iHeaders">${esc(headers)}</textarea>
    <h4 class="sec">Body</h4>
    <textarea id="iBody">${esc(body)}</textarea>
    <div class="row" style="margin-top:10px">
      <button id="iForward" class="primary">Forward</button>
      <button id="iForwardClean">Forward unchanged</button>
      <button id="iDrop" class="danger">Drop</button>
      <span class="spacer"></span>
      <span class="hint">Ctrl+Enter forwards</span>
    </div>`;
  renderQueue();

  const edits = () => ({
    method: $("#iMethod").value.trim(),
    url: $("#iUrl").value.trim(),
    headers: $("#iHeaders").value.split("\n").map((l) => {
      const i = l.indexOf(":");
      return i < 0 ? null : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }).filter(Boolean),
    body: $("#iBody").value,
  });

  const forward = async (withEdits) => {
    await api(`/api/flows/${id}`, {
      method: "POST",
      body: withEdits ? { action: "edit", ...edits(), then_resume: true } : { action: "resume" },
    });
    toast("Forwarded");
    current = null;
    renderQueue();
  };
  $("#iForward").onclick = () => forward(true);
  $("#iForwardClean").onclick = () => forward(false);
  $("#iDrop").onclick = async () => {
    await api(`/api/flows/${id}`, { method: "POST", body: { action: "drop" } });
    toast("Dropped");
    current = null;
    renderQueue();
  };
  $("#interceptEditor").onkeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") forward(true);
  };
}

export async function setIntercept(enabled, filter) {
  const body = {};
  if (enabled !== undefined) body.enabled = enabled;
  if (filter !== undefined) body.filter = filter;
  const s = await api("/api/intercept", { method: "POST", body });
  state.proxy = s;
  return s;
}

export function initIntercept() {
  $("#queue").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) openEditor(li.dataset.id);
  });
  $("#interceptOn").onchange = (e) => setIntercept(e.target.checked, undefined);
  $("#interceptFilter").onchange = (e) => setIntercept(undefined, e.target.value);
  $("#btnForwardAll").onclick = async () => {
    const rows = parked();
    for (const f of rows) await api(`/api/flows/${f.id}`, { method: "POST", body: { action: "resume" } });
    toast(`Forwarded ${rows.length}`);
    renderQueue();
  };
  $("#btnDropAll").onclick = async () => {
    const rows = parked();
    for (const f of rows) await api(`/api/flows/${f.id}`, { method: "POST", body: { action: "drop" } });
    toast(`Dropped ${rows.length}`);
    renderQueue();
  };
}
