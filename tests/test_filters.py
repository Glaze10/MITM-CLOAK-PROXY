"""The filter is the piece most likely to quietly start lying, so it gets tests."""
from cloakproxy.core.filters import Filter, apply

ROWS = [
    {"id": "1", "method": "GET", "host": "api.example.com", "path": "/v1/menu",
     "url": "https://api.example.com/v1/menu", "status": 200, "mime": "application/json",
     "size": 900, "marked": ""},
    {"id": "2", "method": "POST", "host": "api.example.com", "path": "/v1/checkout",
     "url": "https://api.example.com/v1/checkout", "status": 400, "mime": "application/json",
     "size": 120, "marked": "red"},
    {"id": "3", "method": "GET", "host": "cdn.example.com", "path": "/logo.png",
     "url": "https://cdn.example.com/logo.png", "status": 200, "mime": "image/png",
     "size": 40_000, "marked": ""},
    {"id": "4", "method": "GET", "host": "beacon.tracker.io", "path": "/t",
     "url": "https://beacon.tracker.io/t", "status": 204, "mime": "", "size": 0,
     "marked": "", "intercepted": True, "state": "paused"},
]

ids = lambda rows: [r["id"] for r in rows]


def test_nothing_set_keeps_everything():
    f = Filter({})
    assert not f.active
    assert ids(apply(ROWS, {})) == ["1", "2", "3", "4"]


def test_method_and_status_narrow_together():
    assert ids(apply(ROWS, {"methods": ["POST"]})) == ["2"]
    assert ids(apply(ROWS, {"status_classes": ["4", "5"]})) == ["2"]
    # 204 counts as 2xx, so the beacon belongs here too
    assert ids(apply(ROWS, {"methods": ["GET"], "status_classes": ["2"]})) == ["1", "3", "4"]


def test_status_range():
    assert ids(apply(ROWS, {"status_min": 300})) == ["2"]
    assert ids(apply(ROWS, {"status_min": 200, "status_max": 204})) == ["1", "3", "4"]


def test_text_matches_url_method_status_and_type():
    assert ids(apply(ROWS, {"text": "checkout"})) == ["2"]
    assert ids(apply(ROWS, {"text": "post"})) == ["2"]
    assert ids(apply(ROWS, {"text": "image"})) == ["3"]


def test_hide_noise_drops_assets_by_mime_and_extension():
    assert "3" not in ids(apply(ROWS, {"hide_noise": True}))
    rows = [{**ROWS[0], "id": "js", "url": "https://x/app.js", "mime": ""}]
    assert apply(rows, {"hide_noise": True}) == []


def test_exclude_is_a_substring_of_the_url():
    assert ids(apply(ROWS, {"exclude": ["tracker.io"]})) == ["1", "2", "3"]


def test_marks_and_colours():
    assert ids(apply(ROWS, {"marked_only": True})) == ["2"]
    assert ids(apply(ROWS, {"colours": ["red"]})) == ["2"]
    assert ids(apply(ROWS, {"colours": ["blue"]})) == []


def test_only_paused_and_has_body():
    assert ids(apply(ROWS, {"only_paused": True})) == ["4"]
    assert "4" not in ids(apply(ROWS, {"has_body": True}))


def test_describe_lists_what_is_narrowing():
    chips = Filter({"methods": ["POST"], "status_classes": ["4"], "host": "api"}).describe()
    assert "POST" in chips and "4xx" in chips and "host~api" in chips


def test_body_search_is_separate_because_it_costs_a_decode():
    f = Filter({"body": "token"})
    assert f.needs_bodies()
    assert f.body_matches('{"token": 1}', "")
    assert f.body_matches("", "TOKEN in the response")
    assert not f.body_matches("nothing", "here either")
