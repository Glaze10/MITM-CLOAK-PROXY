"""The UI's backend: tornado, sharing one asyncio loop with the proxy.

Tornado rather than something newer because mitmproxy already brings it, and one
event loop means a paused flow can be edited in place instead of being marshalled
across a process boundary.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

import tornado.web
import tornado.websocket

from cloakproxy.core import filters
from cloakproxy.storage import har, projects
from cloakproxy.core.proxy import ProxyManager
from cloakproxy.core.recorder import detail, summarize

LOG = logging.getLogger("cloak")
STATIC = Path(__file__).parent / "static"


class Hub:
    """Fan-out to every open UI tab."""

    def __init__(self) -> None:
        self.clients: set["EventSocket"] = set()

    def emit(self, kind: str, payload: dict) -> None:
        dead = []
        msg = json.dumps({"type": kind, "data": payload})
        for c in self.clients:
            try:
                c.write_message(msg)
            except Exception:  # pylint: disable=broad-except
                dead.append(c)
        for c in dead:
            self.clients.discard(c)


class Base(tornado.web.RequestHandler):
    def initialize(self, proxy: ProxyManager, hub: Hub, imported: dict) -> None:  # noqa: D102
        self.proxy = proxy
        self.hub = hub
        self.imported = imported          # id -> dict, for HAR-loaded flows

    def body_json(self) -> dict[str, Any]:
        if not self.request.body:
            return {}
        try:
            return json.loads(self.request.body.decode("utf-8"))
        except ValueError:
            return {}

    def send(self, payload: Any, status: int = 200) -> None:
        self.set_status(status)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class StateHandler(Base):
    async def get(self) -> None:
        self.send(self.proxy.state())


class ProxyHandler(Base):
    async def post(self, action: str) -> None:
        body = self.body_json()
        if action == "start":
            self.send(await self.proxy.start(port=int(body.get("port") or 0),
                                             mode=body.get("mode", ""),
                                             preset=body.get("preset", ""),
                                             allow_hosts=body.get("allow_hosts", "")))
        elif action == "stop":
            self.send(await self.proxy.stop())
        else:
            self.send({"error": f"unknown action {action}"}, 404)


class FlowsHandler(Base):
    def _rows(self) -> list[dict]:
        rows = [summarize(f) for f in self.proxy.recorder.flows.values()]
        rows += list(self.imported.values())
        rows.sort(key=lambda r: r.get("started") or 0)
        return rows

    def get(self) -> None:
        """The flow table, narrowed by the quick box (`q`)."""
        spec = {"text": self.get_argument("q", "")}
        self._respond(spec)

    def post(self) -> None:
        """The same, narrowed by the filter dialog's full spec."""
        self._respond(self.body_json())

    def _respond(self, spec: dict) -> None:
        f = filters.Filter(spec)
        rows = [r for r in self._rows() if f.matches(r)]
        if f.needs_bodies():          # body search costs a decode, so only on demand
            keep = []
            for r in rows:
                flow = self.proxy.recorder.get(r["id"])
                if flow is None:
                    imported = self.imported.get(r["id"]) or {}
                    req = ((imported.get("request") or {}).get("body") or {}).get("text", "")
                    resp = ((imported.get("response") or {}).get("body") or {}).get("text", "")
                else:
                    d = detail(flow)
                    req = (d["request"]["body"] or {}).get("text", "")
                    resp = ((d.get("response") or {}).get("body") or {}).get("text", "")
                if f.body_matches(req, resp):
                    keep.append(r)
            rows = keep
        self.send({"flows": rows[-2000:], "total": len(rows),
                   "filtered": f.active, "chips": f.describe()})

    def delete(self) -> None:
        self.proxy.recorder.clear()
        self.imported.clear()
        self.hub.emit("cleared", {})
        self.send({"ok": True})


class FlowHandler(Base):
    def get(self, flow_id: str) -> None:
        if flow_id in self.imported:
            self.send(self.imported[flow_id])
            return
        flow = self.proxy.recorder.get(flow_id)
        if flow is None:
            self.send({"error": "no such flow"}, 404)
            return
        self.send(detail(flow))

    async def post(self, flow_id: str) -> None:
        """Act on a flow: resume, drop, edit or replay it."""
        body = self.body_json()
        action = body.get("action", "")
        rec = self.proxy.recorder
        if action == "resume":
            ok = rec.resume(flow_id)
        elif action == "drop":
            ok = rec.drop(flow_id)
        elif action == "edit":
            ok = rec.edit(flow_id, method=body.get("method", ""), url=body.get("url", ""),
                          headers=body.get("headers"), body=body.get("body"))
            if ok and body.get("then_resume"):
                rec.resume(flow_id)
        elif action == "replay":
            ok = bool(await self.proxy.replay(flow_id))
        else:
            self.send({"error": f"unknown action {action}"}, 400)
            return
        self.send({"ok": ok})


class MarkHandler(Base):
    def post(self) -> None:
        body = self.body_json()
        n = self.proxy.recorder.mark(body.get("ids") or [], body.get("colour", ""))
        self.send({"ok": True, "marked": n})


class InterceptHandler(Base):
    def post(self) -> None:
        body = self.body_json()
        rec = self.proxy.recorder
        if "enabled" in body:
            rec.intercept_enabled = bool(body["enabled"])
        if "filter" in body:
            rec.intercept_filter = str(body["filter"] or "")
        # turning it off shouldn't strand whatever is already parked
        if not rec.intercept_enabled:
            for fid in list(rec.paused):
                rec.resume(fid)
        self.hub.emit("proxy", self.proxy.state())
        self.send(self.proxy.state())


class HarHandler(Base):
    def get(self) -> None:
        """Download flows as a HAR — everything, or just the ids asked for."""
        wanted = [i for i in (self.get_argument("ids", "") or "").split(",") if i]
        store = self.proxy.recorder.flows
        flows = [store[i] for i in wanted if i in store] if wanted else list(store.values())
        name = self.get_argument("name", "cloak.har")
        self.set_header("Content-Type", "application/json")
        self.set_header("Content-Disposition", f'attachment; filename="{name}"')
        self.finish(json.dumps(har.export(flows), indent=1))

    def post(self) -> None:
        """Load a HAR someone sent you into the same viewer."""
        body = self.body_json()
        src = body.get("path") or body.get("text") or ""
        if not src:
            self.send({"error": "give a path or the file's text"}, 400)
            return
        try:
            rows = har.read(src)
        except Exception as exc:  # pylint: disable=broad-except
            self.send({"error": f"{type(exc).__name__}: {exc}"}, 400)
            return
        for r in rows:
            self.imported[r["id"]] = r
        self.hub.emit("imported", {"count": len(rows)})
        self.send({"ok": True, "imported": len(rows)})


class ProjectsHandler(Base):
    def get(self) -> None:
        self.send({"projects": projects.list_projects(), "root": str(projects.root())})

    async def post(self) -> None:
        body = self.body_json()
        action, name = body.get("action", "save"), body.get("name", "")
        if action == "save":
            meta = projects.save(name, self.proxy.recorder.flows.values(),
                                 {"port": self.proxy.port, "mode": self.proxy.mode,
                                  "preset": self.proxy.preset})
            self.send({"ok": True, "project": meta})
        elif action == "load":
            flows, meta = projects.load(name)
            self.proxy.recorder.clear()
            for f in flows:
                self.proxy.recorder.flows[f.id] = f
            self.hub.emit("loaded", {"name": name, "flows": len(flows)})
            self.send({"ok": True, "flows": len(flows), "meta": meta})
        elif action == "delete":
            self.send({"ok": projects.delete(name)})
        else:
            self.send({"error": f"unknown action {action}"}, 400)


class CertHandler(Base):
    """Where to find the CA, and the file itself — every proxy needs this page."""

    def get(self) -> None:
        from mitmproxy.options import CONF_DIR  # pylint: disable=import-outside-toplevel
        base = Path(CONF_DIR).expanduser()
        pem = base / "mitmproxy-ca-cert.pem"
        cer = base / "mitmproxy-ca-cert.cer"
        if self.get_argument("download", ""):
            path = cer if cer.exists() else pem
            if not path.exists():
                self.send({"error": "no CA yet — start the proxy once"}, 404)
                return
            self.set_header("Content-Type", "application/x-x509-ca-cert")
            self.set_header("Content-Disposition", f'attachment; filename="{path.name}"')
            self.finish(path.read_bytes())
            return
        self.send({"dir": str(base), "pem": str(pem), "exists": pem.exists()})


class RulesHandler(Base):
    """Match & replace rules — read them, or replace the whole list."""

    def get(self) -> None:
        self.send({"rules": self.proxy.rules.list_rules()})

    def post(self) -> None:
        rules = self.proxy.rules.set_rules(self.body_json().get("rules") or [])
        self.hub.emit("rules", {"count": len(rules)})
        self.send({"ok": True, "rules": self.proxy.rules.list_rules()})


class RepeaterHandler(Base):
    """Send an edited copy of a flow and hand back the id of the new one."""

    async def post(self) -> None:
        b = self.body_json()
        new_id = await self.proxy.send(b.get("id", ""), method=b.get("method", ""),
                                       url=b.get("url", ""), headers=b.get("headers"),
                                       body=b.get("body"))
        if not new_id:
            self.send({"error": "start the proxy first, or pick a flow"}, 400)
            return
        self.send({"ok": True, "id": new_id})


class CloakHandler(Base):
    """What the cloak is doing right now — mirrored vs preset, in its own words."""

    def get(self) -> None:
        stats = ""
        master = self.proxy.master
        if master is not None:
            try:
                stats = master.commands.call("mitmcloak.stats")
            except Exception:  # pylint: disable=broad-except
                stats = ""
        mirrored = sum(1 for f in self.proxy.recorder.flows.values()
                       if ((f.metadata or {}).get("mitmcloak") or {}).get("via") == "mirror")
        presets = sum(1 for f in self.proxy.recorder.flows.values()
                      if ((f.metadata or {}).get("mitmcloak") or {}).get("via") == "static")
        self.send({"stats": stats, "mirrored": mirrored, "static": presets,
                   "mode": self.proxy.mode, "preset": self.proxy.preset})


class EventSocket(tornado.websocket.WebSocketHandler):
    def initialize(self, hub: Hub, proxy: ProxyManager) -> None:  # noqa: D102
        self.hub = hub
        self.proxy = proxy

    def check_origin(self, origin: str) -> bool:      # local UI only
        return True

    def open(self, *args: Any, **kwargs: Any) -> None:
        self.hub.clients.add(self)
        self.write_message(json.dumps({"type": "proxy", "data": self.proxy.state()}))

    def on_close(self) -> None:
        self.hub.clients.discard(self)


class IndexHandler(tornado.web.RequestHandler):
    def get(self) -> None:
        self.set_header("Cache-Control", "no-store")
        self.render(str(STATIC / "index.html"))


def make_app(proxy: ProxyManager, hub: Hub) -> tornado.web.Application:
    imported: dict[str, dict] = {}
    common = dict(proxy=proxy, hub=hub, imported=imported)
    return tornado.web.Application(
        [
            (r"/", IndexHandler),
            (r"/api/state", StateHandler, common),
            (r"/api/proxy/(start|stop)", ProxyHandler, common),
            (r"/api/flows", FlowsHandler, common),
            (r"/api/flows/([^/]+)", FlowHandler, common),
            (r"/api/intercept", InterceptHandler, common),
            (r"/api/mark", MarkHandler, common),
            (r"/api/cloak", CloakHandler, common),
            (r"/api/rules", RulesHandler, common),
            (r"/api/repeater", RepeaterHandler, common),
            (r"/api/har", HarHandler, common),
            (r"/api/projects", ProjectsHandler, common),
            (r"/api/cert", CertHandler, common),
            (r"/ws", EventSocket, dict(hub=hub, proxy=proxy)),
            (r"/static/(.*)", tornado.web.StaticFileHandler, {"path": str(STATIC)}),
        ],
        template_path=str(STATIC),
        debug=False,
    )
