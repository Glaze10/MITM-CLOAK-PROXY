/* Boot: wire the tab shell, the title bar, and the live event feed. */
import { $, $$, api, copy, pickFile, saveText, state, toast } from "./core.js";
import { initDetail } from "./detail.js";
import { initFilter } from "./filter.js";
import { initFlows, loadFlows, renderFlows, upsertFlow } from "./flows.js";
import { initIntercept, renderQueue, setIntercept } from "./intercept.js";
import { initRepeater } from "./repeater.js";
import { initRules, loadRules } from "./rules.js";
import { initSettings, loadProjects, loadTls, paintSettings, refreshCloakStats } from "./settings.js";
import { initAutosave, markDirty } from "./save.js";

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
      if (b.dataset.sub === "settings") { refreshCloakStats(); loadTls(); }
    };
  });
}

/* ── title bar ───────────────────────────────────────────────────────── */
/** The address a device should be pointed at — the one thing needed to start. */
function paintAddress(s) {
  const addr = `${s.lan_ip || "127.0.0.1"}:${s.port}`;
  const btn = $("#proxyAddr");
  if (btn.textContent !== addr) btn.textContent = addr;
  $("#noFlowsAddr").textContent = addr;
}

export function paintState(s) {
  state.proxy = s;
  paintAddress(s);
  $("#dot").classList.toggle("on", !!s.running);
  const live = (s.listening || []).map((p) => ":" + p);
  $("#statusText").textContent = s.running
    ? (live.length ? `listening on ${live.join(", ")}` : "no ports switched on")
    : s.error ? "stopped — see settings" : "stopped";
  $("#btnToggle").textContent = s.running ? "Stop" : "Start";
  $("#btnToggle").classList.toggle("primary", !s.running);
  const ib = $("#btnIntercept");
  ib.textContent = `Intercept: ${s.intercept ? "on" : "off"}${s.paused ? ` · ${s.paused}` : ""}`;
  ib.classList.toggle("on", !!s.intercept);
  paintSettings(s);
  if (s.error) toast(s.error, true);
}

function initTitlebar() {
  $("#proxyAddr").onclick = (e) => {
    copy(e.target.textContent, "Address copied");
    e.target.classList.add("copied");
    setTimeout(() => e.target.classList.remove("copied"), 1100);
  };
  $("#btnToggle").onclick = async () => {
    const running = state.proxy.running;
    // acknowledge the click at once — start/stop does real work (binding or a
    // graceful shutdown) and awaiting it before any paint reads as a dead button
    const btn = $("#btnToggle");
    btn.disabled = true;
    btn.textContent = running ? "Stopping…" : "Starting…";
    $("#statusText").textContent = running ? "stopping…" : "starting…";
    try {
      paintState(await api(running ? "/api/proxy/stop" : "/api/proxy/start", {
        method: "POST",
        body: { mode: $('#modeChoices input:checked')?.value || "auto",
                preset: $("#setPreset").value },
      }));
    } finally {
      btn.disabled = false;
    }
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
  $("#btnExport").onclick = async () => {
    const ids = [...state.selected];
    const many = ids.length > 1;
    const name = many ? "cloak-selection.har" : "cloak.har";
    const url = many ? `/api/har?name=${name}&ids=${ids.join(",")}` : `/api/har?name=${name}`;
    // fetch the HAR, then hand it to the window's Save dialog (or the browser)
    const text = await fetch(url).then((r) => r.text());
    await saveText(name, text, url);
  };
  $("#btnImport").onclick = async () => {
    const path = await pickFile();
    if (!path) return;
    const r = await api("/api/har", { method: "POST", body: { path } });
    r.error ? toast(r.error, true) : toast(`Imported ${r.imported} entries`);
    markDirty();
    loadFlows();
  };
}

/* A desktop window has no address bar to reload from, and the interface is
   served fresh on every request — so the shortcut everyone already reaches for
   should work here too. */
function initReload() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")) {
      e.preventDefault();
      location.reload();
    }
  });
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
  initReload();
  initAutosave();

  // Get the essentials up first — state and the flow list — so the window is
  // interactive at once. Everything else loads after, without blocking, and
  // each step is timed so a slow one shows up in the console rather than as a
  // mysterious "not responding".
  const t = (label, p) => {
    const t0 = performance.now();
    return Promise.resolve(p).then((r) => {
      const ms = performance.now() - t0;
      if (ms > 250) console.warn(`[boot] ${label} took ${ms.toFixed(0)}ms`);
      return r;
    }).catch((e) => console.error(`[boot] ${label} failed`, e));
  };

  paintState(await t("state", api("/api/state")));
  await t("flows", loadFlows());

  // the interface is usable now — drop the loading splash
  const splash = $("#splash");
  if (splash) { splash.classList.add("gone"); setTimeout(() => splash.remove(), 400); }

  connect();
  // non-essential; let them settle in the background
  t("rules", loadRules());
  t("cloak", refreshCloakStats());
  t("tls", loadTls());
  t("cert", api("/api/cert")).then((cert) => {
    if (cert) $("#certPath").textContent = cert.dir || "—";
  });
  $("#aboutVersions").textContent = `UI on ${location.host} · proxy port ${state.proxy.port}`;
  setInterval(refreshCloakStats, 4000);
})();
