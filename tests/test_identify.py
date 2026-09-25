"""The naming rules, pinned to handshakes that were actually captured.

Every fixture below is a real ClientHello recorded through the proxy, not a
guess about what a stack sends. If a rule starts matching the wrong thing, it
does so here first.
"""
from cloakproxy.core.identify import (
    describe, family_from_hello, shape_from_hello, stack_from_user_agent,
)


class Hello:
    """Just the fields the rules read."""

    def __init__(self, *, grease=False, ext=(), comp=(), limit=None,
                 versions=(0x0304,), alpn=("h2", "http/1.1")):
        self.has_grease = grease
        self.extension_order = tuple(ext)
        self.cert_compression = list(comp)
        self.record_size_limit = limit
        self.supported_versions = list(versions)
        self.alpn = list(alpn)


# captured 2026-09-25 through Cloak, one request each
CHROME = Hello(grease=True, comp=["brotli"],
               ext=[43, 35, 45, 27, 23, 16, 5, 51, 18, 65037, 13, 65281, 10, 17613, 11, 0])
CHROME_ANDROID = Hello(grease=True, comp=["brotli"],
                       ext=[43, 51, 18, 23, 65281, 17613, 10, 27, 65037, 45, 13, 16, 35, 5, 11, 0])
FIREFOX = Hello(grease=False, comp=["zlib", "brotli", "zstd"], limit=16385,
                ext=[0, 23, 65281, 10, 11, 35, 16, 5, 34, 18, 51, 43, 13, 45, 28, 27, 65037])
SAFARI_IOS = Hello(grease=True, comp=["zlib"],
                   ext=[0, 23, 65281, 10, 11, 16, 5, 13, 18, 51, 45, 43, 27])
OPENSSL = Hello(grease=False, comp=[], alpn=[],
                ext=[0, 11, 10, 35, 22, 23, 13, 43, 45, 51, 21])


def test_each_captured_stack_is_recognised():
    assert family_from_hello(CHROME) == "chromium-based"
    assert family_from_hello(CHROME_ANDROID) == "chromium-based"
    assert family_from_hello(FIREFOX) == "firefox-based"
    assert family_from_hello(SAFARI_IOS) == "apple-stack"
    assert family_from_hello(OPENSSL) == "openssl-based"


def test_the_families_do_not_overlap():
    """Each rule must reject every other stack, not merely accept its own."""
    for hello, expected in ((CHROME, "chromium-based"), (FIREFOX, "firefox-based"),
                            (SAFARI_IOS, "apple-stack"), (OPENSSL, "openssl-based")):
        assert family_from_hello(hello) == expected


def test_an_unfamiliar_stack_is_not_forced_into_a_family():
    # GREASE and h2, but none of the hallmarks — plenty of app stacks look like this
    assert family_from_hello(Hello(grease=True, ext=[0, 10, 11, 43, 51])) == ""


def test_a_named_library_is_taken_at_its_word():
    assert stack_from_user_agent("okhttp/4.12.0") == "okhttp/4.12.0"
    assert stack_from_user_agent(
        "MyApp/7.2 CFNetwork/1498.700.2 Darwin/23.6.0") == "CFNetwork/1498.700.2"
    assert stack_from_user_agent("Dart/3.3 (dart:io)") == "Dart/3.3"
    assert stack_from_user_agent("python-requests/2.31.0") == "python-requests/2.31.0"


def test_a_browser_user_agent_names_no_stack():
    """It names a browser, and the handshake answers that question properly."""
    assert stack_from_user_agent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36") == ""
    assert stack_from_user_agent("") == ""


def test_shape_says_only_what_is_certain():
    assert shape_from_hello(CHROME) == "TLS 1.3 · h2"
    assert shape_from_hello(OPENSSL) == "TLS 1.3"
    assert shape_from_hello(Hello(versions=[0x0303], alpn=["http/1.1"])) == "TLS 1.2 · http/1.1"


def test_the_user_agent_wins_over_the_handshake_family():
    """A library that names itself is more specific than "apple-stack"."""
    label = describe(SAFARI_IOS, "Grubhub/2024.41 CFNetwork/1498.700.2 Darwin/23.6.0")
    assert label == ("CFNetwork/1498.700.2", "ua")


def test_every_answer_says_where_it_came_from():
    assert describe(CHROME, "").source == "family"
    assert describe(Hello(grease=True, ext=[0, 43]), "").source == "shape"
    assert describe(None, "").text == ""
