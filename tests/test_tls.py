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


def test_switching_identity_does_not_rebuild_the_proxy():
    """The whole point of configure(): mirror <-> preset without a restart.

    The cloak reads its mode and preset per request, so a switch is an option
    update. If this ever goes back through start(), the interface goes quiet for
    a second and every open connection is dropped on a radio-button click.
    """
    import asyncio

    async def go():
        pm = ProxyManager(lambda *a: None)
        state = await pm.start(port=8097, mode="auto", preset="chrome-151")
        assert state["running"], state["error"]
        master, task = pm.master, pm._task
        try:
            after = await pm.configure(mode="static", preset="firefox-latest")
            assert (after["mode"], after["preset"]) == ("static", "firefox-latest")
            assert pm.master is master and pm._task is task   # same proxy, still up
            assert pm.master.options.mitmcloak_mode == "static"
            assert pm.master.options.mitmcloak_preset == "firefox-latest"

            back = await pm.configure(mode="auto")
            assert back["mode"] == "auto" and back["preset"] == "firefox-latest"
            assert pm.master is master and pm.running
        finally:
            await pm.stop()

    asyncio.run(go())


def test_port_list_is_cleaned_before_it_reaches_mitmproxy():
    """Duplicates make mitmproxy refuse every listener, not just the repeat."""
    clean = ProxyManager._clean_ports
    fallback = [{"port": 8080, "on": True}]

    assert clean([{"port": "8081", "on": False}], fallback) == [{"port": 8081, "on": False}]
    assert clean([8080, 8080, 8081], fallback) == [
        {"port": 8080, "on": True}, {"port": 8081, "on": True}]
    assert clean([{"port": 0}, {"port": 70000}, {"port": "nope"}], fallback) == fallback
    assert clean([], fallback) == fallback
    assert clean(None, fallback) == fallback


def test_the_quoted_port_is_one_that_is_actually_listening():
    pm = ProxyManager(lambda *a: None)
    pm.ports = [{"port": 8080, "on": False}, {"port": 8081, "on": True}]
    assert pm.listening == [8081]
    assert pm.port == 8081                      # not the switched-off one
    assert pm._modes() == ["regular@0.0.0.0:8081"]

    pm.ports = [{"port": 8080, "on": False}]
    assert pm.listening == [] and pm._modes() == []
    assert pm.port == 8080                      # something still has to be quoted


class _FakeBridge:
    """Stands in for the cloak's addon: a client it knows, and one it doesn't."""

    def __init__(self, recognised):
        self._recognised = recognised
        self._profiles = {"conn-1": type("P", (), {"hello": type("H", (), {
            "family_id": "fam-1"})()})()}
        self.identifier = self
        self.mirror = self

    def match(self, family_id):                    # identifier.match
        return "chrome-151-windows" if self._recognised else None

    def document(self, name):                      # mirror.document
        return {"version": 1, "preset": {"name": name, "based_on": "chrome-151-android"}}


class _FakeFlow:
    client_conn = type("C", (), {"id": "conn-1"})()


def test_a_built_in_preset_names_itself():
    pm = ProxyManager(lambda *a: None)
    assert pm.preset_label("chrome-151", _FakeFlow()) == "chrome-151"
    assert pm.preset_label("", _FakeFlow()) == ""


def test_a_recognised_client_is_named_by_the_build_the_cloak_chose():
    pm = ProxyManager(lambda *a: None)
    pm.bridge = _FakeBridge(recognised=True)
    # the platform comes from the User-Agent, so the answer is the refined base,
    # not the TLS family the handshake alone matched
    assert pm.preset_label("mc-abc123", _FakeFlow()) == "chrome-151-android"


def test_an_unrecognised_client_is_not_given_a_name_it_does_not_have():
    pm = ProxyManager(lambda *a: None)
    pm.bridge = _FakeBridge(recognised=False)
    # its handshake is still its own on the wire; there is simply no name for it,
    # and the fallback preset's name would be a lie
    assert pm.preset_label("mc-abc123", _FakeFlow()) == ""
