"""The mitmproxy addon behind the UI: keeps flows, streams events, holds intercepts.

Everything the interface shows comes through here. mitmproxy hands us a flow at
each stage of its life; we keep a summary for the list, the whole flow for the
detail pane, and — when intercept is armed — park the flow until someone decides
what to do with it.
"""
from __future__ import annotations

import base64
import time
from collections import OrderedDict
from typing import Any, Callable, Optional

from mitmproxy import http

MAX_FLOWS = 5000          # ring buffer; a long session shouldn't eat the machine
BODY_PREVIEW = 2_000_000  # 2 MB of body kept for display


def _headers(msg) -> list[list[str]]:
    return [[k, v] for k, v in msg.headers.items(multi=True)] if msg else []


def _body(msg) -> dict[str, Any]:
    """A body the UI can show: text when it is text, base64 when it isn't."""
    if msg is None:
        return {"text": "", "encoding": None, "size": 0, "truncated": False}
    try:
        raw = msg.get_content(strict=False) or b""
    except Exception:  # pylint: disable=broad-except
        raw = b""
    size = len(raw)
    clipped = raw[:BODY_PREVIEW]
    try:
        return {"text": clipped.decode("utf-8"), "encoding": "utf-8", "size": size,
                "truncated": size > len(clipped)}
    except UnicodeDecodeError:
        return {"text": base64.b64encode(clipped).decode("ascii"), "encoding": "base64",
                "size": size, "truncated": size > len(clipped)}


def summarize(flow: http.HTTPFlow, *, state: str = "") -> dict[str, Any]:
    """The one-line form the flow table renders."""
    req, resp = flow.request, flow.response
    started = getattr(req, "timestamp_start", None) or time.time()
    took = None
    if resp is not None and getattr(resp, "timestamp_end", None):
        took = int((resp.timestamp_end - started) * 1000)
    return {
        "id": flow.id,
        "state": state or ("error" if flow.error else
                           "complete" if resp is not None else "pending"),
        "method": req.method,
        "scheme": req.scheme,
        "host": req.pretty_host,
        "port": req.port,
        "path": req.path,
        "url": req.pretty_url,
        "status": resp.status_code if resp else None,
        "reason": resp.reason if resp else (flow.error.msg if flow.error else ""),
        "mime": (resp.headers.get("content-type", "").split(";")[0] if resp else ""),
        "size": len(resp.raw_content or b"") if resp and resp.raw_content else 0,
        "ms": took,
        "started": started,
        "intercepted": bool(flow.intercepted),
        "replay": flow.is_replay or "",
        "comment": flow.comment or "",
        "marked": flow.marked or "",
        # what the cloak actually presented upstream for THIS request, so the
        # interface never has to guess which identity was used
        "cloak": cloak_info(flow),
    }


# Set by the proxy once the cloak's addon exists: says which client a mirrored
# fingerprint was recognised as, so a flow reads "chrome-151-windows" rather
# than "mc-6b4ed3697900". Empty when the client wasn't recognised — the mirror
# still carries its real handshake, there's just no name for it.
name_preset: Callable[[str, Any], Any] = lambda name, flow=None: (name, "preset")


def _labelled(preset: str, flow: http.HTTPFlow) -> tuple[str, str]:
    """Name this flow's client, and keep the answer with the flow.

    Naming an unrecognised stack reads the captured handshake, which the cloak
    holds only while that connection is open. The first look happens as the
    response arrives, when it's still there; a later look — rendering the table,
    reopening a project — would find nothing and quietly come back empty.
    """
    meta = flow.metadata if flow.metadata is not None else {}
    kept = meta.get("cloak_label")
    if kept:
        return str(kept[0]), str(kept[1])
    try:
        text, source = name_preset(preset, flow)
    except Exception:  # pylint: disable=broad-except
        return preset, ""
    text, source = str(text or ""), str(source or "")
    if text:
        meta["cloak_label"] = (text, source)
    return text, source


def cloak_info(flow: http.HTTPFlow) -> dict[str, Any]:
    """mitmcloak's own record of the upstream leg, if it handled this one."""
    meta = (flow.metadata or {}).get("mitmcloak") or {}
    if not meta:
        return {}
    preset = meta.get("preset") or ""
    label, source = _labelled(preset, flow)
    return {
        "via": meta.get("via", ""),          # "mirror" = the client's own handshake
        "preset": preset,                    # the exact identity, minted or built in
        "label": label,                      # what that identity is, readably
        "label_source": source,              # and how well we actually know it
        "upstream": meta.get("upstream") or "",
        "ms": meta.get("ms"),
    }


def detail(flow: http.HTTPFlow) -> dict[str, Any]:
    """Everything the detail pane needs, including bodies."""
    d = summarize(flow)
    d["request"] = {
        "method": flow.request.method,
        "url": flow.request.pretty_url,
        "http_version": flow.request.http_version,
        "headers": _headers(flow.request),
        "body": _body(flow.request),
    }
    d["response"] = None
    if flow.response is not None:
        d["response"] = {
            "status": flow.response.status_code,
            "reason": flow.response.reason,
            "http_version": flow.response.http_version,
            "headers": _headers(flow.response),
            "body": _body(flow.response),
        }
    d["error"] = flow.error.msg if flow.error else None
    # what the cloak actually presented upstream, when it says
    d["cloak"] = cloak_info(flow)
    return d


class Recorder:
    """Addon: the bridge between mitmproxy's event hooks and the UI."""

    def __init__(self, emit: Callable[[str, dict], None]):
        self._emit = emit
        self.flows: "OrderedDict[str, http.HTTPFlow]" = OrderedDict()
        self.intercept_enabled = False
        self.intercept_filter = ""      # substring of the URL; empty means everything
        self.paused: dict[str, http.HTTPFlow] = {}
        self._blobs: dict[str, tuple[bool, str]] = {}   # id -> (had_response, search text)

    # ── storage ──────────────────────────────────────────────────────────────
    def _keep(self, flow: http.HTTPFlow) -> None:
        self.flows[flow.id] = flow
        self.flows.move_to_end(flow.id)
        while len(self.flows) > MAX_FLOWS:
            old, _ = self.flows.popitem(last=False)
            self.paused.pop(old, None)

    def get(self, flow_id: str) -> Optional[http.HTTPFlow]:
        return self.flows.get(flow_id)

    def search_blob(self, flow: http.HTTPFlow) -> str:
        """The whole flow as one lowercased string, for full-text search.

        Method, URL, status, every header (so cookies are in here too) and both
        bodies. Built once and cached off to the side — not on the flow, which
        would write this whole thing into a saved project — and rebuilt only when
        the response has since arrived, since searching all of it on every
        keystroke would otherwise decode every body each time.
        """
        has_resp = flow.response is not None
        cached = self._blobs.get(flow.id)
        if cached is not None and cached[0] == has_resp:
            return cached[1]
        parts = [flow.request.method, flow.request.pretty_url]
        for k, v in flow.request.headers.items(multi=True):
            parts.append(f"{k}: {v}")
        try:
            parts.append((flow.request.get_text(strict=False) or "")[:32768])
        except Exception:  # pylint: disable=broad-except
            pass
        if has_resp:
            parts.append(str(flow.response.status_code))
            for k, v in flow.response.headers.items(multi=True):
                parts.append(f"{k}: {v}")
            try:
                parts.append((flow.response.get_text(strict=False) or "")[:32768])
            except Exception:  # pylint: disable=broad-except
                pass
        blob = "\n".join(parts).lower()
        self._blobs[flow.id] = (has_resp, blob)
        return blob

    def mark(self, ids: list[str], colour: str) -> int:
        """Highlight flows. mitmproxy keeps `marked` on the flow, so a colour
        survives being written to a project and read back."""
        n = 0
        for fid in ids:
            flow = self.flows.get(fid)
            if flow is None:
                continue
            flow.marked = colour or ""
            n += 1
            self._emit("marked", summarize(flow))
        return n

    def note(self, ids: list[str], text: str) -> int:
        """Attach a note to flows. mitmproxy's own `comment` field holds it, so
        the note is written into the project and comes back with it."""
        n = 0
        for fid in ids:
            flow = self.flows.get(fid)
            if flow is None:
                continue
            flow.comment = text or ""
            n += 1
            self._emit("marked", summarize(flow))   # same lightweight row refresh
        return n

    def clear(self) -> None:
        self.flows.clear()
        self.paused.clear()
        self._blobs.clear()

    def matches_intercept(self, flow: http.HTTPFlow) -> bool:
        if not self.intercept_enabled:
            return False
        needle = self.intercept_filter.strip().lower()
        return not needle or needle in flow.request.pretty_url.lower()

    # ── mitmproxy hooks ──────────────────────────────────────────────────────
    def request(self, flow: http.HTTPFlow) -> None:
        self._keep(flow)
        if self.matches_intercept(flow):
            # park it: mitmproxy holds the connection open until we resume or kill
            flow.intercept()
            self.paused[flow.id] = flow
            self._emit("intercepted", summarize(flow, state="paused"))
            return
        self._emit("request", summarize(flow))

    def response(self, flow: http.HTTPFlow) -> None:
        self._keep(flow)
        self._emit("response", summarize(flow))

    def error(self, flow: http.HTTPFlow) -> None:
        self._keep(flow)
        self._emit("error", summarize(flow, state="error"))

    # ── intercept control, called from the UI ────────────────────────────────
    def resume(self, flow_id: str) -> bool:
        flow = self.paused.pop(flow_id, None)
        if flow is None:
            return False
        flow.resume()
        self._emit("resumed", summarize(flow))
        return True

    def drop(self, flow_id: str) -> bool:
        flow = self.paused.pop(flow_id, None)
        if flow is None:
            return False
        flow.kill()
        self._emit("dropped", summarize(flow, state="error"))
        return True

    def edit(self, flow_id: str, *, method: str = "", url: str = "",
             headers: Optional[list] = None, body: Optional[str] = None) -> bool:
        """Rewrite a parked request before it goes on."""
        flow = self.paused.get(flow_id) or self.flows.get(flow_id)
        if flow is None:
            return False
        if method:
            flow.request.method = method
        if url:
            flow.request.url = url
        if headers is not None:
            flow.request.headers.clear()
            for k, v in headers:
                if k:
                    flow.request.headers.add(k, v)
        if body is not None:
            flow.request.content = body.encode("utf-8")
            if "content-length" in flow.request.headers:
                flow.request.headers["content-length"] = str(len(flow.request.content))
        self._emit("edited", summarize(flow))
        return True
