#!/usr/bin/env python3
"""Validate production HTML and sitemap after `bun run build`. No network needed."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse
from datetime import datetime
import xml.etree.ElementTree as ET
import re

BASE = "https://plugin.ashlr.ai"
BUILD = Path(__file__).resolve().parents[1] / ".next/server/app"


class Page(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.canonicals, self.links, self.claims = [], [], []
        self.claim = None
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "link" and attrs.get("rel") == "canonical":
            self.canonicals.append(attrs.get("href"))
        if tag == "section" and "data-claim" in attrs:
            assert self.claim is None, "Nested claim blocks"
            self.claim = []
        if tag == "a":
            href = attrs.get("href", "")
            self.links.append(href)
            if self.claim is not None and "data-source" in attrs:
                self.claim.append(href)

    def handle_endtag(self, tag):
        if tag == "section" and self.claim is not None:
            self.claims.append(self.claim)
            self.claim = None


def normalized_url(value):
    # URL serialization makes an empty origin path equivalent to "/".
    # Keep every non-root path, query and fragment exact.
    parsed = urlparse(value)
    return parsed._replace(path=parsed.path or "/").geturl()


def validate():
    sitemap = ET.fromstring((BUILD / "sitemap.xml.body").read_text())
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    assert sitemap.tag == "{" + ns["s"] + "}urlset"
    urls = sitemap.findall("s:url", ns)
    assert urls, "Empty sitemap"
    seen = set()
    workflows = 0
    claim_count = 0
    for entry in urls:
        url = entry.findtext("s:loc", namespaces=ns)
        parsed = urlparse(url)
        assert parsed.scheme == "https" and parsed.netloc == "plugin.ashlr.ai", url
        assert not parsed.query and not parsed.fragment, url
        assert url not in seen, f"Duplicate URL: {url}"
        seen.add(url)
        lastmod = entry.findtext("s:lastmod", namespaces=ns)
        assert lastmod and datetime.fromisoformat(lastmod.replace("Z", "+00:00")), url
        route = parsed.path.strip("/") or "index"
        artifact = BUILD / (route + ".html")
        assert artifact.exists(), f"Sitemap points to a missing page: {url}"
        page = Page(artifact.read_text())
        assert [normalized_url(value) for value in page.canonicals] == [normalized_url(url)], (url, page.canonicals)
        if route.startswith("use-cases/"):
            workflows += 1
            assert len(page.claims) >= 1, f"No claim blocks: {url}"
            claim_count += len(page.claims)
            for sources in page.claims:
                assert sources, f"Unsourced claim: {url}"
                for source in sources:
                    if source.startswith("/docs/"):
                        assert (BUILD / (source.lstrip("/") + ".html")).exists(), source
                    else:
                        code = re.fullmatch(r"https://github\.com/ashlrai/ashlr-plugin/blob/[a-f0-9]{40}/(servers/[a-z-]+\.ts)(?:#L\d+(?:-L\d+)?)?", source)
                        assert code, f"Unapproved claim source: {source}"
                        assert (Path(__file__).resolve().parents[2] / code[1]).is_file(), source
            for link in page.links:
                if link.startswith("/") and not link.startswith("//"):
                    target = urlparse(link).path.strip("/") or "index"
                    assert (BUILD / (target + ".html")).is_file(), f"Broken internal link: {link}"
            assert "/docs" in page.links and "/docs/getting-started/install" in page.links
            assert "/#install" in page.links
            assert sum(link.startswith("/use-cases/") for link in page.links) >= 2
    assert 2 <= workflows <= 4, workflows
    html_files = list(BUILD.rglob("*.html"))
    for artifact in html_files:
        page = Page(artifact.read_text())
        assert len(page.canonicals) == 1, f"Missing or duplicate canonical: {artifact}"
        assert page.canonicals[0].startswith("https://"), artifact
        route = "/" + artifact.relative_to(BUILD).as_posix().removesuffix(".html")
        if route == "/index":
            route = "/"
        private = route.startswith(("/admin", "/auth", "/billing", "/dashboard", "/signin", "/_"))
        if not private and not route.startswith("/status"):
            assert BASE + route in seen, f"Public page missing from sitemap: {route}"
    print(f"PASS: {len(urls)} unique sitemap URLs, {workflows} workflows, {claim_count} sourced claims, {len(html_files)} pages with absolute canonicals")


if __name__ == "__main__":
    validate()
