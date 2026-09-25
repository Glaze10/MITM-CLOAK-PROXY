/* Proxy settings, the fingerprint explainer, and saved projects.
   The fingerprint half exists because "which identity is actually going out?"
   is the question this whole tool is for, and a dropdown next to a mode
   selector answers it ambiguously. */
import { $, $$, api, esc, state, toast } from "./core.js";
import { loadFlows } from "./flows.js";

const dismissed = new Set();      // notices this session has been told to stop showing

/* ── which TLS identity is in play ───────────────────────────────────── */
export function paintIdentity(s = state.proxy) {
  const mode = s.mode || "auto";
  const mirroring = mode !== "static";
  const value = $("#idValue");

  // the title bar always says what will go out, in words, not settings
  const said = mirroring ? "mirroring the client" : `custom · ${s.preset || "—"}`;
  if (value.textContent && value.textContent !== said) {
    const pill = $("#identity");            // acknowledge the change, briefly
    pill.classList.remove("changed");
    void pill.offsetWidth;                  // restart the animation
    pill.classList.add("changed");
  }
  value.textContent = said;
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
  // A fingerprint the cloak can't complete fails every request, and the app has
  // no console to notice that in — so the warning goes where the choice is made.
  // It can be dismissed: some of these are advisories that stay true for the
  // whole session, and a warning that can't be put away stops being read.
  const box = $("#cloakNotices");
  const notices = (c.notices || []).filter((n) => !dismissed.has(n.text));
  const sig = notices.map((n) => n.text).join(" ");
  if (sig !== box.dataset.sig) {
    box.innerHTML = notices.map((n) => `<p class="notice ${esc(n.level)}">
      <span>${esc(n.text)}</span>
      <button class="x" title="Dismiss" data-drop="${esc(n.text)}">×</button></p>`).join("");
    box.dataset.sig = sig;
  }
  box.classList.toggle("hidden", !notices.length);
}

/* ── proxy settings ──────────────────────────────────────────────────── */
export function paintSettings(s = state.proxy) {
  $("#setPort").value = s.port ?? 8080;
  $("#setAllow").value = s.allow_hosts || "";
  // A pinned fingerprint is often one mirrored from a device, which isn't in the
  // built-in list — it still has to appear here, or the control would name a
  // different identity than the one actually going out.
  const sel = $("#setPreset");
  const names = [...(s.presets || [])];
  if (s.preset && !names.includes(s.preset)) names.unshift(s.preset);
  if (names.join("|") !== sel.dataset.names) {
    sel.innerHTML = names.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
    sel.dataset.names = names.join("|");
  }
  sel.value = s.preset || "";
  const radio = $(`#modeChoices input[value="${s.mode || "auto"}"]`);
  if (radio) radio.checked = true;
  $("#interceptOn").checked = !!s.intercept;
  $("#interceptFilter").value = s.intercept_filter || "";
  paintIdentity(s);
}

/** The identity: applied on the running proxy, no restart, no waiting. */
async function applyIdentity(patch = {}) {
  const body = {
    mode: $('#modeChoices input:checked')?.value || "auto",
    preset: $("#setPreset").value,
    ...patch,
  };
  // Paint first. The answer is never in doubt — the server is being told, not
  // asked — and waiting a round trip to move a radio button is what made this
  // feel slow.
  paintIdentity({ ...state.proxy, ...body });
  state.proxy = await api("/api/proxy/config", { method: "POST", body });
  paintSettings(state.proxy);
}

/** The listener: a new port genuinely needs the proxy rebuilt. */
async function applyListener(patch = {}) {
  const running = state.proxy.running;
  const body = {
    port: +$("#setPort").value,
    mode: $('#modeChoices input:checked')?.value || "auto",
    preset: $("#setPreset").value,
    allow_hosts: $("#setAllow").value,
    ...patch,
  };
  if (running && body.port === state.proxy.port) {      // only the host list moved
    state.proxy = await api("/api/proxy/config", { method: "POST", body });
    paintSettings(state.proxy);
    return toast("Applied");
  }
  $("#statusText").textContent = running ? "restarting…" : "starting…";
  const s = await api("/api/proxy/start", { method: "POST", body });
  state.proxy = s;
  paintSettings(s);
  if (!s.error) toast(running ? `Now listening on :${s.port}` : `Listening on :${s.port}`);
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
  // Only things that can actually be used go in the picker. The catalogue's ids
  // are observations, not presets — offering them would just produce an error.
  // Pinning restarts the proxy, and a restart starts the mirror list over — so
  // the identity currently going out can be absent from both lists. It still has
  // to be listed, and listed first, because it's the one in force.
  const mirrored = t.mirrored || [], presets = t.presets || [];
  const pinned = t.mode === "static" && t.preset
    && !mirrored.includes(t.preset) && !presets.includes(t.preset) ? [t.preset] : [];
  const groups = [
    ["In use", pinned],
    ["Mirrored from a real client this session", mirrored],
    ["Built in", presets],
  ];
  $("#tlsPicker").innerHTML = groups
    .filter(([, list]) => list.length)
    .map(([label, list]) => `<optgroup label="${esc(label)}">` +
      list.map((p) => `<option value="${esc(p)}"${p === t.preset ? " selected" : ""}>${esc(p)}</option>`)
          .join("") + `</optgroup>`).join("");

  const seen = t.observed || [];
  $("#tlsObserved").innerHTML = seen.length
    ? `<h4 class="sec">Clients seen</h4>` + seen.map((c) => {
        const bits = [`${c.conns ?? 0} conn${c.conns === 1 ? "" : "s"}`,
                      `${c.reqs ?? 0} req${c.reqs === 1 ? "" : "s"}`];
        if (c.refused) bits.push(`${c.refused} refused`);
        return `<div class="seenRow"><code>${esc(c.id)}</code>
          <span>${bits.join(" · ")}${(c.flags || []).length
            ? " · " + esc(c.flags.join(" ")) : ""}</span>
          <span class="dimmed">${esc((c.hosts || []).join(", "))}</span></div>`;
      }).join("")
    : "";
  if (t.error) toast(t.error, true);
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
    await applyIdentity({ mode: "static", preset: name });
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
  $("#cloakNotices").addEventListener("click", (e) => {
    const drop = e.target.closest("[data-drop]");
    if (!drop) return;
    dismissed.add(drop.dataset.drop);
    refreshCloakStats();
  });
  $$("#modeChoices input").forEach((r) => {
    r.onchange = () => applyIdentity();
  });
  $("#setPreset").onchange = () => applyIdentity();
  $("#setPort").onchange = () => applyListener();
  $("#setAllow").onchange = () => applyListener();

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
