/* The filter dialog — several conditions at once, which a search box can't do. */
import { $, $$, MARKS, state } from "./core.js";
import { loadFlows } from "./flows.js";

const open = () => { fill(); $("#filterModal").classList.remove("hidden"); };
const close = () => $("#filterModal").classList.add("hidden");

function fill() {
  const f = state.filter || {};
  $$("#fMethods input").forEach((c) => { c.checked = (f.methods || []).includes(c.value); });
  $$("#fStatus input").forEach((c) => { c.checked = (f.status_classes || []).includes(c.value); });
  $("#fStatusMin").value = f.status_min || "";
  $("#fStatusMax").value = f.status_max || "";
  $("#fHost").value = f.host || "";
  $("#fPath").value = f.path || "";
  $("#fMime").value = f.mime || "";
  $("#fBody").value = f.body || "";
  $("#fExclude").value = (f.exclude || []).join(", ");
  $("#fNoise").checked = !!f.hide_noise;
  $("#fHasBody").checked = !!f.has_body;
  $("#fPaused").checked = !!f.only_paused;
  $("#fMarked").checked = !!f.marked_only;
  $$("#fColours input").forEach((c) => { c.checked = (f.colours || []).includes(c.value); });
}

function collect() {
  return {
    methods: $$("#fMethods input:checked").map((c) => c.value),
    status_classes: $$("#fStatus input:checked").map((c) => c.value),
    status_min: +$("#fStatusMin").value || 0,
    status_max: +$("#fStatusMax").value || 0,
    host: $("#fHost").value.trim(),
    path: $("#fPath").value.trim(),
    mime: $("#fMime").value.trim(),
    body: $("#fBody").value.trim(),
    exclude: $("#fExclude").value.split(",").map((s) => s.trim()).filter(Boolean),
    hide_noise: $("#fNoise").checked,
    has_body: $("#fHasBody").checked,
    only_paused: $("#fPaused").checked,
    marked_only: $("#fMarked").checked,
    colours: $$("#fColours input:checked").map((c) => c.value),
  };
}

export function initFilter() {
  // the colour checkboxes mirror whatever highlight colours exist
  $("#fColours").innerHTML = MARKS.map((c) =>
    `<label><input type="checkbox" value="${c}">
      <span class="markdot mark-${c}"></span> ${c}</label>`).join("");

  $("#btnFilter").onclick = open;
  $("#filterClose").onclick = close;
  $("#filterModal").addEventListener("click", (e) => {
    if (e.target.id === "filterModal") close();       // click the backdrop
  });
  $("#filterApply").onclick = async () => {
    state.filter = collect();
    close();
    await loadFlows();
  };
  $("#filterReset").onclick = async () => {
    state.filter = {};
    fill();
    close();
    await loadFlows();
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" &&
        !e.target.matches("input, textarea")) {
      e.preventDefault();
      open();
    }
  });
}
