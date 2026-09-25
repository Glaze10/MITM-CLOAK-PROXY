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


class Bridge:
    """The desktop window's link to the native file dialogs.

    An embedded webview isn't a browser: it won't download a file when the page
    navigates to one, and window.prompt() returns nothing. So export, import and
    "download CA" — all of which worked in a plain browser — did nothing in the
    app. These give the page real Save and Open dialogs to call instead.
    """

    def __init__(self) -> None:
        self.window = None

    def save_file(self, suggested_name: str, text: str) -> dict:
        """Write text to a location the user picks. Returns the path, or {}."""
        import webview  # pylint: disable=import-outside-toplevel
        result = self.window.create_file_dialog(
            webview.SAVE_DIALOG, save_filename=suggested_name)
        if not result:
            return {"ok": False, "cancelled": True}
        path = result[0] if isinstance(result, (list, tuple)) else result
        try:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
            return {"ok": True, "path": path}
        except Exception as exc:  # pylint: disable=broad-except
            return {"ok": False, "error": str(exc)}

    def save_bytes(self, suggested_name: str, b64: str) -> dict:
        """Same, for binary content (the CA certificate) passed as base64."""
        import base64  # pylint: disable=import-outside-toplevel
        import webview  # pylint: disable=import-outside-toplevel
        result = self.window.create_file_dialog(
            webview.SAVE_DIALOG, save_filename=suggested_name)
        if not result:
            return {"ok": False, "cancelled": True}
        path = result[0] if isinstance(result, (list, tuple)) else result
        try:
            with open(path, "wb") as fh:
                fh.write(base64.b64decode(b64))
            return {"ok": True, "path": path}
        except Exception as exc:  # pylint: disable=broad-except
            return {"ok": False, "error": str(exc)}

    def open_file(self) -> dict:
        """Let the user pick a file to import. Returns its path, or {}."""
        import webview  # pylint: disable=import-outside-toplevel
        result = self.window.create_file_dialog(
            webview.OPEN_DIALOG, file_types=("HAR files (*.har)", "All files (*.*)"))
        if not result:
            return {"ok": False, "cancelled": True}
        path = result[0] if isinstance(result, (list, tuple)) else result
        return {"ok": True, "path": path}


def _make_dpi_aware() -> None:
    """Render at the display's real resolution, not stretched.

    A DPI-unaware process is drawn at 96 DPI and bitmap-scaled up by Windows on
    a 125%/150% display, so the text is soft on screen and a screenshot captures
    that softness. Declaring per-monitor awareness (v2, then older fallbacks)
    lets WebView2 draw crisply. Must run before any window exists.
    """
    if sys.platform != "win32":
        return
    import ctypes  # pylint: disable=import-outside-toplevel
    try:
        # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (Win10 1703+)
        if ctypes.windll.user32.SetProcessDpiAwarenessContext(-4):
            return
    except Exception:  # pylint: disable=broad-except
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)   # per-monitor (Win8.1+)
    except Exception:  # pylint: disable=broad-except
        try:
            ctypes.windll.user32.SetProcessDPIAware()     # system-DPI (Vista+)
        except Exception:  # pylint: disable=broad-except
            pass


def _window(url: str, port: int) -> bool:
    """A real window if pywebview is around, otherwise the default browser."""
    try:
        import webview  # pylint: disable=import-outside-toplevel
    except ImportError:
        return False
    _make_dpi_aware()
    _claim_taskbar_identity()
    bridge = Bridge()
    # the title says what this window is for; pywebview otherwise takes the
    # interpreter's own icon, which is the console look
    bridge.window = webview.create_window(
        f"Cloak — proxy :{port}", url, width=1500, height=940,
        min_size=(1000, 640), js_api=bridge)
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
