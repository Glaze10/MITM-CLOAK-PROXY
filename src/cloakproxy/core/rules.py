"""Match & replace: rewrite traffic on its way through.

Each rule names where it applies (request or response, and which part of it), a
pattern, and what to put there instead. They run in order, every rule that
matches, so two rules can touch the same request.

The usual reasons: pin a User-Agent while you test, swap a host for staging,
strip a header that breaks a replay, or blank a token out of a capture before
you send it to someone.
"""
from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Optional

from mitmproxy import http

LOG = logging.getLogger("cloak")

WHERE = ("request", "response")
PARTS = ("url", "header", "body", "method", "status")


@dataclass
class Rule:
    id: str
    where: str = "request"        # request | response
    part: str = "header"          # url | header | body | method | status
    match: str = ""               # regex, or a header name when part == header
    replace: str = ""
    enabled: bool = True
    regex: bool = True
    name: str = ""                # what it's for, in your words

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class MatchReplace:
    """Addon: applies the rule list. Kept separate from the recorder so a bad
    rule can be turned off without touching how flows are captured."""

    def __init__(self) -> None:
        self.rules: list[Rule] = []
        self.hits: dict[str, int] = {}

    # ── rule list ────────────────────────────────────────────────────────────
    def set_rules(self, raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[Rule] = []
        for i, r in enumerate(raw or []):
            out.append(Rule(
                id=str(r.get("id") or f"r{i}"),
                where=r.get("where") if r.get("where") in WHERE else "request",
                part=r.get("part") if r.get("part") in PARTS else "header",
                match=str(r.get("match") or ""),
                replace=str(r.get("replace") or ""),
                enabled=bool(r.get("enabled", True)),
                regex=bool(r.get("regex", True)),
                name=str(r.get("name") or ""),
            ))
        self.rules = out
        return [r.as_dict() for r in self.rules]

    def list_rules(self) -> list[dict[str, Any]]:
        return [{**r.as_dict(), "hits": self.hits.get(r.id, 0)} for r in self.rules]

    # ── application ──────────────────────────────────────────────────────────
    def _sub(self, rule: Rule, text: str) -> tuple[str, bool]:
        if not rule.match:
            return text, False
        try:
            if rule.regex:
                new, n = re.subn(rule.match, rule.replace, text)
            else:
                n = text.count(rule.match)
                new = text.replace(rule.match, rule.replace)
        except re.error as exc:
            LOG.warning("match & replace: bad pattern in %s (%s)", rule.id, exc)
            return text, False
        return new, n > 0

    def _apply(self, rule: Rule, msg, flow: http.HTTPFlow) -> bool:
        hit = False
        if rule.part == "header":
            # match is the header NAME; an empty replacement removes it
            for name in list(msg.headers.keys()):
                if (re.fullmatch(rule.match, name, re.I) if rule.regex
                        else name.lower() == rule.match.lower()):
                    if rule.replace == "":
                        del msg.headers[name]
                    else:
                        msg.headers[name] = rule.replace
                    hit = True
        elif rule.part == "body":
            try:
                text = msg.get_text(strict=False) or ""
            except Exception:  # pylint: disable=broad-except
                return False
            new, hit = self._sub(rule, text)
            if hit:
                msg.text = new
        elif rule.part == "url" and rule.where == "request":
            new, hit = self._sub(rule, flow.request.url)
            if hit:
                flow.request.url = new
        elif rule.part == "method" and rule.where == "request":
            new, hit = self._sub(rule, flow.request.method)
            if hit:
                flow.request.method = new.strip().upper()
        elif rule.part == "status" and rule.where == "response" and flow.response:
            new, hit = self._sub(rule, str(flow.response.status_code))
            if hit and new.strip().isdigit():
                flow.response.status_code = int(new.strip())
        return hit

    def _run(self, flow: http.HTTPFlow, where: str) -> None:
        msg = flow.request if where == "request" else flow.response
        if msg is None:
            return
        for rule in self.rules:
            if not rule.enabled or rule.where != where:
                continue
            if self._apply(rule, msg, flow):
                self.hits[rule.id] = self.hits.get(rule.id, 0) + 1

    # ── mitmproxy hooks ──────────────────────────────────────────────────────
    def request(self, flow: http.HTTPFlow) -> None:
        self._run(flow, "request")

    def response(self, flow: http.HTTPFlow) -> None:
        self._run(flow, "response")
