# Cloak

An intercepting proxy for people whose proxy keeps getting 403'd.

Burp, Charles and mitmproxy all terminate TLS and then open their *own* connection
upstream — with their own TLS and HTTP/2 fingerprint. Cloudflare, Akamai and
PerimeterX know those fingerprints, so the site blocks you even though the device
trusts your CA and nothing is wrong with the request.

Cloak is [mitmproxy](https://mitmproxy.org) for the decryption and
[mitmcloak](https://github.com/sardanioss/mitmcloak) for the egress: the upstream
leg replays the real client's TLS + HTTP/2 fingerprint, so the origin sees the
browser or app that actually made the request. On top of that sits the interface
you'd otherwise open Burp for.

```
device ──► Cloak ──► origin
            │         ▲
            │         └─ sees the device's own TLS/JA4, not a proxy's
            └─ you read and rewrite the plaintext
```

## What's in it

**Proxy → History** — live flows with method, host, path, status, type, size, time
and which TLS identity went out. Multi-select with ctrl and shift, right-click for
highlight colours, copy as curl, replay, or export just the selection. Request and
response show side by side with a divider you can drag either way.

**Proxy → Intercept** — park matching requests, edit method, URL, headers or body,
forward or drop. Turning intercept off releases anything still parked, so a
forgotten request can't wedge a device.

**Proxy → Match & Replace** — rewrite traffic as it passes. Pin a User-Agent, point
a host at staging, strip a header that breaks a replay, redact a token before you
send a capture to someone. Rules run before the upstream leg, so what you see in
history is what actually left the machine.

**Proxy → Settings** — port, allowed hosts, the CA, and the fingerprint mode, which
says in words which identity each connection will use.

**Repeater** — send a request to its own tab, edit it, resend, read the response.
The original flow stays exactly as it was captured.

**Projects** — save a session to disk and reopen it. Flows are stored in
mitmproxy's own format, so other tools can read them.

**HAR in and out** — export everything or just what you selected; import a capture
someone sent you and read it in the same interface.

### Filtering

The quick box covers method, host, path, status and type. **Filter…** opens the
full dialog: several conditions at once — methods, status classes or a range, host,
path, content type, a string in either body, URLs to hide, only-highlighted,
only-parked, and one checkbox that hides images, fonts, CSS and JS. Active
conditions show as chips next to the button, so a filtered view never looks like
an empty one.

## Which fingerprint is actually being used

This is the question the tool exists to answer, so it's answered in three places.

| mode | upstream handshake |
|---|---|
| **Mirror the client** (default) | whatever the device really sent |
| **Mirror only** | the same, but fails loudly rather than falling back |
| **Always use a preset** | a chosen browser, whatever the client is |

While mirroring, the preset control is dimmed and labelled **Fallback preset** —
it is only used when there's no client handshake to copy, which happens when
something in front of Cloak already terminated the TLS. In preset mode the same
control reads **Preset (in use)**.

The title bar always states the current behaviour, the settings tab counts how many
connections were mirrored versus presented, and every flow carries its own answer:

```
Upstream: mirrored the client's own handshake · h2 · 41 ms
```

Mirroring is real, not a setting that hopes for the best. The same proxy, three
clients, three different handshakes upstream:

```
curl               t12d218h1_76e208dd3e22_…     TLS 1.2, HTTP/1.1
Chrome 151         t13d1516h2_8daaf6152771_…    TLS 1.3, h2
iOS Safari 18      t13d2013h2_a09f3c656075_…    TLS 1.3, h2
```

## Install

Needs Python 3.11+.

```bash
git clone https://github.com/Glaze10/MITM-CLOAK-PROXY.git
cd MITM-CLOAK-PROXY
pip install -r requirements.txt
python -m cloakproxy            # from src/, or `pip install -e .` first
```

On Windows, `.\scripts\cloak.ps1` builds the virtual environment on first run and
starts the app. It runs under `pythonw.exe`, so there's no console window behind
it; add `-Console` if you want the log in your terminal.
`.\scripts\cloak.ps1 -Shortcut` puts a shortcut on your Desktop that launches the
interpreter directly — no shell, nothing flashing up.

## Using it

1. Press **Start**. The proxy listens on the port in Proxy → Settings (8080 by default).
2. Point the device or browser at `your-machine-ip:8080`.
3. First time only, install the CA: browse to `http://mitm.it` **through the proxy**,
   or use **Download CA**. On iOS, also switch it on under
   Settings → General → About → Certificate Trust Settings.

### Keyboard

| | |
|---|---|
| `Ctrl/Cmd + A` | select every flow in view |
| `1`–`6` | highlight the selection |
| `0` | clear the highlight |
| `Ctrl/Cmd + F` | open the filter dialog |
| `Ctrl/Cmd + Enter` | forward the parked request you're editing |
| `Esc` | close the menu or dialog |

## What it is not

- It doesn't defeat certificate pinning. A pinned app rejects any CA, including
  this one; that needs a hook on the device (Frida or similar).
- It doesn't fabricate a fingerprint that would pass where the real client fails.
  It preserves a legitimate one through a proxy that would otherwise replace it.
- WebSockets pass through without fingerprint mirroring.

## Layout

```
src/cloakproxy/
  __main__.py          entry point: engine, UI server, window
  core/
    proxy.py           runs mitmproxy in-process with the cloak addon attached
    recorder.py        the addon: keeps flows, streams events, holds intercepts
    rules.py           match & replace
    filters.py         the filter dialog's logic
  storage/
    har.py             HAR 1.2 export and import
    projects.py        save/load a session as a folder
  web/
    server.py          tornado: REST + WebSocket + static
    static/            the interface — no build step, ES modules straight to the browser
scripts/cloak.ps1      Windows launcher and shortcut installer
tests/                 filters and match & replace
```

The proxy runs on the UI's own event loop rather than in a subprocess: a parked
flow has to be edited in place, and that means holding the real object rather than
a copy that crossed a pipe.

```bash
pytest          # from the repo root
```

## Credits

[mitmproxy](https://github.com/mitmproxy/mitmproxy) ·
[mitmcloak](https://github.com/sardanioss/mitmcloak) ·
[httpcloak](https://github.com/sardanioss/httpcloak)

## Licence

MIT — see [LICENSE](LICENSE). Intended for testing systems you are authorised to
test.
