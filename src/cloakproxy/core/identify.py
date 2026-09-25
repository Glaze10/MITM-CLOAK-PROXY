"""Name a client that the cloak's own preset matching couldn't place.

mitmcloak recognises browsers by probing a dozen known builds and matching
handshakes against them, which is exact but only covers browsers. Most traffic
worth intercepting comes from apps — OkHttp, NSURLSession, Dart, Go — and for
those the column had nothing to say.

Three fallbacks, in descending order of how much they can be trusted:

1. the User-Agent's stack token, when it names an HTTP client outright
   ("okhttp/4.12.0"). It's self-reported, so it can lie, but a library that
   bothers to name itself is almost always telling the truth.
2. the TLS family, inferred from the handshake. Narrow rules over hallmarks
   that don't move between versions — these were written against real captures
   rather than guessed, and each one is pinned by a test.
3. the shape of the handshake: version and protocol. Says little, but it's
   never wrong, and it still tells two clients apart.

Every answer carries where it came from, so the interface can show the
difference between "this is Chrome" and "this looks like Chrome".
"""
from __future__ import annotations

import re
from typing import Any, NamedTuple

# Extension numbers whose presence is characteristic. The names are the ones
# used in the registry, so they can be looked up.
ALPS = 17613                 # application_settings — Chromium
DELEGATED_CREDENTIALS = 34   # Firefox
RECORD_SIZE_LIMIT = 28       # Firefox
ENCRYPT_THEN_MAC = 22        # OpenSSL; no browser offers it
SESSION_TICKET = 35
TLS13 = 0x0304


class Label(NamedTuple):
    text: str
    source: str              # "ua" | "family" | "shape" | ""


# Libraries that name themselves in the User-Agent. Matched case-insensitively
# against the product tokens, so "OkHttp/4.12.0" and "okhttp/4.12.0" both hit.
UA_STACKS = (
    "okhttp", "cfnetwork", "dart", "curl", "libcurl", "wget",
    "python-requests", "python-urllib", "urllib3", "aiohttp", "httpx",
    "go-http-client", "java", "apache-httpclient", "okhttp3", "retrofit",
    "volley", "ktor", "alamofire", "afnetworking", "moya",
    "node-fetch", "undici", "axios", "got", "superagent",
    "guzzlehttp", "restsharp", "unity", "unityplayer", "postmanruntime",
    "insomnia", "httpclient", "dalvik", "darwin",
)

_TOKEN = re.compile(r"([A-Za-z][A-Za-z0-9_.\-]*)/([0-9][0-9A-Za-z_.\-]*)")


def stack_from_user_agent(ua: str) -> str:
    """The HTTP library a User-Agent names, if it names one.

    A browser User-Agent names a browser, not a stack, and is skipped: those
    come with "Mozilla/5.0" and are handled by the handshake matching, which
    doesn't depend on a string the client chose.
    """
    if not ua:
        return ""
    for name, version in _TOKEN.findall(ua):
        if name.lower() in UA_STACKS:
            return f"{name}/{version}"
    return ""


def family_from_hello(hello: Any) -> str:
    """Which TLS stack produced this handshake, where the evidence is clear.

    Each rule leans on something structural rather than on a version number: the
    extensions a stack offers, and the certificate compression algorithms it
    advertises, are properties of the implementation.
    """
    ext = set(getattr(hello, "extension_order", ()) or ())
    comp = [str(c).lower() for c in (getattr(hello, "cert_compression", None) or [])]
    grease = bool(getattr(hello, "has_grease", False))
    limit = getattr(hello, "record_size_limit", None)

    # Chromium is the only stack that pairs GREASE with ALPS and brotli-only
    # certificate compression. Edge, Brave, Electron and Android WebView share it.
    if grease and ALPS in ext and comp == ["brotli"]:
        return "chromium-based"
    # Firefox: a record size limit and delegated credentials, and it offers all
    # three compression algorithms where Chromium offers one.
    if limit and {DELEGATED_CREDENTIALS, RECORD_SIZE_LIMIT} <= ext and "zstd" in comp:
        return "firefox-based"
    # Apple's stack — Safari, NSURLSession, anything on CFNetwork — GREASEs like
    # Chromium but compresses with zlib and doesn't send ALPS.
    if grease and comp == ["zlib"] and ALPS not in ext:
        return "apple-stack"
    # encrypt_then_mac is an OpenSSL habit no browser has. Python, curl and most
    # server-side clients land here.
    if not grease and ENCRYPT_THEN_MAC in ext:
        return "openssl-based"
    return ""


def shape_from_hello(hello: Any) -> str:
    """The least that can be said truthfully: version and protocol."""
    versions = getattr(hello, "supported_versions", None) or []
    alpn = [str(a) for a in (getattr(hello, "alpn", None) or [])]
    version = "TLS 1.3" if TLS13 in versions else "TLS 1.2"
    if "h2" in alpn:
        return f"{version} · h2"
    if alpn:
        return f"{version} · {alpn[0]}"
    return version


def describe(hello: Any, user_agent: str = "") -> Label:
    """Best available name for a client the preset matching didn't place."""
    stack = stack_from_user_agent(user_agent)
    if stack:
        return Label(stack, "ua")
    family = family_from_hello(hello)
    if family:
        return Label(family, "family")
    if hello is None:
        return Label("", "")
    return Label(shape_from_hello(hello), "shape")
