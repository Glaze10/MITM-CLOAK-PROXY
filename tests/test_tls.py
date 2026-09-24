"""The TLS identity plumbing: what gets offered, and what gets said about it.

Both of these caused real breakage. The catalogue was being fed into a picker,
where choosing an entry could only fail, and the cloak's warnings were going to
a console that a windowed app doesn't have — so pinning a fingerprint that
couldn't complete a handshake looked like the proxy had simply broken.
"""
import logging

from cloakproxy.core.proxy import Notices, ProxyManager

ROW = ("ad2bf5ed0a17  conns=6    reqs=6     refused=0   noreq=0   "
       "tls-only  example.com, httpbin.org")


def test_catalogue_row_is_parsed_into_fields():
    (seen,) = ProxyManager._parse_catalogue([ROW])
    assert seen["id"] == "ad2bf5ed0a17"
    assert seen["conns"] == 6 and seen["reqs"] == 6 and seen["refused"] == 0
    assert seen["flags"] == ["tls-only"]
    assert seen["hosts"] == ["example.com", "httpbin.org"]


def test_catalogue_survives_rows_it_has_never_seen_before():
    rows = ["", "   ", "deadbeef", "beef  conns=2  h2  a.example.org"]
    out = ProxyManager._parse_catalogue(rows)
    assert [o["id"] for o in out] == ["deadbeef", "beef"]
    assert out[0]["hosts"] == [] and out[0]["flags"] == []
    assert out[1]["conns"] == 2 and out[1]["hosts"] == ["a.example.org"]


def _record(name: str, msg: str, level: int = logging.WARNING) -> logging.LogRecord:
    return logging.LogRecord(name, level, __file__, 1, msg, None, None)


def test_notices_keep_the_cloaks_warnings():
    n = Notices()
    n.emit(_record("mitmcloak.mirror", "mc-abc offers 6 cipher(s) httpcloak cannot complete"))
    assert [r["text"] for r in n.as_list()] == [
        "mc-abc offers 6 cipher(s) httpcloak cannot complete"]
    assert n.as_list()[0]["level"] == "warning"


def test_notices_ignore_other_loggers_and_housekeeping():
    n = Notices()
    n.emit(_record("tornado.access", "404 GET /favicon.ico"))
    n.emit(_record("mitmproxy.proxy", "client disconnect"))
    n.emit(_record("mitmcloak.bridge", "mitmcloak: forced connection_strategy=lazy"))
    assert n.as_list() == []


def test_notices_do_not_repeat_the_same_line_per_connection():
    n = Notices()
    for _ in range(5):
        n.emit(_record("mitmcloak.mirror", "same warning"))
    assert len(n.as_list()) == 1


def test_notices_are_bounded():
    n = Notices(keep=3)
    for i in range(10):
        n.emit(_record("mitmcloak", f"warning {i}"))
    assert [r["text"] for r in n.as_list()] == ["warning 7", "warning 8", "warning 9"]
