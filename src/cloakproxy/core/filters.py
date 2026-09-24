"""The filter behind the filter dialog.

A single search box can only ever mean one thing at a time. This is the other
shape: several named conditions that all have to hold, so "POST to checkout,
4xx or 5xx, JSON only, not the analytics host" is one filter instead of four
searches done in your head.
"""
from __future__ import annotations

from typing import Any, Iterable

# things nobody is usually looking for, hidden by one checkbox
NOISE_MIMES = ("image/", "font/", "text/css", "application/javascript", "text/javascript")
NOISE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".woff",
              ".woff2", ".ttf", ".css", ".js", ".map")


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    return [str(v).strip() for v in value if str(v).strip()]


class Filter:
    """Built from the dialog's fields; asked once per row."""

    def __init__(self, spec: dict[str, Any] | None = None):
        s = spec or {}
        self.text = (s.get("text") or "").strip().lower()
        self.methods = {m.upper() for m in _as_list(s.get("methods"))}
        self.host = (s.get("host") or "").strip().lower()
        self.path = (s.get("path") or "").strip().lower()
        self.mime = (s.get("mime") or "").strip().lower()
        self.body = (s.get("body") or "").strip().lower()
        self.exclude = [e.lower() for e in _as_list(s.get("exclude"))]
        self.status_classes = {str(c)[0] for c in _as_list(s.get("status_classes"))}
        self.status_min = int(s.get("status_min") or 0)
        self.status_max = int(s.get("status_max") or 0)
        self.marked_only = bool(s.get("marked_only"))
        self.colours = {c.lower() for c in _as_list(s.get("colours"))}
        self.hide_noise = bool(s.get("hide_noise"))
        self.only_paused = bool(s.get("only_paused"))
        self.has_body = bool(s.get("has_body"))

    @property
    def active(self) -> bool:
        """Is anything actually narrowing the view? Drives the 'filtered' badge."""
        return any([self.text, self.methods, self.host, self.path, self.mime, self.body,
                    self.exclude, self.status_classes, self.status_min, self.status_max,
                    self.marked_only, self.colours, self.hide_noise, self.only_paused,
                    self.has_body])

    def describe(self) -> list[str]:
        """Short chips for the toolbar, so an active filter is never invisible."""
        out = []
        if self.text: out.append(f"“{self.text}”")
        if self.methods: out.append("/".join(sorted(self.methods)))
        if self.host: out.append(f"host~{self.host}")
        if self.path: out.append(f"path~{self.path}")
        if self.mime: out.append(f"type~{self.mime}")
        if self.body: out.append(f"body~{self.body}")
        if self.status_classes: out.append("+".join(sorted(c + "xx" for c in self.status_classes)))
        if self.status_min or self.status_max:
            out.append(f"{self.status_min or 0}-{self.status_max or 599}")
        if self.colours: out.append("·".join(sorted(self.colours)))
        elif self.marked_only: out.append("highlighted")
        if self.hide_noise: out.append("no assets")
        if self.only_paused: out.append("parked")
        if self.has_body: out.append("has body")
        for e in self.exclude: out.append(f"−{e}")
        return out

    # ── the test ─────────────────────────────────────────────────────────────
    def matches(self, row: dict[str, Any]) -> bool:
        url = (row.get("url") or "").lower()
        method = (row.get("method") or "").upper()
        mime = (row.get("mime") or "").lower()
        status = row.get("status") or 0

        if self.methods and method not in self.methods:
            return False
        if self.host and self.host not in (row.get("host") or "").lower():
            return False
        if self.path and self.path not in (row.get("path") or "").lower():
            return False
        if self.mime and self.mime not in mime:
            return False
        if self.status_classes and (not status or str(status)[0] not in self.status_classes):
            return False
        if self.status_min and status < self.status_min:
            return False
        if self.status_max and status > self.status_max:
            return False
        if self.marked_only and not row.get("marked"):
            return False
        if self.colours and (row.get("marked") or "").lower() not in self.colours:
            return False
        if self.only_paused and not (row.get("intercepted") or row.get("state") == "paused"):
            return False
        if self.has_body and not row.get("size"):
            return False
        if self.hide_noise:
            if any(mime.startswith(n) for n in NOISE_MIMES):
                return False
            if any(url.split("?")[0].endswith(e) for e in NOISE_EXTS):
                return False
        for e in self.exclude:
            if e in url:
                return False
        if self.text:
            hay = f"{method} {url} {status} {mime}"
            if self.text not in hay.lower():
                return False
        return True

    def needs_bodies(self) -> bool:
        return bool(self.body)

    def body_matches(self, req_text: str, resp_text: str) -> bool:
        if not self.body:
            return True
        return self.body in (req_text or "").lower() or self.body in (resp_text or "").lower()


def apply(rows: Iterable[dict[str, Any]], spec: dict[str, Any] | None) -> list[dict[str, Any]]:
    f = Filter(spec)
    return [r for r in rows if f.matches(r)]
