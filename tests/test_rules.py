"""Match & replace rewrites live traffic, so its edges are worth pinning down."""
from mitmproxy.test import tflow, tutils

from cloakproxy.core.rules import MatchReplace


def flow(**kw):
    f = tflow.tflow(req=tutils.treq(**kw))
    return f


def test_header_rule_sets_and_removes():
    mr = MatchReplace()
    mr.set_rules([
        {"id": "ua", "where": "request", "part": "header", "match": "User-Agent",
         "replace": "Cloak/1.0", "regex": False},
        {"id": "drop", "where": "request", "part": "header", "match": "Accept-Encoding",
         "replace": "", "regex": False},
    ])
    f = flow()
    f.request.headers["User-Agent"] = "python-requests/2"
    f.request.headers["Accept-Encoding"] = "gzip"
    mr.request(f)
    assert f.request.headers["User-Agent"] == "Cloak/1.0"
    assert "Accept-Encoding" not in f.request.headers


def test_url_rule_can_point_somewhere_else():
    mr = MatchReplace()
    mr.set_rules([{"id": "env", "where": "request", "part": "url",
                   "match": r"//prod\.", "replace": "//staging.", "regex": True}])
    f = flow(host="prod.example.com")
    f.request.url = "https://prod.example.com/v1/order"
    mr.request(f)
    assert f.request.url == "https://staging.example.com/v1/order"


def test_body_rule_rewrites_and_counts_hits():
    mr = MatchReplace()
    mr.set_rules([{"id": "tok", "where": "request", "part": "body",
                   "match": "secret", "replace": "REDACTED", "regex": False}])
    f = flow()
    f.request.content = b'{"token": "secret", "again": "secret"}'
    mr.request(f)
    assert b"REDACTED" in f.request.content and b"secret" not in f.request.content
    assert mr.list_rules()[0]["hits"] == 1


def test_disabled_rule_does_nothing():
    mr = MatchReplace()
    mr.set_rules([{"id": "off", "where": "request", "part": "header", "match": "X",
                   "replace": "y", "enabled": False, "regex": False}])
    f = flow()
    f.request.headers["X"] = "keep"
    mr.request(f)
    assert f.request.headers["X"] == "keep"


def test_a_bad_pattern_is_survivable():
    """A typo in a regex shouldn't take the proxy down mid-capture."""
    mr = MatchReplace()
    mr.set_rules([{"id": "bad", "where": "request", "part": "body",
                   "match": "([unclosed", "replace": "x", "regex": True}])
    f = flow()
    f.request.content = b"hello"
    mr.request(f)                      # must not raise
    assert f.request.content == b"hello"


def test_rules_only_touch_their_own_side():
    mr = MatchReplace()
    mr.set_rules([{"id": "resp", "where": "response", "part": "header",
                   "match": "Server", "replace": "none", "regex": False}])
    f = flow()
    f.request.headers["Server"] = "keep-me"
    mr.request(f)
    assert f.request.headers["Server"] == "keep-me"
