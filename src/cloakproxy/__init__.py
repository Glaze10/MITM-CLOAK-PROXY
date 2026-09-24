"""Cloak — an intercepting proxy whose upstream TLS looks like a real browser.

mitmproxy decrypts; mitmcloak replays the client's own TLS/HTTP2 fingerprint
upstream, so a bot wall that rejects a proxy's handshake sees a browser instead.
"""
__version__ = "0.1.0"
