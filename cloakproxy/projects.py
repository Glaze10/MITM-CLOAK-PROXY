"""Projects: a named folder holding a session's flows and its settings.

A project is a directory, not a database — flows.mitm is mitmproxy's own format,
so anything that reads mitmproxy files reads these, and a project survives this
app being uninstalled.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Iterable, Optional

from mitmproxy import io as mio
from mitmproxy import http

DEFAULT_ROOT = Path.home() / "CloakProjects"
META = "project.json"
FLOWS = "flows.mitm"


def root() -> Path:
    DEFAULT_ROOT.mkdir(parents=True, exist_ok=True)
    return DEFAULT_ROOT


def _safe(name: str) -> str:
    keep = "-_. abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    cleaned = "".join(c for c in (name or "").strip() if c in keep).strip()
    return cleaned or time.strftime("session-%Y%m%d-%H%M%S")


def list_projects() -> list[dict[str, Any]]:
    out = []
    for d in sorted(root().iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not d.is_dir():
            continue
        meta_path = d / META
        meta: dict[str, Any] = {}
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:  # pylint: disable=broad-except
                meta = {}
        flows = d / FLOWS
        out.append({
            "name": d.name,
            "path": str(d),
            "flows": meta.get("flows", 0),
            "saved": meta.get("saved", ""),
            "settings": meta.get("settings", {}),
            "size": flows.stat().st_size if flows.exists() else 0,
        })
    return out


def save(name: str, flows: Iterable[http.HTTPFlow], settings: dict[str, Any]) -> dict[str, Any]:
    d = root() / _safe(name)
    d.mkdir(parents=True, exist_ok=True)
    count = 0
    with open(d / FLOWS, "wb") as fh:
        writer = mio.FlowWriter(fh)
        for f in flows:
            try:
                writer.add(f)
                count += 1
            except Exception:  # pylint: disable=broad-except
                continue
    meta = {"name": d.name, "saved": time.strftime("%Y-%m-%d %H:%M:%S"),
            "flows": count, "settings": settings}
    (d / META).write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return {"name": d.name, "path": str(d), **meta}


def load(name: str) -> tuple[list[http.HTTPFlow], dict[str, Any]]:
    d = root() / _safe(name)
    meta: dict[str, Any] = {}
    if (d / META).exists():
        try:
            meta = json.loads((d / META).read_text(encoding="utf-8"))
        except Exception:  # pylint: disable=broad-except
            meta = {}
    flows: list[http.HTTPFlow] = []
    fp = d / FLOWS
    if fp.exists():
        with open(fp, "rb") as fh:
            for f in mio.FlowReader(fh).stream():
                if isinstance(f, http.HTTPFlow):
                    flows.append(f)
    return flows, meta


def delete(name: str) -> bool:
    d = root() / _safe(name)
    if not d.exists():
        return False
    for p in sorted(d.rglob("*"), reverse=True):
        p.unlink() if p.is_file() else p.rmdir()
    d.rmdir()
    return True
