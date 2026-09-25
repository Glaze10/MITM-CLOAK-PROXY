"""Runs mitmproxy in-process, with the cloak addon attached.

The proxy shares the UI's asyncio loop rather than living in a subprocess: the
interface needs to reach into a parked flow and edit it, which means holding the
actual flow object, not a copy of it that crossed a pipe.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import deque
from typing import Any, Callable, Optional

from mitmproxy import options
from mitmproxy.tools.dump import DumpMaster

from cloakproxy.core import identify, recorder as recorder_mod
from cloakproxy.core.recorder import Recorder
from cloakproxy.core.rules import MatchReplace

LOG = logging.getLogger("cloak")

DEFAULT_PORT = 8080
DEFAULT_MODE = "auto"          # auto | mirror | static  (see mitmcloak)
DEFAULT_PRESET = "ios-safari-18"


def lan_address() -> str:
    """The address a phone on the same network should be pointed at.

    "your machine's IP" is a small chore to look up, and it's the one thing
    standing between a fresh install and traffic, so Cloak works it out.
    """
    import socket  # pylint: disable=import-outside-toplevel
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.255.255.255", 1))          # no packets, just routing
        return str(probe.getsockname()[0])
    except OSError:
        try:
            return socket.gethostbyname(socket.gethostname())
        except OSError:
            return "127.0.0.1"
    finally:
        probe.close()


def available_presets() -> list[str]:
    try:
        import httpcloak  # pylint: disable=import-outside-toplevel
        return sorted(httpcloak.available_presets())
    except Exception:  # pylint: disable=broad-except
        return [DEFAULT_PRESET]


async def _wait_for_port(port: int, timeout: float = 5.0) -> bool:
    """Poll until nothing answers on `port`, or give up.

    A trial bind would lie here: mitmproxy's listener sets SO_REUSEADDR, and on
    Windows that lets a second bind succeed while the first socket is still
    accepting. Connecting is the honest question — if it refuses, the listener
    really is gone.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection("127.0.0.1", port), timeout=0.5)
            writer.close()
        except (OSError, asyncio.TimeoutError):
            return True
        if loop.time() >= deadline:
            return False
        await asyncio.sleep(0.1)


class Notices(logging.Handler):
    """Keeps the cloak's own warnings so the interface can show them.

    These matter more than usual here. httpcloak will say things like "this
    preset offers ciphers I cannot complete" — the difference between a working
    proxy and every request failing — and in a windowed app there is no console
    for that to land in.
    """

    WATCHED = ("mitmcloak", "httpcloak")

    def __init__(self, keep: int = 20):
        super().__init__(level=logging.WARNING)
        self.records: deque[dict[str, Any]] = deque(maxlen=keep)

    def emit(self, record: logging.LogRecord) -> None:
        if not record.name.startswith(self.WATCHED):
            return
        try:
            msg = record.getMessage()
        except Exception:  # pylint: disable=broad-except
            return
        # the lazy-connection-strategy line is housekeeping, not something to report
        if "forced connection_strategy" in msg:
            return
        if self.records and self.records[-1]["text"] == msg:
            return                                   # the same warning per connection
        self.records.append({"level": record.levelname.lower(), "text": msg,
                             "at": time.time()})

    def as_list(self) -> list[dict[str, Any]]:
        return list(self.records)


class ProxyManager:
    """Start/stop the proxy and own the flow store."""

    def __init__(self, emit: Callable[[str, dict], None]):
        self.emit = emit
        self.recorder = Recorder(emit)
        self.rules = MatchReplace()
        self.master: Optional[DumpMaster] = None
        self._task: Optional[asyncio.Task] = None
        # Several listeners, each switchable. A phone, an emulator and a desktop
        # browser want different ports, and mitmproxy takes a list of modes and
        # rebinds when it changes — so a port can be added or switched off
        # without disturbing the connections on the others.
        self.ports: list[dict[str, Any]] = [{"port": DEFAULT_PORT, "on": True}]
        self.mode = DEFAULT_MODE
        self.preset = DEFAULT_PRESET
        self.allow_hosts = ""
        self.error: str = ""
        self.notices = Notices()
        self.bridge: Any = None
        self._labels: dict[str, str] = {}
        recorder_mod.name_preset = self.preset_label
        logging.getLogger().addHandler(self.notices)

    @property
    def port(self) -> int:
        """The port to quote when one has to stand for the proxy."""
        live = [p["port"] for p in self.ports if p.get("on")]
        return live[0] if live else (self.ports[0]["port"] if self.ports else DEFAULT_PORT)

    @property
    def listening(self) -> list[int]:
        return [p["port"] for p in self.ports if p.get("on")]

    def _modes(self) -> list[str]:
        return [f"regular@0.0.0.0:{p}" for p in self.listening]

    @staticmethod
    def _clean_ports(raw: Any, fallback: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Accept what the interface sends, and refuse what can't be bound."""
        out: list[dict[str, Any]] = []
        seen: set[int] = set()
        for item in raw or []:
            try:
                port = int(item["port"] if isinstance(item, dict) else item)
            except (TypeError, ValueError, KeyError):
                continue
            if not 1 <= port <= 65535 or port in seen:
                continue          # duplicates would make mitmproxy refuse the lot
            seen.add(port)
            on = bool(item.get("on", True)) if isinstance(item, dict) else True
            out.append({"port": port, "on": on})
        return out or fallback

    @property
    def running(self) -> bool:
        return self.master is not None and self._task is not None and not self._task.done()

    def state(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "port": self.port,
            "ports": [dict(p) for p in self.ports],
            "listening": self.listening,
            "mode": self.mode,
            "preset": self.preset,
            "allow_hosts": self.allow_hosts,
            "lan_ip": lan_address(),
            "presets": available_presets(),
            "flows": len(self.recorder.flows),
            "paused": len(self.recorder.paused),
            "intercept": self.recorder.intercept_enabled,
            "intercept_filter": self.recorder.intercept_filter,
            "error": self.error,
        }

    async def start(self, *, port: int = 0, ports: Any = None, mode: str = "",
                    preset: str = "", allow_hosts: Optional[str] = None) -> dict[str, Any]:
        """Start, or apply the settings to a proxy that is already running.

        Nothing here needs a rebuild any more: the listeners come from the mode
        list, which mitmproxy re-binds in place, and the cloak reads its identity
        per request. Starting a running proxy is therefore the same as
        configuring it.

        allow_hosts takes None for "leave it alone" — an empty string is a real
        value meaning "no restriction", and the title bar's Start button, which
        sends no host list at all, must not quietly clear one.
        """
        if ports is not None:
            self.ports = self._clean_ports(ports, self.ports)
        elif port:
            self.ports = [{"port": int(port), "on": True}]
        if self.running:
            return await self.configure(mode=mode or None, preset=preset or None,
                                        allow_hosts=allow_hosts, ports=None)
        self.mode = mode or self.mode
        self.preset = preset or self.preset
        self.allow_hosts = allow_hosts if allow_hosts is not None else self.allow_hosts
        self.error = ""

        # one mode per enabled port; mitmproxy binds each and rebinds on change
        opts = options.Options(mode=self._modes())
        # no termlog/dumper: this process talks to a browser, not a terminal
        self.master = DumpMaster(opts, with_termlog=False, with_dumper=False)
        # mitmproxy's errorcheck addon calls sys.exit() when startup fails, which is
        # right for a CLI and fatal here — a port already in use would take the whole
        # interface down with it. We report the failure instead.
        errorcheck = self.master.addons.get("errorcheck")
        if errorcheck is not None:
            self.master.addons.remove(errorcheck)

        from mitmcloak import Bridge  # pylint: disable=import-outside-toplevel
        self.bridge = Bridge()
        self._labels.clear()
        # Order matters. The cloak's bridge performs the upstream request itself, so
        # a rewrite registered after it would be recorded as a "hit" and still go out
        # unchanged. Rules first, then the bridge, then the recorder — which leaves
        # history showing exactly what left the machine.
        self.master.addons.add(self.rules, self.bridge, self.recorder)
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
        if self._task.done():
            exc = self._task.exception()
            if exc is not None:
                self.error = f"{type(exc).__name__}: {exc}"
            elif not self.error:
                self.error = "the proxy stopped immediately — is that port already in use?"
            self.master = None
        # A listener that never came up is a failure, however quietly it happened.
        # mitmproxy keeps the server object either way and only logs the bind error,
        # so the thing to look at is whether it is actually running and holding an
        # address — a busy port leaves is_running False and listen_addrs empty.
        if self.master is not None:
            self._check_listeners()
            if self.error:
                await self.stop()
                return self.state()
        self.emit("proxy", self.state())
        return self.state()

    def preset_label(self, name: str, flow: Any = None) -> tuple[str, str]:
        """Name the identity this connection went out with, and say how we know.

        A mirrored identity is minted per client and named for its digest —
        mc-6b4ed3697900 — which is exact and unreadable. In order of confidence:
        the cloak's own preset match (browsers, exact), the HTTP library the
        User-Agent names, the TLS family the handshake belongs to, and failing
        all of that the shape of the handshake. The source travels with the
        label so the interface can show the difference between knowing and
        inferring.
        """
        if not name:
            return "", ""
        if not name.startswith("mc-"):
            return name, "preset"             # a built-in preset names itself
        if name in self._labels:
            return self._labels[name]
        answer = ("", "")
        try:
            conn = getattr(getattr(flow, "client_conn", None), "id", None)
            profile = self.bridge._profiles.get(conn) if conn else None
            hello = getattr(profile, "hello", None)
            # Recognised by its handshake? Then the cloak already worked out which
            # build this is, including the platform, which it takes from the
            # User-Agent — Chrome on Android and on Windows share a TLS stack, so
            # the handshake alone would call an Android phone "windows".
            if hello is not None and self.bridge.identifier.match(hello.family_id):
                doc = self.bridge.mirror.document(name) or {}
                spec = doc.get("preset") if isinstance(doc.get("preset"), dict) else {}
                exact = doc.get("based_on") or spec.get("based_on") or ""
                if exact:
                    answer = (exact, "tls")
            if not answer[0]:
                req = getattr(flow, "request", None)
                ua = ""
                if req is not None:
                    try:
                        ua = req.headers.get("user-agent", "") or ""
                    except Exception:  # pylint: disable=broad-except
                        ua = ""
                answer = tuple(identify.describe(hello, ua))
        except Exception:  # pylint: disable=broad-except
            answer = ("", "")                 # a private corner of the cloak
        # Only the exact preset match is cached against the digest. Everything
        # else is per-request: two apps share one stack, so a name taken from a
        # User-Agent — or a family inferred when one request happened to carry
        # no User-Agent — would otherwise be pinned to every client on it.
        if answer[1] == "tls":
            self._labels[name] = answer
        return answer

    async def configure(self, *, mode: Optional[str] = None, preset: Optional[str] = None,
                        allow_hosts: Optional[str] = None,
                        ports: Any = None) -> dict[str, Any]:
        """Change the identity without restarting anything.

        The cloak reads its mode and preset from the options on every request, and
        mitmproxy applies allow_hosts the same way — so none of this needs the
        proxy torn down and rebuilt. Only the listening port does, which is what
        start() is for. Switching between mirroring and a preset is meant to feel
        like flicking a switch, not like restarting a server.
        """
        if mode is not None:
            self.mode = mode
        if preset is not None:
            self.preset = preset
        if allow_hosts is not None:
            self.allow_hosts = allow_hosts
        if ports is not None:
            self.ports = self._clean_ports(ports, self.ports)

        if self.master is not None:
            self.error = ""
            update: dict[str, Any] = {"mitmcloak_mode": self.mode,
                                      "mitmcloak_preset": self.preset}
            if allow_hosts is not None:
                update["allow_hosts"] = [h.strip() for h in self.allow_hosts.split(",")
                                         if h.strip()]
            if ports is not None:
                update["mode"] = self._modes()      # adds, drops and moves listeners
            try:
                self.master.options.update(**update)
            except Exception as exc:  # pylint: disable=broad-except
                self.error = f"{type(exc).__name__}: {exc}"
                LOG.warning("couldn't apply %s live: %s", update, exc)
            if ports is not None and not self.error:
                # the rebind is a task; give it a moment, then report the truth
                await asyncio.sleep(0.35)
                self._check_listeners()
        self.emit("proxy", self.state())
        return self.state()

    def _check_listeners(self) -> None:
        """Say which ports didn't come up, rather than claiming they all did."""
        ps = self.master.addons.get("proxyserver") if self.master else None
        servers = list(getattr(ps, "servers", []) or [])
        live = {addr[1] for srv in servers if getattr(srv, "is_running", False)
                for addr in (getattr(srv, "listen_addrs", ()) or ())}
        missing = [p for p in self.listening if p not in live]
        if missing:
            ports = ", ".join(str(p) for p in missing)
            self.error = (f"couldn't listen on port {ports} — already in use?"
                          if len(missing) == 1
                          else f"couldn't listen on ports {ports} — already in use?")

    async def stop(self) -> dict[str, Any]:
        """Ask the proxy to finish, and wait for the port to actually be free.

        The listening socket has to be closed by hand. mitmproxy only tears servers
        down when the mode list changes — shutdown() ends the run loop and leaves
        the listener accepting, which on Windows the next start happily binds
        *alongside* (SO_REUSEADDR), giving two proxies on one port and traffic
        landing on whichever wins the race. Emptying the mode list closes it.
        """
        port = self.port
        if self.master is not None:
            ps = self.master.addons.get("proxyserver")
            if ps is not None:
                try:
                    await ps.servers.update([])
                except Exception as exc:  # pylint: disable=broad-except
                    LOG.warning("couldn't close the listener cleanly: %s", exc)
            self.master.shutdown()
        if self._task is not None:
            try:
                await asyncio.wait_for(asyncio.shield(self._task), timeout=5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()          # it didn't go quietly
            except Exception:  # pylint: disable=broad-except
                pass
        self.master, self._task = None, None
        if not await _wait_for_port(port, timeout=5):
            LOG.warning("port %s is still answering after a stop", port)
        self.emit("proxy", self.state())
        return self.state()

    # ── custom fingerprints ──────────────────────────────────────────────────
    def _cloak_cmd(self, name: str, *args: Any) -> Any:
        """Call one of mitmcloak's own commands, or say why we can't."""
        if self.master is None:
            raise RuntimeError("start the proxy first")
        return self.master.commands.call(f"mitmcloak.{name}", *args)

    @staticmethod
    def _parse_catalogue(rows: list[str]) -> list[dict[str, Any]]:
        """Turn the cloak's catalogue table into something the UI can render.

            ad2bf5ed0a17  conns=6  reqs=6  refused=0  noreq=0  tls-only  example.com

        These ids are *observations* — clients that came through — not presets you
        can load, so they're reported as what Cloak saw rather than offered in a
        picker where choosing one would only fail.
        """
        seen = []
        for row in rows:
            parts = [p for p in re.split(r"\s{2,}", str(row).strip()) if p]
            if not parts:
                continue
            item: dict[str, Any] = {"id": parts[0], "flags": [], "hosts": []}
            for part in parts[1:]:
                if "=" in part:
                    key, _, val = part.partition("=")
                    item[key] = int(val) if val.isdigit() else val
                elif "." in part or "," in part:
                    item["hosts"] = [h.strip() for h in part.split(",") if h.strip()]
                else:
                    item["flags"].append(part)
            seen.append(item)
        return seen

    def tls_catalogue(self) -> dict[str, Any]:
        """Everything on offer: built-in presets, plus whatever this session saw.

        A fingerprint mirrored from a real device is the most valuable identity
        there is — it's that app, exactly — so it's listed beside the built-ins
        and can be pinned or written to a file for use when the device is gone.
        """
        out: dict[str, Any] = {"presets": available_presets(), "mirrored": [],
                               "observed": [], "error": ""}
        if self.master is None:
            return out
        for key, cmd in (("presets", "presets"), ("mirrored", "mirror.list"),
                         ("observed", "catalogue")):
            try:
                rows = list(self._cloak_cmd(cmd))
            except Exception as exc:  # pylint: disable=broad-except
                out["error"] = f"{type(exc).__name__}: {exc}"
                continue
            out[key] = self._parse_catalogue(rows) if key == "observed" else rows
        return out

    def tls_describe(self, name: str) -> str:
        return str(self._cloak_cmd("preset.describe", name))

    def tls_load(self, path: str) -> str:
        """Register a preset from a JSON file — someone else's, or your own export."""
        return str(self._cloak_cmd("preset.load", path))

    def tls_export(self, directory: str, *, everything: bool = False) -> str:
        """Write fingerprints out so they outlive the session that captured them."""
        return str(self._cloak_cmd("catalogue.save" if everything else "mirror.export",
                                   directory))

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
