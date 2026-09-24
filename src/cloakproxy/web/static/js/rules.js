/* Match & replace: a list of rewrites applied to traffic on its way through. */
import { $, api, esc, toast } from "./core.js";

let rules = [];

const WHERE = ["request", "response"];
const PARTS = ["header", "body", "url", "method", "status"];

function ruleHtml(r, i) {
  const opts = (list, sel) => list.map((v) =>
    `<option value="${v}"${v === sel ? " selected" : ""}>${v}</option>`).join("");
  return `<div class="rule" data-i="${i}">
    <div class="row">
      <label class="switch"><input type="checkbox" data-f="enabled" ${r.enabled ? "checked" : ""}> on</label>
      <input data-f="name" placeholder="what this is for" value="${esc(r.name || "")}">
      <select data-f="where">${opts(WHERE, r.where)}</select>
      <select data-f="part">${opts(PARTS, r.part)}</select>
      <label class="switch"><input type="checkbox" data-f="regex" ${r.regex ? "checked" : ""}> regex</label>
      <button data-act="del" class="danger">Remove</button>
    </div>
    <div class="row">
      <input data-f="match" placeholder="${r.part === "header" ? "header name, e.g. User-Agent" : "match"}"
             value="${esc(r.match || "")}">
      <input data-f="replace" placeholder="replace with — blank removes a header"
             value="${esc(r.replace || "")}">
    </div>
    <div class="meta">${r.hits ? `matched ${r.hits}×` : "no matches yet"}</div>
  </div>`;
}

function render() {
  $("#rules").innerHTML = rules.length
    ? rules.map(ruleHtml).join("")
    : `<p class="empty">No rules. Add one to rewrite traffic as it passes — pin a
       User-Agent, point a host at staging, strip a header that breaks a replay.</p>`;
  $("#rulesCount").textContent = rules.filter((r) => r.enabled).length;
}

function readBack() {
  rules = [...document.querySelectorAll(".rule")].map((el, i) => {
    const get = (f) => el.querySelector(`[data-f="${f}"]`);
    return {
      id: rules[i]?.id || `r${Date.now()}${i}`,
      enabled: get("enabled").checked,
      name: get("name").value,
      where: get("where").value,
      part: get("part").value,
      regex: get("regex").checked,
      match: get("match").value,
      replace: get("replace").value,
    };
  });
  return rules;
}

export async function loadRules() {
  const r = await api("/api/rules");
  rules = r.rules || [];
  render();
}

export function initRules() {
  $("#btnAddRule").onclick = () => {
    readBack();
    rules.push({ id: `r${Date.now()}`, enabled: true, where: "request", part: "header",
                 regex: true, match: "", replace: "", name: "" });
    render();
  };
  $("#rules").addEventListener("click", (e) => {
    const del = e.target.closest('[data-act="del"]');
    if (!del) return;
    readBack();
    rules.splice(+del.closest(".rule").dataset.i, 1);
    render();
  });
  $("#btnSaveRules").onclick = async () => {
    const r = await api("/api/rules", { method: "POST", body: { rules: readBack() } });
    rules = r.rules || [];
    render();
    toast(`${rules.filter((x) => x.enabled).length} rule(s) active`);
  };
}
