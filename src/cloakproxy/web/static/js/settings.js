/* Proxy settings, the fingerprint explainer, and saved projects.
   The fingerprint half exists because "which identity is actually going out?"
   is the question this whole tool is for, and a dropdown next to a mode
   selector answers it ambiguously. */
import { $, $$, api, esc, state, toast } from "./core.js";
import { loadFlows } from "./flows.js";

/* ── which TLS identity is in play ───────────────────────────────────── */
export function paintIdentity(s = state.proxy) {
  const mode = s.mode || "auto";
  const mirroring = mode !== "static";
  const value = $("#idValue");

  // the title bar always says what will go out, in words, not settings
  value.textContent = mirroring ? "mirroring the client" : `custom · ${s.preset || "—"}`;
  value.classList.toggle("fallback", !mirroring);
  $("#identity").title = mirroring
    ? `Each connection goes out with the client's own TLS fingerprint.\n` +
      `${s.preset || "the preset"} is only used if a handshake can't be mirrored.`
    : `Every connection goes out as ${s.preset}, whatever the client really is.`;

  // the preset control dims when it is only a fallback, and says so
  $$("#modeChoices label").forEach((l) =>
    l.classList.toggle("on", l.querySelector("input").value === mode));
  const field = $("#presetField");
  field.classList.toggle("dimmed", mirroring);
  $("#presetLabel").textContent = mirroring ? "Fallback preset" : "Preset (in use)";
  $("#presetHint").innerHTML = mirroring
    ? `Not used while mirroring works. It's the identity Cloak falls back to when
       there's no client handshake to copy — behind another proxy, for instance.`
    : `<b>In use for every connection.</b> The client's real fingerprint is ignored.`;
}

export async function refreshCloakStats() {
  const c = await api("/api/cloak");
  $("#statMirrored").textContent = c.mirrored ?? 0;
  $("#statStatic").textContent = c.static ?? 0;
}

/* ── proxy settings ──────────────────────────────────────────────────── */
export function paintSettings(s = state.proxy) {
  $("#setPort").value = s.port ?? 8080;
  $("#setAllow").value = s.allow_hosts || "";
  const sel = $("#setPreset");
  if ((s.presets || []).length && sel.options.length !== s.presets.length) {
    sel.innerHTML = s.presets.map((p) =>
      `<option value="${esc(p)}"${p === s.preset ? " selected" : ""}>${esc(p)}</option>`).join("");
  }
  const radio = $(`#modeChoices input[value="${s.mode || "auto"}"]`);
  if (radio) radio.checked = true;
  $("#interceptOn").checked = !!s.intercept;
  $("#interceptFilter").value = s.intercept_filter || "";
  paintIdentity(s);
}

/** Settings that only bite on the next start are applied by restarting. */
async function applyAndMaybeRestart(patch) {
  const running = state.proxy.running;
  if (running) await api("/api/proxy/stop", { method: "POST" });
  const s = await api("/api/proxy/start", {
    method: "POST",
    body: {
      port: +$("#setPort").value,
      mode: $('#modeChoices input:checked')?.value || "auto",
      preset: $("#setPreset").value,
      allow_hosts: $("#setAllow").value,
      ...patch,
    },
  });
  state.proxy = s;
  paintSettings(s);
  toast(running ? "Restarted with the new settings" : "Started");
}

/* ── projects ────────────────────────────────────────────────────────── */
export async function loadProjects() {
  const { projects, root } = await api("/api/projects");
  $("#projectList").innerHTML = projects.length ? projects.map((p) => `
    <div class="project">
      <h4>${esc(p.name)}</h4>
      <div class="meta">${p.flows} flows · ${esc(p.saved || "")}<br>
        ${(p.size / 1024).toFixed(0)} KB</div>
      <button data-open="${esc(p.name)}" class="primary">Open</button>
      <button data-del="${esc(p.name)}" class="danger">Delete</button>
    </div>`).join("")
    : `<p class="empty">No saved projects yet. They live in <code>${esc(root)}</code>.</p>`;
}

/* ── custom fingerprints ─────────────────────────────────────────────── */
export async function loadTls() {
  const t = await api("/api/tls");
  const groups = [
    ["Seen this session (mirrored from a real client)", t.mirrored || []],
    ["Other fingerprints observed", (t.catalogue || []).filter((c) => !(t.mirrored || []).includes(c))],
    ["Built in", t.presets || []],
  ];
  $("#tlsPicker").innerHTML = groups
    .filter(([, list]) => list.length)
    .map(([label, list]) => `<optgroup label="${esc(label)}">` +
      list.map((p) => `<option value="${esc(p)}"${p === t.preset ? " selected" : ""}>${esc(p)}</option>`)
          .join("") + `</optgroup>`).join("");
  if (t.error) $("#tlsPicker").insertAdjacentHTML("afterend", "");
}

function initCustomTls() {
  const post = (body) => api("/api/tls", { method: "POST", body });

  $("#tlsUse").onclick = async () => {
    const name = $("#tlsPicker").value;
    if (!name) return;
    // using a specific fingerprint means not mirroring — say so by switching mode
    $("#setPreset").innerHTML += $("#setPreset").querySelector(`option[value="${CSS.escape(name)}"]`)
      ? "" : `<option value="${esc(name)}" selected>${esc(name)}</option>`;
    $("#setPreset").value = name;
    $('#modeChoices input[value="static"]').checked = true;
    await applyAndMaybeRestart({ mode: "static", preset: name });
    toast(`Now presenting ${name} on every connection`);
  };

  $("#tlsDescribe").onclick = async () => {
    const r = await post({ action: "describe", name: $("#tlsPicker").value });
    const box = $("#tlsJson");
    if (r.error) return toast(r.error, true);
    box.textContent = r.json || "";
    box.classList.toggle("hidden", !r.json);
  };

  $("#tlsLoad").onclick = async () => {
    const path = $("#tlsPath").value.trim();
    if (!path) return toast("Point at a preset .json file", true);
    const r = await post({ action: "load", path });
    r.error ? toast(r.error, true) : toast(r.message || "Loaded");
    loadTls();
  };

  const exportTo = async (all) => {
    const directory = $("#tlsDir").value.trim();
    if (!directory) return toast("Give a folder to write into", true);
    const r = await post({ action: "export", directory, all });
    r.error ? toast(r.error, true) : toast(r.message || "Written");
  };
  $("#tlsExport").onclick = () => exportTo(false);
  $("#tlsExportAll").onclick = () => exportTo(true);
}

export function initSettings() {
  initCustomTls();
  $$("#modeChoices input").forEach((r) => {
    r.onchange = () => { applyAndMaybeRestart({}); };
  });
  $("#setPreset").onchange = () => applyAndMaybeRestart({});
  $("#setPort").onchange = () => applyAndMaybeRestart({});
  $("#setAllow").onchange = () => applyAndMaybeRestart({});

  $("#btnCert").onclick = async () => {
    const c = await api("/api/cert");
    $("#certPath").textContent = c.dir || "—";
    if (!c.exists) return toast("Start the proxy once — the CA is created on first run", true);
    window.location = "/api/cert?download=1";
  };

  $("#setPrettyDefault").onchange = (e) => { state.prefs.pretty = e.target.checked; };
  $("#setAutoScroll").onchange = (e) => { state.prefs.follow = e.target.checked; };
  $("#setMaxRows").onchange = (e) => { state.prefs.maxRows = +e.target.value || 2000; };

  $("#btnSaveProject").onclick = async () => {
    const name = $("#projectName").value.trim();
    if (!name) return toast("Give the project a name", true);
    const r = await api("/api/projects", { method: "POST", body: { action: "save", name } });
    toast(`Saved ${r.project.flows} flows`);
    loadProjects();
  };
  $("#btnRefreshProjects").onclick = loadProjects;
  $("#projectList").addEventListener("click", async (e) => {
    const open = e.target.closest("[data-open]");
    const del = e.target.closest("[data-del]");
    if (open) {
      const r = await api("/api/projects", { method: "POST", body: { action: "load", name: open.dataset.open } });
      toast(`Loaded ${r.flows} flows`);
      await loadFlows();
      document.querySelector('.tabs.top button[data-tab="proxy"]').click();
    } else if (del) {
      if (!confirm(`Delete project "${del.dataset.del}"? The flows go with it.`)) return;
      await api("/api/projects", { method: "POST", body: { action: "delete", name: del.dataset.del } });
      loadProjects();
    }
  });
}
