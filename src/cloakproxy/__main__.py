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
    # Start on a tiny inline splash rather than the app URL. WebView2's first
    # paint is the slow part; a self-contained page paints the instant the
    # runtime is up (no fetch, no modules), so the window shows the loading
    # screen straight away instead of a blank "not responding" frame. Once it's
    # shown we navigate to the real interface.
    # A native splash covers WebView2's runtime start, during which its own window
    # can't paint anything and the OS calls it "not responding". It's a separate
    # process, so it shows and animates regardless, and it closes itself the moment
    # the interface actually connects (it polls /api/ready) — no guessing.
    splash = _spawn_native_splash(url)

    # Point straight at the app. The earlier splash→load_url hop added a second
    # navigation freeze; the native splash and the page's own #splash cover the
    # wait without it.
    bridge.window = webview.create_window(
        f"Cloak — proxy :{port}", url, width=1500, height=940,
        min_size=(1000, 640), js_api=bridge)
    try:
        webview.start(icon=str(ICON) if ICON.exists() else None)
    finally:
        if splash is not None and splash.poll() is None:
            splash.terminate()
    return True


def _spawn_native_splash(app_url: str):
    """A borderless loading window in its own process, shown while WebView2 boots.

    tkinter, not WebView2, so it paints instantly and animates no matter what this
    process's main thread is doing. It closes itself once /api/ready reports the
    interface has connected, or after a hard 60s cap.
    """
    import subprocess  # pylint: disable=import-outside-toplevel
    exe = sys.executable or ""
    pyw = Path(exe).with_name("pythonw.exe")
    interp = str(pyw) if pyw.exists() else exe
    if not interp:
        return None
    ready_url = app_url.rstrip("/") + "/api/ready"
    code = (
        "import tkinter as tk,threading,json,time\n"
        "import urllib.request as u\n"
        "r=tk.Tk();r.overrideredirect(True);r.configure(bg='#101116')\n"
        "w,h=300,150;sw,sh=r.winfo_screenwidth(),r.winfo_screenheight()\n"
        "r.geometry('%dx%d+%d+%d'%(w,h,(sw-w)//2,(sh-h)//2))\n"
        "try:\n r.attributes('-topmost',True)\nexcept Exception:\n pass\n"
        "tk.Label(r,text='Cloak Proxy',fg='#dcdce4',bg='#101116',"
        "font=('Segoe UI',15,'bold')).pack(pady=(38,4))\n"
        "tk.Label(r,text='Loading\\u2026',fg='#6d7285',bg='#101116',"
        "font=('Segoe UI',10)).pack()\n"
        "c=tk.Canvas(r,width=200,height=3,bg='#252734',highlightthickness=0);c.pack(pady=20)\n"
        "b=c.create_rectangle(0,0,60,3,fill='#6fb0ff',width=0)\n"
        "x=[0]\n"
        "def a():\n x[0]=(x[0]+7)%270;c.coords(b,x[0]-60,0,x[0],3);r.after(16,a)\n"
        "a()\n"
        "done=[False]\n"
        "def watch():\n"
        " end=time.time()+60\n"
        " while time.time()<end:\n"
        "  try:\n"
        "   d=json.load(u.urlopen(READY,timeout=2))\n"
        "   if d.get('ui',0)>0: break\n"
        "  except Exception: pass\n"
        "  time.sleep(0.3)\n"
        " done[0]=True\n"
        "threading.Thread(target=watch,daemon=True).start()\n"
        "def chk():\n"
        " if done[0]: r.destroy()\n"
        " else: r.after(150,chk)\n"
        "chk()\n"
        "r.mainloop()\n"
    )
    # prepend the URL as a literal, so no %-formatting touches the tkinter code
    code = "READY=" + repr(ready_url) + "\n" + code
    try:
        flags = 0x08000000 if sys.platform == "win32" else 0   # CREATE_NO_WINDOW
        return subprocess.Popen([interp, "-c", code], creationflags=flags)
    except Exception:  # pylint: disable=broad-except
        return None


_SPLASH_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{height:100%;margin:0;background:#101116;color:#dcdce4;
    font-family:"Segoe UI",system-ui,sans-serif;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:12px}
  .m{width:46px;height:46px;border-radius:12px;background:#161a26;position:relative;
    box-shadow:0 8px 30px rgba(0,0,0,.4)}
  .m::before{content:"";position:absolute;inset:10px 10px 0;border-radius:50% 50% 0 0;
    border:3px solid #6fb0ff;border-bottom:0}
  .m::after{content:"";position:absolute;left:50%;top:24px;width:10px;height:10px;
    border-radius:50%;background:#6fb0ff;transform:translateX(-50%)}
  .t{font-weight:700;letter-spacing:.5px;font-size:16px}
  .s{color:#6d7285;font-size:12px}
  .b{width:200px;height:3px;border-radius:3px;background:#252734;overflow:hidden}
  .b span{display:block;height:100%;width:40%;border-radius:3px;background:#6fb0ff;
    animation:sl 1.1s ease-in-out infinite}
  @keyframes sl{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}
</style></head><body>
  <div class="m"></div><div class="t">Cloak Proxy</div>
  <div class="s">Starting…</div><div class="b"><span></span></div>
</body></html>"""


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

    # The server and the proxy run in their OWN process, not a thread of the
    # window's. A window and a server sharing one process share one GIL, and
    # WebView2's UI loop then starves the server — the window (and everything the
    # proxy is doing) goes unresponsive whenever the interface is busy. As
    # separate processes they don't compete: the window can be busy and the proxy
    # keeps capturing and answering at full speed.
    return _run_windowed(args, url)


def _run_windowed(args: argparse.Namespace, url: str) -> int:
    import time  # pylint: disable=import-outside-toplevel

    server = _spawn_server(args)
    if server is None:                     # no separate interpreter? fall back to a thread
        def _backend() -> None:
            asyncio.run(_serve(args))
        threading.Thread(target=_backend, daemon=True, name="cloak-backend").start()
        time.sleep(1.2)
    else:
        _await_server(args.ui_port)

    try:
        if not _window(url, args.port):
            LOG.info("pywebview not installed — opening %s in your browser", url)
            webbrowser.open(url)
            if server is not None:
                server.wait()
            else:
                while True:
                    time.sleep(3600)
    finally:
        if server is not None and server.poll() is None:
            server.terminate()             # window closed → stop the server too
            try:
                server.wait(timeout=5)
            except Exception:  # pylint: disable=broad-except
                server.kill()
    return 0


_JOB_HANDLE = None      # keep the job object alive for the parent's lifetime


def _free_ui_port(ui_port: int) -> None:
    """Kill any server left listening on the UI port from a previous run.

    An orphaned server (a window that was force-killed or crashed) keeps the
    port and its old capture, so the next launch would attach to stale state —
    a project you closed would reappear. Clearing it guarantees a clean slate.
    """
    if sys.platform != "win32":
        return
    import subprocess  # pylint: disable=import-outside-toplevel
    try:
        out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True,
                             text=True, timeout=5).stdout
    except Exception:  # pylint: disable=broad-except
        return
    pids = set()
    for line in out.splitlines():
        if f":{ui_port} " in line and "LISTENING" in line:
            pids.add(line.split()[-1])
    for pid in pids:
        try:
            subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True, timeout=5)
        except Exception:  # pylint: disable=broad-except
            pass


def _tie_child_to_parent(pid: int) -> None:
    """Put the child server in a job object that kills it when this process ends.

    So the server can never outlive the window, however the window dies —
    normal close, crash or force-kill. No more orphaned servers holding the port.
    """
    global _JOB_HANDLE
    if sys.platform != "win32":
        return
    import ctypes  # pylint: disable=import-outside-toplevel
    from ctypes import wintypes  # pylint: disable=import-outside-toplevel
    try:
        k = ctypes.windll.kernel32

        class BASIC(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
                        ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
                        ("LimitFlags", wintypes.DWORD),
                        ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t),
                        ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_void_p),
                        ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]

        class IOC(ctypes.Structure):
            _fields_ = [("r", ctypes.c_ulonglong), ("w", ctypes.c_ulonglong),
                        ("o", ctypes.c_ulonglong), ("rt", ctypes.c_ulonglong),
                        ("wt", ctypes.c_ulonglong), ("ot", ctypes.c_ulonglong)]

        class EXT(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BASIC), ("IoInfo", IOC),
                        ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        job = k.CreateJobObjectW(None, None)
        info = EXT()
        info.BasicLimitInformation.LimitFlags = 0x2000   # KILL_ON_JOB_CLOSE
        k.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))
        handle = k.OpenProcess(0x1F0FFF, False, pid)     # PROCESS_ALL_ACCESS
        k.AssignProcessToJobObject(job, handle)
        _JOB_HANDLE = job                                # hold it open
    except Exception as exc:  # pylint: disable=broad-except
        LOG.warning("couldn't tie the server to this process: %s", exc)


def _spawn_server(args: argparse.Namespace):
    """Start the UI+proxy as a child process. Returns the Popen, or None."""
    import subprocess  # pylint: disable=import-outside-toplevel
    exe = sys.executable or ""
    # use the windowless interpreter so no console flashes up
    pyw = Path(exe).with_name("pythonw.exe")
    interp = str(pyw) if pyw.exists() else exe
    if not interp:
        return None
    _free_ui_port(args.ui_port)             # clear any orphan from a previous run
    cmd = [interp, "-m", "cloakproxy", "--no-window",
           "--ui-port", str(args.ui_port), "--port", str(args.port),
           "--mode", args.mode, "--preset", args.preset]
    if not args.start:
        cmd.append("--no-start")
    try:
        flags = 0x08000000 if sys.platform == "win32" else 0   # CREATE_NO_WINDOW
        proc = subprocess.Popen(cmd, creationflags=flags)
        _tie_child_to_parent(proc.pid)      # dies with this process, never orphans
        return proc
    except Exception as exc:  # pylint: disable=broad-except
        LOG.warning("couldn't start the server process (%s); running in-thread", exc)
        return None


def _await_server(ui_port: int, timeout: float = 30.0) -> None:
    """Wait until the child server answers, so the window never opens onto a void."""
    import time  # pylint: disable=import-outside-toplevel
    import urllib.request  # pylint: disable=import-outside-toplevel
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://{UI_HOST}:{ui_port}/api/state", timeout=2):
                return
        except Exception:  # pylint: disable=broad-except
            time.sleep(0.3)


if __name__ == "__main__":
    sys.exit(main())
