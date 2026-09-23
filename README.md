# Cloak

An intercepting proxy for people whose proxy keeps getting 403'd.

Burp, Charles and mitmproxy all terminate TLS and then open their *own* connection
upstream — with their own TLS and HTTP/2 fingerprint. Cloudflare, Akamai and
PerimeterX know those fingerprints, so the site blocks you even though the device
trusts your CA and nothing is wrong with the request.

Cloak is [mitmproxy](https://mitmproxy.org) for the decryption and
[mitmcloak](https://github.com/sardanioss/mitmcloak) for the egress: the upstream
leg replays the real client's TLS + HTTP/2 fingerprint, so the origin sees the
browser or app that actually made the request. On top of that sits a UI with the
things you'd open Burp for.

## What it does

- **Live flow list** — method, host, path, status, type, size, time; filter as you type
- **Request/response detail** — headers and bodies, JSON pretty-printed, binaries shown as base64
- **Intercept** — park matching requests, edit method, URL, headers or body, then forward or drop
- **Replay** — send any flow again, edited or not
- **HAR in and out** — export what you're looking at; import a capture someone sent you and read it in the same UI
- **Projects** — save a session to disk and reopen it later; flows are stored in mitmproxy's own format, so other tools can read them too
- **Fingerprint control** — `auto` mirrors whatever the client really is, `static` presents a preset (100+ available), `mirror` refuses to fall back

## Install

Needs Python 3.11+.

```bash
git clone https://github.com/<you>/cloak
cd cloak
pip install -r requirements.txt
python -m cloakproxy
```

On Windows, `.\Cloak.ps1` does the same and builds the virtual environment on
first run. `.\Cloak.ps1 -Shortcut` puts a Cloak shortcut on your Desktop.

## Using it

1. Press **Start**. The proxy listens on the port in the toolbar (8080 by default).
2. Point the device or browser at `your-machine-ip:8080`.
3. First time only, install the CA: browse to `http://mitm.it` **through the proxy**,
   or use the **CA cert** button. On iOS, also turn it on under
   Settings → General → About → Certificate Trust Settings.
4. Traffic appears as it happens. Click a row to read it.

**Intercept**: type a substring in the intercept box (say `checkout`), press
*Intercept: off* to arm it. Matching requests park; the row gets a yellow edge.
Open **Edit & resend**, change what you like, then **Apply & forward**. Turning
intercept off releases anything still parked, so you can't wedge a device by
forgetting about it.

### Fingerprint modes

| mode | upstream handshake | when |
|---|---|---|
| `auto` | mirrors the real client, falls back to the preset | default; correct for an app |
| `mirror` | mirrors only, fails loudly if it can't | when the exact fingerprint matters |
| `static` | always the chosen preset | when something upstream terminated the TLS first |

If you chain Cloak behind another proxy, use `static`: whatever is in front has
already terminated the client's TLS, so there is no original handshake left to
mirror, and a real browser preset is the honest choice.

## What it is not

- It doesn't defeat certificate pinning. A pinned app rejects any CA, including
  this one; that needs a hook on the device (Frida or similar).
- It doesn't fabricate a fingerprint that would pass where the real client fails.
  It preserves a legitimate one through a proxy that would otherwise replace it.
- WebSockets pass through without fingerprint mirroring.

## Layout

```
cloakproxy/
  __main__.py     entry point: engine, UI server, window
  proxy.py        runs mitmproxy in-process with the cloak addon attached
  recorder.py     the addon: keeps flows, streams events, holds intercepts
  har.py          HAR 1.2 export and import
  projects.py     save/load a session as a folder
  server.py       tornado: REST + WebSocket + static
  static/         the UI — one HTML, one CSS, one JS, no build step
```

The proxy runs on the UI's own event loop rather than in a subprocess: a parked
flow has to be edited in place, and that means holding the real object rather
than a copy that crossed a pipe.

## Credits

[mitmproxy](https://github.com/mitmproxy/mitmproxy) ·
[mitmcloak](https://github.com/sardanioss/mitmcloak) ·
[httpcloak](https://github.com/sardanioss/httpcloak)

## Licence

MIT — see [LICENSE](LICENSE). Intended for testing systems you are authorised to
test.
