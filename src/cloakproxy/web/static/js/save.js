/* Autosave for an open project.

   Opening a project and then editing it — adding notes, marking, capturing more
   — should not mean re-typing the name and pressing Save. Once a project is
   open, changes are written back to it on a timer, and the title bar says when
   that last happened. A fresh capture with no project yet isn't autosaved (there
   is nowhere to save it); Save Project names it, and from then on it autosaves. */
import { $, api, state, toast } from "./core.js";

let timer = null;

/** Note that something changed, so the next autosave tick has work to do. */
export function markDirty() {
  if (!state.project) return;          // nothing to save into yet
  state.dirty = true;
  paintSaveState();
}

/** Record which project is now open (after Open, or after a first Save). */
export function openedProject(name) {
  state.project = name || null;
  state.dirty = false;
  state.savedAt = name ? Date.now() : null;
  paintSaveState();
}

export async function saveNow() {
  if (!state.project || saveNow.busy) return;
  saveNow.busy = true;
  paintSaveState("saving");
  try {
    const r = await api("/api/projects", {
      method: "POST", body: { action: "save", name: state.project },
    });
    if (r && r.project) { state.dirty = false; state.savedAt = Date.now(); }
    else if (r && r.error) toast(r.error, true);
  } catch (e) {
    toast("Autosave failed — " + e.message, true);
  } finally {
    saveNow.busy = false;
    paintSaveState();
  }
}

function hhmmss(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit",
                                               second: "2-digit" });
}

function paintSaveState(mode) {
  const el = $("#saveState");
  if (!el) return;
  el.classList.toggle("hidden", !state.project);
  if (!state.project) return;
  if (mode === "saving") { el.textContent = "Saving…"; el.className = "savestate saving"; return; }
  if (state.dirty) {
    el.textContent = `${state.project} · unsaved`;
    el.className = "savestate dirty";
  } else {
    el.textContent = `${state.project} · saved ${state.savedAt ? hhmmss(state.savedAt) : ""}`;
    el.className = "savestate";
  }
}

export function initAutosave() {
  paintSaveState();
  $("#saveState").onclick = saveNow;
  // write back every 15s if there's anything to write; the save itself is a
  // fraction of a second even for a large capture
  timer = setInterval(() => { if (state.project && state.dirty) saveNow(); }, 15000);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (state.project) saveNow();
      else toast("Save this as a project first (Projects tab)", true);
    }
  });
  // a best-effort final save when the window is closing
  window.addEventListener("beforeunload", () => {
    if (state.project && state.dirty) navigator.sendBeacon?.(
      "/api/projects", new Blob([JSON.stringify({ action: "save", name: state.project })],
      { type: "application/json" }));
  });
}
