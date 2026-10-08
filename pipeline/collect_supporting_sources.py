"""Collect bounded snapshots of one campus calendar's official rule and program-area pages.

This is a manual refresh tool, not a service. The manifest is the denominator:
all discovered in-scope URLs, failures, source-scan issues, and excluded links
are retained. Raw HTML is evidence, never executable agent instructions.
Requires the pinned requests / beautifulsoup4 in pipeline/requirements.txt.

  python -I pipeline supporting --campus utm [--refresh]
"""
from __future__ import annotations

if __name__ == '__main__' and not __package__:
    raise SystemExit('Run from the repository root: python -I pipeline supporting --help')

import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import re
import time
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup
import requests

from . import http
from .campuses import ROOT, UTM, Campus, campus_keys, get_campus
from .files import now, read_json, sha256, write_json

PARSER_VERSION = 'supporting-sources-1.1.0'
ASSET_SUFFIX = re.compile(r"\.(?:pdf|png|jpe?g|svg|gif|webp|ico|css|js|zip|docx?|xlsx?|pptx?|mp[34]|xml|txt)$", re.I)
DENIED_PATH = re.compile(r"^/(?:course|program)(?:/|$)|search|archiv|^/(?:sites|core|modules|themes|profiles|user|admin|node|media|print)/", re.I)


def save_json(path, value):
    write_json(path, value, trailing_newline=True)


def repo_path(path: Path):
    """POSIX path relative to the repository root (stable across machines)."""
    return os.path.relpath(path, ROOT).replace('\\', '/')


def canonical(url, campus: Campus = UTM, base=None):
    parsed = urlsplit(urljoin(base or campus.calendar_url, url))
    if parsed.scheme not in {"http", "https"}:
        return None
    path = re.sub(r"/+", "/", parsed.path) or "/"
    if path != "/":
        path = path.rstrip("/")
    return urlunsplit(("https" if parsed.hostname == campus.host else parsed.scheme,
                       parsed.netloc.lower(), path, parsed.query, ""))


def exclusion(url, campus: Campus = UTM):
    parsed = urlsplit(url)
    if parsed.hostname != campus.host:
        return f"outside-current-{campus.id}-Calendar-host"
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


def extract(html, url, campus: Campus = UTM):
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
        target = canonical(anchor["href"], campus, url)
        if target and (target, anchor.get_text(" ", strip=True)) not in seen:
            seen.add((target, anchor.get_text(" ", strip=True)))
            links.append({"url": target, "text": anchor.get_text(" ", strip=True),
                          "href": anchor["href"], "scope": exclusion(target, campus) or f"current-{campus.id}-Calendar-page"})
    text_lines = [re.sub(r"\s+", " ", line).strip() for line in main.get_text("\n", strip=True).splitlines()]
    main_text = "\n".join(line for line in text_lines if line)
    if len(main_text) < 40:
        raise ValueError("Primary content unexpectedly short")
    return {"title": title, "heading": heading.get_text(" ", strip=True) if heading else None,
            "mainText": main_text, "links": links}


def source_records(manifest, campus: Campus = UTM):
    result = [{"url": campus.calendar_url, "kind": "home", **manifest.get("academicYearEvidence", {})}]
    for kind, directory in manifest.get("directories", {}).items():
        result.extend({**item, "kind": kind + "-directory"} for item in directory.get("pages", []))
    result.extend(manifest.get("details", []))
    result.extend({**item, "kind": "supporting"} for item in manifest.get("supportingSources", []))
    return list({item["url"]: item for item in result}.values())


def discover(source_cache, source_manifest, campus: Campus = UTM):
    candidates = {}
    excluded = {}
    issues = []
    scanned = []
    cached = {}
    nav_words = re.compile(campus.nav_rule_words_re, re.I) if campus.nav_rule_words_re else None

    def add(url, source, reason, depth=0):
        url = canonical(url, campus, source)
        if not url:
            return
        why = exclusion(url, campus)
        target = excluded if why else candidates
        record = target.setdefault(url, {"url": url, "discoveredFrom": [], "reasons": [], "depth": depth})
        if source not in record["discoveredFrom"]:
            record["discoveredFrom"].append(source)
        if reason not in record["reasons"]:
            record["reasons"].append(reason)
        record["depth"] = min(record["depth"], depth)
        if why:
            record["exclusionReason"] = why

    for slug in sorted(campus.seed_slugs):
        add(campus.base_url + "/" + slug, campus.calendar_url, "explicit-essential-current-rule-seed")
    for item in source_records(source_manifest, campus):
        url = item["url"]
        file = source_cache / (sha256(url) + ".json")
        try:
            record = read_json(file)
            if record.get("url") != url:
                raise ValueError("Cached URL differs from source manifest")
            if item.get("contentHash") and record.get("contentHash") != item["contentHash"]:
                raise ValueError("Cached contentHash differs from source manifest")
            if record.get("contentHash") != sha256(record["html"]):
                raise ValueError("Cached HTML content hash failed")
            scanned.append(url)
            if not exclusion(url, campus):
                cached[canonical(url, campus)] = record
            for href in fast_links(record["html"]):
                normalized = canonical(href, campus, url)
                if normalized and urlsplit(normalized).hostname == campus.host and urlsplit(normalized).path.startswith("/section/"):
                    add(normalized, url, "section-link-in-manifest-source")
            if item.get("kind") == "program":
                parsed = extract(record["html"], url, campus)
                for link in parsed["links"]:
                    add(link["url"], url, "program-primary-content-direct-link")
            if item.get("kind") == "home" and nav_words:
                soup = BeautifulSoup(record["html"], "html.parser")
                for anchor in soup.select("a[href]"):
                    text = anchor.get_text(" ", strip=True)
                    if nav_words.search(text):
                        add(anchor["href"], url, "official-home-navigation-" + text)
        except Exception as exc:
            issues.append({"url": url, "path": file.name, "error": str(exc)})
    return candidates, excluded, issues, scanned, cached


class Fetcher:
    def __init__(self, campus: Campus, output, refresh=False):
        self.campus = campus
        self.output = output
        self.refresh = refresh
        self.robots, self.robots_info = http.load_robots(campus.base_url)
        save_json(output / "robots.json", self.robots_info)

    def fetch(self, item, cached=None):
        url = item["url"]
        filename = sha256(url) + ".json"
        destination = self.output / filename
        if not http.allowed(self.robots, url):
            return {**item, "status": "blocked-by-robots", "error": "robots.txt disallows this URL"}, None
        try:
            record = None
            if not self.refresh and destination.exists():
                record = read_json(destination)
                if sha256(record["html"]) != record.get("contentHash"):
                    raise ValueError("Existing output hash mismatch")
            elif not self.refresh and cached:
                record = dict(cached)
            if record is None:
                for attempt in range(3):
                    try:
                        response = http.get(url, timeout=(10, 40), allow_redirects=False)
                        # Follow a bounded redirect only within the allowed host/scope
                        # and after checking robots for its actual destination.
                        redirect_count = 0
                        while response.is_redirect:
                            redirect_count += 1
                            if redirect_count > 5:
                                raise ValueError("Too many redirects")
                            redirected = canonical(response.headers["Location"], self.campus, response.url)
                            if not redirected or exclusion(redirected, self.campus) or not http.allowed(self.robots, redirected):
                                raise ValueError("Redirect leaves allowed scope or robots permission")
                            response = http.get(redirected, timeout=(10, 40), allow_redirects=False)
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
                                  "httpStatus": response.status_code, "contentHash": sha256(html), "html": html}
                        break
                    except (requests.Timeout, requests.ConnectionError):
                        if attempt == 2:
                            raise
                        time.sleep(1 + attempt)
            # Preserve fetched evidence even if a changed page structure causes
            # primary-content extraction to fail during a future annual refresh.
            save_json(destination, record)
            parsed = extract(record["html"], record.get("finalUrl", url), self.campus)
            record.update(parsed)
            record.update({"campus": self.campus.id, "parserVersion": PARSER_VERSION,
                           "sourceKind": "program-area" if urlsplit(url).path.startswith("/section/") else "official-rule-page"})
            save_json(destination, record)
            return {**item, "status": "ok", "path": filename,
                    "recordPath": repo_path(destination),
                    "finalUrl": record.get("finalUrl", url), "fetchedAt": record["fetchedAt"],
                    "contentHash": record["contentHash"], "title": record["title"],
                    "mainTextCharacters": len(record["mainText"]), "linkCount": len(record["links"])}, record
        except Exception as exc:
            return {**item, "status": "failed", "error": f"{type(exc).__name__}: {exc}"}, None


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--campus", default="utm", choices=campus_keys(), help="Campus adapter (default: utm)")
    parser.add_argument("--allow-planned", action="store_true", help="Run a planned (unverified) campus adapter experimentally")
    parser.add_argument("--source-cache", type=Path, default=None, help="Calendar cache with manifest.json (default: the campus cache)")
    parser.add_argument("--output", type=Path, default=None, help="Output folder (default: the campus supplementary cache)")
    parser.add_argument("--refresh", action="store_true", help="Refetch discovered pages instead of reusing verified snapshots")
    parser.add_argument("--workers", type=int, default=2, choices=range(1, 4),
                        help="Concurrent workers (default 2); requests are globally paced at >= 0.5 s regardless")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    campus = get_campus(args.campus)
    campus.require_supported(args.allow_planned)
    source_cache = args.source_cache or campus.cache_dir
    output = args.output or campus.supplementary_dir
    output.mkdir(parents=True, exist_ok=True)
    source_path = source_cache / "manifest.json"
    source_manifest = read_json(source_path)
    started = now()
    candidates, excluded, scan_issues, scanned, cached = discover(source_cache, source_manifest, campus)
    fetcher = Fetcher(campus, output, args.refresh)
    completed = {}
    records = {}
    initial_count = len(candidates)
    print(f"Discovered initial pages: {initial_count}; scanned sources: {len(scanned)}; scan issues: {len(scan_issues)}", flush=True)

    def fetch_round(items):
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
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
            why = exclusion(url, campus)
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
                                 "notFetchedReason": exclusion(link["url"], campus) or "one-hop-depth-boundary"})
    pages = [completed[url] for url in sorted(completed)]
    successes = [item for item in pages if item["status"] == "ok"]
    failures = [item for item in pages if item["status"] != "ok"]
    manifest = {
        "schemaVersion": "1.0.0", "parserVersion": PARSER_VERSION, "campus": campus.id,
        "academicYear": source_manifest.get("academicYear"),
        "academicYearEvidence": source_manifest.get("academicYearEvidence"),
        "startedAt": started, "finishedAt": now(),
        "sourceManifest": {"relativePath": os.path.relpath(source_path, output).replace("\\", "/"),
                           "contentHash": sha256(source_path.read_bytes()),
                           "generationId": source_manifest.get("generationId")},
        "robots": {key: value for key, value in fetcher.robots_info.items() if key != "text"},
        "coverage": {"initialDiscovered": initial_count, "discovered": len(pages), "success": len(successes),
                     "failure": len(failures), "programAreaPages": sum(urlsplit(item["url"]).path.startswith("/section/") for item in successes),
                     "officialRulePages": sum(not urlsplit(item["url"]).path.startswith("/section/") for item in successes),
                     "manifestSourcesScanned": len(scanned), "sourceScanIssues": len(scan_issues),
                     "completeWithinDeclaredBoundary": not failures and not scan_issues},
        "coverageBoundary": [
            f"Current {campus.id} Calendar only; no historical archive or complete other-campus catalogue.",
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
    save_json(output / "manifest.json", manifest)
    save_json(output / "index.json", [{"url": item["url"], "title": item["title"], "path": item["path"],
                                       "recordPath": item["recordPath"],
                                       "contentHash": item["contentHash"], "fetchedAt": item["fetchedAt"]} for item in successes])
    print(json.dumps(manifest["coverage"], ensure_ascii=False), flush=True)
    return 0 if manifest["coverage"]["completeWithinDeclaredBoundary"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
