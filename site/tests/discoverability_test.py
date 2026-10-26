"""Validate actual Next build output: HOME=$(mktemp -d) python3 -m unittest discover -s site/tests -p '*_test.py'."""
import json
import re
import unittest
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "site/.next/server/app"
BASE = "https://plugin.ashlr.ai"


class Page(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.canonicals = []
        self.headings = []
        self.meta = {}
        self.schemas = []
        self.schema = None
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "link" and attrs.get("rel") == "canonical":
            self.canonicals.append(attrs.get("href"))
        if re.fullmatch(r"h[1-6]", tag):
            self.headings.append(int(tag[1]))
        if tag == "meta":
            self.meta[attrs.get("name", attrs.get("property"))] = attrs.get("content")
        if tag == "script" and attrs.get("type") == "application/ld+json":
            self.schema = ""

    def handle_data(self, data):
        if self.schema is not None:
            self.schema += data

    def handle_endtag(self, tag):
        if tag == "script" and self.schema is not None:
            self.schemas.append(json.loads(self.schema))
            self.schema = None


class Discoverability(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sitemap = ET.fromstring((BUILD / "sitemap.xml.body").read_text())
        cls.urls = [node.text for node in cls.sitemap.findall("{*}url/{*}loc")]

    def test_sitemap_xml(self):
        self.assertEqual(self.sitemap.tag, "{http://www.sitemaps.org/schemas/sitemap/0.9}urlset")
        self.assertGreater(len(self.urls), 100)
        self.assertEqual(len(self.urls), len(set(self.urls)))
        self.assertIn(BASE + "/docs/capabilities", self.urls)
        self.assertIn(BASE + "/community", self.urls)
        manifest = json.loads((ROOT / "site/.next/prerender-manifest.json").read_text())
        for route in manifest["routes"]:
            if re.match(r"^/(admin|auth|billing|dashboard|signin|status|_not-found)(/|$)", route):
                continue
            if (BUILD / ((route.strip("/") or "index") + ".html")).exists():
                self.assertIn(BASE + route.rstrip("/"), self.urls, "Public page omitted from sitemap")
        for url in self.urls:
            self.assertEqual(urlparse(url).netloc, "plugin.ashlr.ai")
            self.assertFalse(urlparse(url).query or urlparse(url).fragment)
            self.assertNotRegex(urlparse(url).path, r"^/(admin|auth|billing|dashboard|signin)(/|$)")

    def test_every_public_page(self):
        for url in self.urls:
            with self.subTest(url=url):
                path = urlparse(url).path.strip("/") or "index"
                page = Page((BUILD / (path + ".html")).read_text())
                self.assertEqual(page.canonicals, [url])
                self.assertEqual(page.headings.count(1), 1)
                self.assertTrue(page.meta.get("description"))
                self.assertTrue(page.meta.get("og:title"))
                self.assertTrue(page.meta.get("og:description"))
                self.assertEqual(page.meta.get("og:url"), page.canonicals[0])
                for previous, current in zip([0] + page.headings, page.headings):
                    self.assertLessEqual(current, previous + 1, f"Heading jump: {page.headings}")

    def test_software_json_ld(self):
        page = Page((BUILD / "index.html").read_text())
        apps = [item for schema in page.schemas for item in schema.get("@graph", []) if "SoftwareApplication" in item.get("@type", [])]
        self.assertEqual(len(apps), 1)
        app = apps[0]
        self.assertEqual(app["name"], "ashlr")
        package = json.loads((ROOT / "package.json").read_text())
        self.assertEqual(app["softwareVersion"], package["version"])
        self.assertEqual(app["alternateName"], package["name"])
        self.assertEqual(app["license"], "https://opensource.org/licenses/" + package["license"])
        self.assertEqual(app["codeRepository"], package["repository"]["url"].removeprefix("git+").removesuffix(".git"))
        self.assertEqual(app["operatingSystem"], "macOS, Linux, Windows")
        free = [offer for offer in app["offers"] if float(offer["price"]) == 0]
        self.assertEqual(len(free), 1)
        self.assertEqual(free[0]["name"], "Free")
        self.assertIn("No account required", (ROOT / "README.md").read_text())

    def test_llms_index_and_full_content(self):
        index = (BUILD / "llms.txt.body").read_text()
        full = (BUILD / "llms-full.txt.body").read_text()
        self.assertTrue(index.startswith("# ashlr-plugin\n\n> "))
        self.assertEqual(len(re.findall(r"^# ", index, re.M)), 1)
        self.assertNotIn("\u2014", index)
        links = re.findall(r"^- \[([^\]]+)\]\((https://[^)]+)\): (.+)$", index, re.M)
        self.assertGreater(len(links), 100)
        linked_urls = {url for _, url, _ in links}
        for url in self.urls:
            if urlparse(url).path.startswith("/docs"):
                self.assertIn(url, linked_urls)
                self.assertIn("Source: " + url + "\n", full)
        self.assertIn((ROOT / "README.md").read_text().strip(), full)
        for source in (ROOT / "site/content/docs").rglob("*.mdx"):
            body = re.sub(r"^---\n[\s\S]*?\n---\n", "", source.read_text()).strip()
            self.assertIn(body, full, str(source.relative_to(ROOT)))
        self.assertIn("npm install -g ashlr-plugin", full)
        self.assertIn("Capabilities; Install; Verify your installation; Agent entry points", index)


if __name__ == "__main__":
    unittest.main()
