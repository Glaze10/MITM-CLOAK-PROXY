/* Boot: wire the tab shell, the title bar, and the live event feed. */
import { $, $$, api, state, toast } from "./core.js";
import { initDetail } from "./detail.js";
import { initFilter } from "./filter.js";
import { initFlows, loadFlows, renderFlows, upsertFlow } from "./flows.js";
import { initIntercept, renderQueue, setIntercept } from "./intercept.js";
import { initRepeater } from "./repeater.js";
import { initRules, loadRules } from "./rules.js";
import { initSettings, loadProjects, paintSettings, refreshCloakStats } from "./settings.js";

/* ── tabs ────────────────────────────────────────────────────────────── */
function initTabs() {
  $$(".tabs.top button").forEach((b) => {
    b.onclick = () => {
      $$(".tabs.top button").forEach((x) => x.classList.toggle("on", x === b));
      $$(".tabview").forEach((v) => v.classList.toggle("on", v.dataset.view === b.dataset.tab));
      if (b.dataset.tab === "projects") loadProjects();
    };
  });
  $$(".tabs.sub button[data-sub]").forEach((b) => {
    b.onclick = () => {
      const bar = b.closest(".tabs.sub");
      const view = b.closest(".tabview");
      bar.querySelectorAll("button[data-sub]").forEach((x) => x.classList.toggle("on", x === b));
      view.querySelectorAll(".subview").forEach((v) =>
        v.classList.toggle("on", v.dataset.sub === b.dataset.sub));
      if (b.dataset.sub === "intercept") renderQueue();
      if (b.dataset.sub === "replace") loadRules();
      if (b.dataset.sub === "settings") refreshCloakStats();
    };
  });
}

/* ── title bar ───────────────────────────────────────────────────────── */
export function paintState(s) {
  state.proxy = s;
  $("#dot").classList.toggle("on", !!s.running);
  $("#statusText").textContent = s.running
    ? `listening on :${s.port}` : s.error ? "stopped — see settings" : "stopped";
  $("#btnToggle").textContent = s.running ? "Stop" : "Start";
  $("#btnToggle").classList.toggle("primary", !s.running);
  const ib = $("#btnIntercept");
  ib.textContent = `Intercept: ${s.intercept ? "on" : "off"}${s.paused ? ` · ${s.paused}` : ""}`;
  ib.classList.toggle("on", !!s.intercept);
  paintSettings(s);
  if (s.error) toast(s.error, true);
}

function initTitlebar() {
  $("#btnToggle").onclick = async () => {
    const running = state.proxy.running;
    paintState(await api(running ? "/api/proxy/stop" : "/api/proxy/start", {
      method: "POST",
      body: { port: +$("#setPort").value || 8080,
              mode: $('#modeChoices input:checked')?.value || "auto",
              preset: $("#setPreset").value },
    }));
  };
  $("#btnIntercept").onclick = async () => {
    paintState(await setIntercept(!state.proxy.intercept, undefined));
    renderQueue();
  };
}

/* ── history toolbar ─────────────────────────────────────────────────── */
function initHistoryBar() {
  let t;
  $("#quickFilter").oninput = (e) => {
    state.quick = e.target.value.trim();
    clearTimeout(t);
    t = setTimeout(loadFlows, 180);
  };
  $("#btnClear").onclick = async () => {
    await api("/api/flows", { method: "DELETE" });
    state.flows.clear();
    state.order = [];
    state.selected.clear();
    state.detail = null;
    renderFlows();
    renderQueue();
  };
  $("#btnExport").onclick = () => {
    const ids = [...state.selected];
    window.location = ids.length > 1
      ? `/api/har?name=cloak-selection.har&ids=${ids.join(",")}`
      : "/api/har?name=cloak.har";
  };
  $("#btnImport").onclick = async () => {
    const path = prompt("Path to a .har file on this machine:");
    if (!path) return;
    const r = await api("/api/har", { method: "POST", body: { path } });
    r.error ? toast(r.error, true) : toast(`Imported ${r.imported} entries`);
    loadFlows();
  };
}

/* ── live events ─────────────────────────────────────────────────────── */
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const { type, data } = JSON.parse(ev.data);
    if (type === "proxy") return paintState(data);
    if (type === "cleared") { state.flows.clear(); state.order = []; return renderFlows(); }
    if (type === "imported" || type === "loaded" || type === "rules") return loadFlows();
    if (data && data.id) {
      upsertFlow(data);
      if (type === "intercepted") {
        renderQueue();
        toast(`Parked ${data.method} ${data.host}`);
      }
      if (type === "resumed" || type === "dropped") renderQueue();
    }
  };
  ws.onclose = () => setTimeout(connect, 1200);
}

/* ── boot ────────────────────────────────────────────────────────────── */
(async function boot() {
  initTabs();
  initTitlebar();
  initHistoryBar();
  initFlows();
  initDetail();
  initFilter();
  initIntercept();
  initRules();
  initRepeater();
  initSettings();

  paintState(await api("/api/state"));
  await Promise.all([loadFlows(), loadRules(), refreshCloakStats()]);
  const cert = await api("/api/cert");
  $("#certPath").textContent = cert.dir || "—";
  $("#aboutVersions").textContent = `UI on ${location.host} · proxy port ${state.proxy.port}`;
  connect();
  setInterval(refreshCloakStats, 4000);
})();
