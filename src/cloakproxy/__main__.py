"""Start Cloak: the proxy engine, the local UI server, and a window onto it.

    python -m cloakproxy                 # window, proxy on 8080
    python -m cloakproxy --port 8081     # proxy port
    python -m cloakproxy --no-window     # serve the UI, open it yourself
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import threading
import webbrowser
from pathlib import Path

import tornado.web

from cloakproxy.core.proxy import DEFAULT_MODE, DEFAULT_PORT, DEFAULT_PRESET, ProxyManager
from cloakproxy.web.server import Hub, make_app

LOG = logging.getLogger("cloak")
UI_HOST, UI_PORT = "127.0.0.1", 8099


ICON = Path(__file__).resolve().parent / "web" / "static" / "cloak.ico"


def _claim_taskbar_identity() -> None:
    """Tell Windows this is its own application, not an instance of Python.

    Without this the window is grouped under pythonw.exe and inherits its icon
    and its name — which is why it reads as a console someone left running.
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes  # pylint: disable=import-outside-toplevel
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Cloak.Proxy")
    except Exception:  # pylint: disable=broad-except
        pass          # cosmetic; never worth failing to start over


def _window(url: str, port: int) -> bool:
    """A real window if pywebview is around, otherwise the default browser."""
    try:
        import webview  # pylint: disable=import-outside-toplevel
    except ImportError:
        return False
    _claim_taskbar_identity()
    # the title says what this window is for; pywebview otherwise takes the
    # interpreter's own icon, which is the console look
    webview.create_window(f"Cloak — proxy :{port}", url,
                          width=1500, height=940, min_size=(1000, 640))
    webview.start(icon=str(ICON) if ICON.exists() else None)
    return True


async def _serve(args: argparse.Namespace) -> None:
    hub = Hub()
    proxy = ProxyManager(hub.emit)
    app = make_app(proxy, hub)
    app.listen(args.ui_port, address=UI_HOST)
    LOG.info("UI on http://%s:%s", UI_HOST, args.ui_port)
    if args.start:
        await proxy.start(port=args.port, mode=args.mode, preset=args.preset)
        LOG.info("proxy on :%s (%s/%s)", proxy.port, proxy.mode, proxy.preset)
    await asyncio.Event().wait()          # run until the process is killed


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="cloak", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="proxy port")
    ap.add_argument("--ui-port", type=int, default=UI_PORT, help="UI port")
    ap.add_argument("--mode", default=DEFAULT_MODE, choices=("auto", "mirror", "static"))
    ap.add_argument("--preset", default=DEFAULT_PRESET, help="fallback/static fingerprint")
    ap.add_argument("--no-start", dest="start", action="store_false",
                    help="open the UI without starting the proxy")
    ap.add_argument("--no-window", dest="window", action="store_false",
                    help="don't open a window; serve the UI only")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        datefmt="%H:%M:%S")
    url = f"http://{UI_HOST}:{args.ui_port}/"

    if not args.window:
        asyncio.run(_serve(args))
        return 0

    # the UI thread owns the window; the proxy owns its own loop on this thread
    def _backend() -> None:
        asyncio.run(_serve(args))

    t = threading.Thread(target=_backend, daemon=True, name="cloak-backend")
    t.start()
    import time
    time.sleep(1.2)                        # let the server bind before we point at it
    if not _window(url, args.port):
        LOG.info("pywebview not installed — opening %s in your browser", url)
        webbrowser.open(url)
        try:
            t.join()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
