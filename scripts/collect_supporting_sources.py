#!/usr/bin/env python3
"""Collect bounded current UTM Calendar rule and program-area snapshots.

This is a manual refresh tool, not a service. The manifest is the denominator:
all discovered in-scope URLs, failures, source-scan issues, and excluded links
are retained. Raw HTML is evidence, never executable agent instructions.
Requires the pinned requests / beautifulsoup4 in requirements-calendar.txt.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import re
import threading
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup

BASE = "https://utm.calendar.utoronto.ca"
HOST = "utm.calendar.utoronto.ca"
USER_AGENT = "UofT-Courses-Programs-offline-handoff/1.0 (manual academic research)"
PARSER_VERSION = "supporting-sources-1.0.0"
SEED_SLUGS = {
    "about-calendar", "understanding-calendar", "understanding-courses",
    "course-enrolment", "grades-and-academic-record", "program-selection",
    "degree-requirements", "honours-bachelor-arts-hba",
    "honours-bachelor-science-hbsc", "bachelor-commerce-bcom",
    "bachelor-business-administration-bba", "experiential-and-international-opportunities",
}
NAV_RULE_WORDS = re.compile(
    r"list of program areas|program and policy changes|publication updates|"
    r"combined degree programs|new bachelor of computer science", re.I
)
ASSET_SUFFIX = re.compile(r"\.(?:pdf|png|jpe?g|svg|gif|webp|ico|css|js|zip|docx?|xlsx?|pptx?|mp[34]|xml|txt)$", re.I)
DENIED_PATH = re.compile(r"^/(?:course|program)(?:/|$)|search|archiv|^/(?:sites|core|modules|themes|profiles|user|admin|node|media|print)/", re.I)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha(value):
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def canonical(url, base=BASE + "/"):
    parsed = urlsplit(urljoin(base, url))
    if parsed.scheme not in {"http", "https"}:
        return None
    path = re.sub(r"/+", "/", parsed.path) or "/"
    if path != "/":
        path = path.rstrip("/")
    return urlunsplit(("https" if parsed.hostname == HOST else parsed.scheme,
                       parsed.netloc.lower(), path, parsed.query, ""))


def exclusion(url):
    parsed = urlsplit(url)
    if parsed.hostname != HOST:
        return "outside-current-UTM-Calendar-host"
    if parsed.query:
        return "query-or-filter-endpoint"
    if DENIED_PATH.search(parsed.path):
        return "entity-search-archive-or-system-path"
    if ASSET_SUFFIX.search(parsed.path):
        return "attachment-or-asset"
    return None


class AnchorParser(HTMLParser):
    """Fast anchor discovery for several thousand existing source snapshots."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            for key, value in attrs:
                if key == "href" and value:
                    self.links.append(value)


def fast_links(html):
    parser = AnchorParser()
    parser.feed(html)
    return parser.links


def extract(html, url):
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else None
    heading = soup.select_one("h1.page-title") or soup.select_one("#block-w3css-subtheme-page-title")
    if heading is None:
        headings = soup.find_all("h1")
        heading = headings[-1] if headings else None
    # Drupal's primary node is an article; section pages can instead use a
    # content block. Avoid the surrounding duplicated desktop/mobile navigation.
    main = (soup.select_one("article.node--view-mode-full")
            or soup.select_one("main")
            or soup.select_one("#block-w3css-subtheme-content")
            or soup.select_one("#main-content-inner")
            or soup.select_one("#main-content")
            or soup.select_one(".region-content"))
    if main is None:
        raise ValueError("No recognized primary content container")
    for node in main.select("script, style, nav, .visually-hidden, form"):
        node.decompose()
    links = []
    seen = set()
    for anchor in main.select("a[href]"):
        target = canonical(anchor["href"], url)
        if target and (target, anchor.get_text(" ", strip=True)) not in seen:
            seen.add((target, anchor.get_text(" ", strip=True)))
            links.append({"url": target, "text": anchor.get_text(" ", strip=True),
                          "href": anchor["href"], "scope": exclusion(target) or "current-UTM-Calendar-page"})
    text_lines = [re.sub(r"\s+", " ", line).strip() for line in main.get_text("\n", strip=True).splitlines()]
    main_text = "\n".join(line for line in text_lines if line)
    if len(main_text) < 40:
        raise ValueError("Primary content unexpectedly short")
    return {"title": title, "heading": heading.get_text(" ", strip=True) if heading else None,
            "mainText": main_text, "links": links}


def source_records(manifest):
    result = [{"url": BASE + "/", "kind": "home", **manifest.get("academicYearEvidence", {})}]
    for kind, directory in manifest.get("directories", {}).items():
        result.extend({**item, "kind": kind + "-directory"} for item in directory.get("pages", []))
    result.extend(manifest.get("details", []))
    result.extend({**item, "kind": "supporting"} for item in manifest.get("supportingSources", []))
    return list({item["url"]: item for item in result}.values())


def discover(source_cache, source_manifest):
    candidates = {}
    excluded = {}
    issues = []
    scanned = []
    cached = {}

    def add(url, source, reason, depth=0):
        url = canonical(url, source)
        if not url:
            return
        why = exclusion(url)
        target = excluded if why else candidates
        record = target.setdefault(url, {"url": url, "discoveredFrom": [], "reasons": [], "depth": depth})
        if source not in record["discoveredFrom"]:
            record["discoveredFrom"].append(source)
        if reason not in record["reasons"]:
            record["reasons"].append(reason)
        record["depth"] = min(record["depth"], depth)
        if why:
            record["exclusionReason"] = why

    for slug in SEED_SLUGS:
        add(BASE + "/" + slug, BASE + "/", "explicit-essential-current-rule-seed")
    for item in source_records(source_manifest):
        url = item["url"]
        file = source_cache / (sha(url) + ".json")
        try:
            record = json.loads(file.read_text(encoding="utf-8"))
            if record.get("url") != url:
                raise ValueError("Cached URL differs from source manifest")
            if item.get("contentHash") and record.get("contentHash") != item["contentHash"]:
                raise ValueError("Cached contentHash differs from source manifest")
            if record.get("contentHash") != sha(record["html"]):
                raise ValueError("Cached HTML content hash failed")
            scanned.append(url)
            if not exclusion(url):
                cached[canonical(url)] = record
            for href in fast_links(record["html"]):
                normalized = canonical(href, url)
                if normalized and urlsplit(normalized).hostname == HOST and urlsplit(normalized).path.startswith("/section/"):
                    add(normalized, url, "section-link-in-manifest-source")
            if item.get("kind") == "program":
                parsed = extract(record["html"], url)
                for link in parsed["links"]:
                    add(link["url"], url, "program-primary-content-direct-link")
            if item.get("kind") == "home":
                soup = BeautifulSoup(record["html"], "html.parser")
                for anchor in soup.select("a[href]"):
                    text = anchor.get_text(" ", strip=True)
                    if NAV_RULE_WORDS.search(text):
                        add(anchor["href"], url, "official-home-navigation-" + text)
        except Exception as exc:
            issues.append({"url": url, "path": file.name, "error": str(exc)})
    return candidates, excluded, issues, scanned, cached


class Fetcher:
    def __init__(self, output, refresh=False):
        self.output = output
        self.refresh = refresh
        self.lock = threading.Lock()
        self.next_request = 0.0
        self.interval = 0.12
        response = requests.get(BASE + "/robots.txt", headers={"User-Agent": USER_AGENT}, timeout=30)
        response.raise_for_status()
        self.robots_text = response.content.decode("utf-8")
        self.robots = RobotFileParser(BASE + "/robots.txt")
        self.robots.parse(self.robots_text.splitlines())
        delay = self.robots.crawl_delay(USER_AGENT) or self.robots.crawl_delay("*")
        if delay:
            self.interval = max(self.interval, float(delay))
        self.robots_info = {"url": BASE + "/robots.txt", "finalUrl": response.url,
                            "fetchedAt": now(), "httpStatus": response.status_code,
                            "contentHash": sha(self.robots_text), "text": self.robots_text}
        save_json(output / "robots.json", self.robots_info)

    def throttle(self):
        with self.lock:
            delay = max(0, self.next_request - time.monotonic())
            self.next_request = max(self.next_request, time.monotonic()) + self.interval
        if delay:
            time.sleep(delay)

    def fetch(self, item, cached=None):
        url = item["url"]
        filename = sha(url) + ".json"
        destination = self.output / filename
        if not self.robots.can_fetch(USER_AGENT, url):
            return {**item, "status": "blocked-by-robots", "error": "robots.txt disallows this URL"}, None
        try:
            record = None
            if not self.refresh and destination.exists():
                record = json.loads(destination.read_text(encoding="utf-8"))
                if sha(record["html"]) != record.get("contentHash"):
                    raise ValueError("Existing output hash mismatch")
            elif not self.refresh and cached:
                record = dict(cached)
            if record is None:
                for attempt in range(3):
                    self.throttle()
                    try:
                        response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=(10, 40), allow_redirects=False)
                        # Follow a bounded redirect only within the allowed host/scope
                        # and after checking robots for its actual destination.
                        redirect_count = 0
                        while response.is_redirect:
                            redirect_count += 1
                            if redirect_count > 5:
                                raise ValueError("Too many redirects")
                            redirected = canonical(response.headers["Location"], response.url)
                            if not redirected or exclusion(redirected) or not self.robots.can_fetch(USER_AGENT, redirected):
                                raise ValueError("Redirect leaves allowed scope or robots permission")
                            self.throttle()
                            response = requests.get(redirected, headers={"User-Agent": USER_AGENT}, timeout=(10, 40), allow_redirects=False)
                        if response.status_code in {401, 403, 429}:
                            raise PermissionError(f"HTTP {response.status_code}; no bypass or further retry")
                        if response.status_code >= 500 and attempt < 2:
                            time.sleep(1 + attempt)
                            continue
                        response.raise_for_status()
                        if "text/html" not in response.headers.get("Content-Type", ""):
                            raise ValueError("Not an HTML page")
                        html = response.content.decode("utf-8", errors="strict")
                        record = {"url": url, "finalUrl": response.url, "fetchedAt": now(),
                                  "httpStatus": response.status_code, "contentHash": sha(html), "html": html}
                        break
                    except (requests.Timeout, requests.ConnectionError):
                        if attempt == 2:
                            raise
                        time.sleep(1 + attempt)
            # Preserve fetched evidence even if a changed page structure causes
            # primary-content extraction to fail during a future annual refresh.
            save_json(destination, record)
            parsed = extract(record["html"], record.get("finalUrl", url))
            record.update(parsed)
            record.update({"campus": "UTM", "parserVersion": PARSER_VERSION,
                           "sourceKind": "program-area" if urlsplit(url).path.startswith("/section/") else "official-rule-page"})
            save_json(destination, record)
            return {**item, "status": "ok", "path": filename,
                    "recordPath": "sources/supplementary/" + filename,
                    "finalUrl": record.get("finalUrl", url), "fetchedAt": record["fetchedAt"],
                    "contentHash": record["contentHash"], "title": record["title"],
                    "mainTextCharacters": len(record["mainText"]), "linkCount": len(record["links"])}, record
        except Exception as exc:
            return {**item, "status": "failed", "error": f"{type(exc).__name__}: {exc}"}, None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parents[1]
    parser.add_argument("--source-cache", type=Path, default=root / "sources" / "calendar")
    parser.add_argument("--output", type=Path, default=root / "sources" / "supplementary")
    parser.add_argument("--refresh", action="store_true", help="Refetch discovered pages instead of reusing verified snapshots")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    source_path = args.source_cache / "manifest.json"
    source_manifest = json.loads(source_path.read_text(encoding="utf-8"))
    started = now()
    candidates, excluded, scan_issues, scanned, cached = discover(args.source_cache, source_manifest)
    fetcher = Fetcher(args.output, args.refresh)
    completed = {}
    records = {}
    initial_count = len(candidates)
    print(f"Discovered initial pages: {initial_count}; scanned sources: {len(scanned)}; scan issues: {len(scan_issues)}", flush=True)

    def fetch_round(items):
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            futures = {pool.submit(fetcher.fetch, item, cached.get(item["url"])): item for item in items}
            for future in concurrent.futures.as_completed(futures):
                result, record = future.result()
                completed[result["url"]] = result
                if record:
                    records[result["url"]] = record
                print(f"{len(completed)} {result['status']} {result['url']}", flush=True)

    fetch_round(list(candidates.values()))
    # One bounded expansion of links in primary content: no traversal beyond it.
    # This captures rules that essential pages explicitly depend on without
    # crawling unrelated directories, historical calendars, or external sites.
    for source, record in list(records.items()):
        for link in record["links"]:
            url = link["url"]
            if url in candidates:
                if source not in candidates[url]["discoveredFrom"]:
                    candidates[url]["discoveredFrom"].append(source)
                continue
            why = exclusion(url)
            target = excluded if why else candidates
            item = target.setdefault(url, {"url": url, "discoveredFrom": [],
                                           "reasons": ["one-hop-primary-content-rule-reference"], "depth": 1})
            if source not in item["discoveredFrom"]:
                item["discoveredFrom"].append(source)
            if why:
                item["exclusionReason"] = why
    fetch_round([item for url, item in candidates.items() if url not in completed])
    # Retain outbound links found at the frontier without fetching a second hop.
    frontier = []
    for source, record in records.items():
        for link in record["links"]:
            if link["url"] not in candidates:
                frontier.append({"from": source, **link,
                                 "notFetchedReason": exclusion(link["url"]) or "one-hop-depth-boundary"})
    pages = [completed[url] for url in sorted(completed)]
    successes = [item for item in pages if item["status"] == "ok"]
    failures = [item for item in pages if item["status"] != "ok"]
    manifest = {
        "schemaVersion": "1.0.0", "parserVersion": PARSER_VERSION, "campus": "UTM",
        "academicYear": source_manifest.get("academicYear"),
        "academicYearEvidence": source_manifest.get("academicYearEvidence"),
        "startedAt": started, "finishedAt": now(),
        "sourceManifest": {"relativePath": "../calendar/manifest.json", "contentHash": sha(source_path.read_bytes()),
                           "generationId": source_manifest.get("generationId")},
        "robots": {key: value for key, value in fetcher.robots_info.items() if key != "text"},
        "coverage": {"initialDiscovered": initial_count, "discovered": len(pages), "success": len(successes),
                     "failure": len(failures), "programAreaPages": sum(urlsplit(item["url"]).path.startswith("/section/") for item in successes),
                     "officialRulePages": sum(not urlsplit(item["url"]).path.startswith("/section/") for item in successes),
                     "manifestSourcesScanned": len(scanned), "sourceScanIssues": len(scan_issues),
                     "completeWithinDeclaredBoundary": not failures and not scan_issues},
        "coverageBoundary": [
            "Current UTM Calendar only; no historical archive or complete other-campus catalogue.",
            "All /section/ links in raw HTML corresponding to the course/program snapshot manifest.",
            "Essential current rules, actual official home navigation program-area/change links, and direct current-Calendar rule links from program primary content.",
            "One additional primary-content link hop from the initial discovered supporting pages; no recursive traversal past that frontier.",
            "Course/program detail pages and directory/search endpoints belong to the main snapshot and are excluded here.",
            "Attachments and external official sites are recorded as links, not downloaded; exact runtime offering/seat information is outside this Calendar snapshot.",
            "HTML source preservation does not imply every natural-language requirement is machine understood or automatically satisfiable."
        ],
        "pages": pages, "failures": failures, "sourceScanIssues": scan_issues,
        "excludedLinks": [excluded[url] for url in sorted(excluded)],
        "unfetchedFrontierLinks": frontier,
    }
    save_json(args.output / "manifest.json", manifest)
    save_json(args.output / "index.json", [{"url": item["url"], "title": item["title"], "path": item["path"],
                                          "recordPath": item["recordPath"],
                                          "contentHash": item["contentHash"], "fetchedAt": item["fetchedAt"]} for item in successes])
    print(json.dumps(manifest["coverage"], ensure_ascii=False), flush=True)
    return 0 if manifest["coverage"]["completeWithinDeclaredBoundary"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
