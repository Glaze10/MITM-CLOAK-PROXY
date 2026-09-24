"""HAR 1.2 in and out.

Out: whatever the flow list is showing, as a file Chrome DevTools, Charles,
Proxyman and Burp all open. In: someone else's capture, viewable in the same UI
as a live session — handy for reading a capture you were sent.
"""
from __future__ import annotations

import base64
import json
from datetime import datetime, timezone
from typing import Any, Iterable

from mitmproxy import http

HAR_VERSION = "1.2"


def _iso(ts: float | None) -> str:
    return datetime.fromtimestamp(ts or 0, timezone.utc).isoformat()


def _headers(pairs) -> list[dict[str, str]]:
    return [{"name": k, "value": v} for k, v in pairs]


def _query(url: str) -> list[dict[str, str]]:
    from urllib.parse import parse_qsl, urlsplit  # pylint: disable=import-outside-toplevel
    return [{"name": k, "value": v} for k, v in parse_qsl(urlsplit(url).query)]


def _content(msg) -> dict[str, Any]:
    if msg is None:
        return {"size": 0, "mimeType": "", "text": ""}
    try:
        raw = msg.get_content(strict=False) or b""
    except Exception:  # pylint: disable=broad-except
        raw = b""
    mime = msg.headers.get("content-type", "")
    try:
        return {"size": len(raw), "mimeType": mime, "text": raw.decode("utf-8")}
    except UnicodeDecodeError:
        return {"size": len(raw), "mimeType": mime, "encoding": "base64",
                "text": base64.b64encode(raw).decode("ascii")}


def flow_to_entry(flow: http.HTTPFlow) -> dict[str, Any]:
    req, resp = flow.request, flow.response
    started = getattr(req, "timestamp_start", None) or 0
    ended = getattr(resp, "timestamp_end", None) if resp else None
    took = int(((ended or started) - started) * 1000)
    post = None
    body = _content(req)
    if body["size"]:
        post = {"mimeType": body["mimeType"] or "application/octet-stream",
                "text": body["text"]}
    return {
        "startedDateTime": _iso(started),
        "time": took,
        "request": {
            "method": req.method, "url": req.pretty_url,
            "httpVersion": req.http_version,
            "headers": _headers(req.headers.items(multi=True)),
            "queryString": _query(req.pretty_url), "cookies": [],
            "headersSize": -1, "bodySize": body["size"],
            **({"postData": post} if post else {}),
        },
        "response": ({
            "status": resp.status_code, "statusText": resp.reason,
            "httpVersion": resp.http_version,
            "headers": _headers(resp.headers.items(multi=True)), "cookies": [],
            "content": _content(resp), "redirectURL": resp.headers.get("location", ""),
            "headersSize": -1, "bodySize": len(resp.raw_content or b""),
        } if resp else {
            "status": 0, "statusText": (flow.error.msg if flow.error else "NO RESPONSE"),
            "httpVersion": "", "headers": [], "cookies": [],
            "content": {"size": 0, "mimeType": "text/plain",
                        "text": f"request failed: {flow.error.msg}" if flow.error else ""},
            "redirectURL": "", "headersSize": -1, "bodySize": 0,
        }),
        "cache": {},
        "timings": {"send": 0, "wait": took, "receive": 0},
        "_cloak": {"id": flow.id, "replay": flow.is_replay or "",
                   "comment": flow.comment or ""},
    }


def export(flows: Iterable[http.HTTPFlow], *, creator: str = "Cloak") -> dict[str, Any]:
    return {"log": {"version": HAR_VERSION,
                    "creator": {"name": creator, "version": "1.0"},
                    "entries": [flow_to_entry(f) for f in flows]}}


def write(path: str, flows: Iterable[http.HTTPFlow]) -> int:
    data = export(flows)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1)
    return len(data["log"]["entries"])


# ── import ───────────────────────────────────────────────────────────────────
def read(path_or_text: str) -> list[dict[str, Any]]:
    """A HAR file -> the flat shape the UI renders, without pretending it's live.

    Imported entries are read-only: there is no connection behind them, so they
    can be inspected and exported again but not resumed or replayed.
    """
    if path_or_text.lstrip().startswith("{"):
        data = json.loads(path_or_text)
    else:
        with open(path_or_text, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    out: list[dict[str, Any]] = []
    for i, e in enumerate(data.get("log", {}).get("entries", [])):
        req, resp = e.get("request", {}), e.get("response", {}) or {}
        url = req.get("url", "")
        from urllib.parse import urlsplit  # pylint: disable=import-outside-toplevel
        parts = urlsplit(url)
        content = resp.get("content", {}) or {}
        out.append({
            "id": (e.get("_cloak", {}) or {}).get("id") or f"har-{i}",
            "imported": True,
            "state": "complete" if resp.get("status") else "error",
            "method": req.get("method", ""), "scheme": parts.scheme,
            "host": parts.hostname or "", "port": parts.port or 0,
            "path": parts.path + (("?" + parts.query) if parts.query else ""),
            "url": url,
            "status": resp.get("status") or None,
            "reason": resp.get("statusText", ""),
            "mime": (content.get("mimeType", "") or "").split(";")[0],
            "size": content.get("size", 0) or 0,
            "ms": e.get("time"),
            "started": 0, "intercepted": False, "replay": "", "comment": "", "marked": "",
            "request": {"method": req.get("method", ""), "url": url,
                        "http_version": req.get("httpVersion", ""),
                        "headers": [[h.get("name", ""), h.get("value", "")]
                                    for h in req.get("headers", [])],
                        "body": {"text": (req.get("postData", {}) or {}).get("text", ""),
                                 "encoding": "utf-8",
                                 "size": req.get("bodySize", 0) or 0,
                                 "truncated": False}},
            "response": ({"status": resp.get("status"), "reason": resp.get("statusText", ""),
                          "http_version": resp.get("httpVersion", ""),
                          "headers": [[h.get("name", ""), h.get("value", "")]
                                      for h in resp.get("headers", [])],
                          "body": {"text": content.get("text", ""),
                                   "encoding": content.get("encoding") or "utf-8",
                                   "size": content.get("size", 0) or 0,
                                   "truncated": False}} if resp else None),
            "error": None, "tls": {},
        })
    return out
