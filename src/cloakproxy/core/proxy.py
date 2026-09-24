"""Runs mitmproxy in-process, with the cloak addon attached.

The proxy shares the UI's asyncio loop rather than living in a subprocess: the
interface needs to reach into a parked flow and edit it, which means holding the
actual flow object, not a copy of it that crossed a pipe.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Optional

from mitmproxy import options
from mitmproxy.tools.dump import DumpMaster

from cloakproxy.core.recorder import Recorder
from cloakproxy.core.rules import MatchReplace

LOG = logging.getLogger("cloak")

DEFAULT_PORT = 8080
DEFAULT_MODE = "auto"          # auto | mirror | static  (see mitmcloak)
DEFAULT_PRESET = "ios-safari-18"


def available_presets() -> list[str]:
    try:
        import httpcloak  # pylint: disable=import-outside-toplevel
        return sorted(httpcloak.available_presets())
    except Exception:  # pylint: disable=broad-except
        return [DEFAULT_PRESET]


class ProxyManager:
    """Start/stop the proxy and own the flow store."""

    def __init__(self, emit: Callable[[str, dict], None]):
        self.emit = emit
        self.recorder = Recorder(emit)
        self.rules = MatchReplace()
        self.master: Optional[DumpMaster] = None
        self._task: Optional[asyncio.Task] = None
        self.port = DEFAULT_PORT
        self.mode = DEFAULT_MODE
        self.preset = DEFAULT_PRESET
        self.allow_hosts = ""
        self.error: str = ""

    @property
    def running(self) -> bool:
        return self.master is not None and self._task is not None and not self._task.done()

    def state(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "port": self.port,
            "mode": self.mode,
            "preset": self.preset,
            "allow_hosts": self.allow_hosts,
            "presets": available_presets(),
            "flows": len(self.recorder.flows),
            "paused": len(self.recorder.paused),
            "intercept": self.recorder.intercept_enabled,
            "intercept_filter": self.recorder.intercept_filter,
            "error": self.error,
        }

    async def start(self, *, port: int = 0, mode: str = "", preset: str = "",
                    allow_hosts: str = "") -> dict[str, Any]:
        if self.running:
            return self.state()
        self.port = int(port or self.port)
        self.mode = mode or self.mode
        self.preset = preset or self.preset
        self.allow_hosts = allow_hosts if allow_hosts is not None else self.allow_hosts
        self.error = ""

        opts = options.Options(listen_host="0.0.0.0", listen_port=self.port)
        # no termlog/dumper: this process talks to a browser, not a terminal
        self.master = DumpMaster(opts, with_termlog=False, with_dumper=False)

        from mitmcloak import Bridge  # pylint: disable=import-outside-toplevel
        # Order matters. The cloak's bridge performs the upstream request itself, so
        # a rewrite registered after it would be recorded as a "hit" and still go out
        # unchanged. Rules first, then the bridge, then the recorder — which leaves
        # history showing exactly what left the machine.
        self.master.addons.add(self.rules, Bridge(), self.recorder)
        # the cloak's options only exist once its addon is loaded
        update: dict[str, Any] = {"mitmcloak_mode": self.mode,
                                  "mitmcloak_preset": self.preset}
        if self.allow_hosts.strip():
            update["allow_hosts"] = [h.strip() for h in self.allow_hosts.split(",") if h.strip()]
        try:
            self.master.options.update(**update)
        except Exception as exc:  # pylint: disable=broad-except
            LOG.warning("cloak options rejected (%s) — running without them", exc)

        async def _run() -> None:
            try:
                await self.master.run()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pylint: disable=broad-except
                self.error = f"{type(exc).__name__}: {exc}"
                LOG.exception("proxy stopped")
                self.emit("proxy", {"running": False, "error": self.error})

        self._task = asyncio.create_task(_run())
        await asyncio.sleep(0.4)          # let it bind, so the UI reports the truth
        if self._task.done() and self._task.exception():
            exc = self._task.exception()
            self.error = f"{type(exc).__name__}: {exc}"
            self.master = None
        self.emit("proxy", self.state())
        return self.state()

    async def stop(self) -> dict[str, Any]:
        if self.master is not None:
            self.master.shutdown()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # pylint: disable=broad-except
                pass
        self.master, self._task = None, None
        self.emit("proxy", self.state())
        return self.state()

    async def replay(self, flow_id: str) -> Optional[str]:
        """Send a flow again. Returns the new flow's id so the caller can watch it."""
        flow = self.recorder.get(flow_id)
        if flow is None or self.master is None:
            return None
        copy = flow.copy()
        copy.response = None
        copy.id = copy.id if copy.id != flow.id else None or copy.id
        self.master.commands.call("replay.client", [copy])
        return copy.id

    async def send(self, flow_id: str, *, method: str = "", url: str = "",
                   headers: Optional[list] = None, body: Optional[str] = None
                   ) -> Optional[str]:
        """Repeater: send an edited copy, leaving the original untouched.

        A copy rather than the flow itself, so the history keeps what really
        happened and the tab keeps what you are experimenting with.
        """
        flow = self.recorder.get(flow_id)
        if flow is None or self.master is None:
            return None
        copy = flow.copy()
        copy.response = None
        if method:
            copy.request.method = method.strip().upper()
        if url:
            copy.request.url = url.strip()
        if headers is not None:
            copy.request.headers.clear()
            for k, v in headers:
                if k:
                    copy.request.headers.add(k, v)
        if body is not None:
            copy.request.content = body.encode("utf-8")
            if "content-length" in copy.request.headers:
                copy.request.headers["content-length"] = str(len(copy.request.content))
        self.master.commands.call("replay.client", [copy])
        return copy.id
