"""Manually collect the current UTM Calendar. No scheduler or historical database."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import threading
import time
import uuid
from urllib.parse import parse_qs, urljoin, urlparse
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache' / 'calendar'
OUT = ROOT / 'data' / 'utm'
BASE = 'https://utm.calendar.utoronto.ca'
LOCAL = threading.local()


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def cache_path(url, directory=None):
    return (directory or CACHE) / (hashlib.sha256(url.encode()).hexdigest() + '.json')


def manifest_sources(manifest):
    """The hashes defining a collection, including discovery and supporting rules."""
    sources = [manifest['academicYearEvidence']]
    sources += manifest.get('supportingSources', [])
    for directory in manifest['directories'].values():
        sources += directory['pages']
    sources += [item for item in manifest.get('details', []) if item.get('status') == 'ok']
    return sources


def read_verified_source(reference, generation_id=None, directory=None):
    path = cache_path(reference['url'], directory)
    if not path.exists():
        raise RuntimeError('Source cache missing: ' + reference['url'])
    source = json.loads(path.read_text(encoding='utf-8'))
    actual_hash = hashlib.sha256(source.get('html', '').encode()).hexdigest()
    if source.get('url') != reference['url'] or actual_hash != source.get('contentHash'):
        raise RuntimeError('Cached HTML integrity mismatch: ' + reference['url'])
    if reference.get('contentHash') and actual_hash != reference['contentHash']:
        raise RuntimeError('Cache does not match collection manifest: ' + reference['url'])
    if generation_id and source.get('generationId') != generation_id:
        raise RuntimeError('Source belongs to a different collection generation: ' + reference['url'])
    return source


def validate_manifest_cache(manifest, directory=None):
    directory = directory or CACHE
    active_path = directory / 'active-run.json'
    if not active_path.exists() or not manifest.get('generationId'):
        raise RuntimeError('Collection generation missing; run the collector to initialize or migrate its source cache')
    active = json.loads(active_path.read_text(encoding='utf-8'))
    if active['generationId'] != manifest['generationId']:
        raise RuntimeError('Manifest belongs to an earlier generation. Resume the active collection before parsing; published snapshot is preserved.')
    if not manifest.get('complete') or manifest.get('failures'):
        raise RuntimeError('Collection is incomplete; resume it before parsing')
    expected = {entry['url'] for group in manifest['directories'].values() for entry in group['entities']}
    successful = {item['url'] for item in manifest['details'] if item.get('status') == 'ok'}
    if expected != successful:
        raise RuntimeError('Manifest detail denominator mismatch')
    for reference in manifest_sources(manifest):
        read_verified_source(reference, manifest['generationId'], directory)


def prepare_generation(refresh=False, offline=False, directory=None):
    """Resume exactly one crawl generation; never silently mix annual caches."""
    directory = directory or CACHE
    active_path, manifest_path = directory / 'active-run.json', directory / 'manifest.json'
    if refresh and offline:
        raise ValueError('--refresh and --offline cannot be combined')
    if refresh:
        active = {'generationId': uuid.uuid4().hex, 'startedAt': now(), 'status': 'collecting'}
        write_json(active_path, active)
        return active
    if active_path.exists():
        return json.loads(active_path.read_text(encoding='utf-8'))
    # One-time migration of the original complete cache. Every entity, directory
    # and homepage must match its recorded source hash before assigning a batch.
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        if not manifest.get('complete') or manifest.get('failures'):
            raise RuntimeError('Legacy cache is incomplete and has no generation identity. Start one complete --refresh; the published snapshot will be retained.')
        expected = {entry['url'] for group in manifest['directories'].values() for entry in group['entities']}
        successful = {item['url'] for item in manifest.get('details', []) if item.get('status') == 'ok'}
        if expected != successful:
            raise RuntimeError('Legacy manifest is incomplete; start --refresh')
        verified = [read_verified_source(reference, directory=directory) for reference in manifest_sources(manifest)]
        first = min(source['fetchedAt'] for source in verified)
        last = manifest['finishedAt']
        # Original auxiliary policy fetches were not enumerated in the manifest.
        # Adopt them only if their stored hash verifies and time lies in the
        # already verified source collection interval; otherwise leave them out.
        supporting = []
        for slug in ['understanding-courses', 'course-enrolment']:
            url = BASE + '/' + slug
            if cache_path(url, directory).exists():
                auxiliary = read_verified_source({'url': url}, directory=directory)
                if first <= auxiliary['fetchedAt'] <= last:
                    verified.append(auxiliary)
                    supporting.append({key: auxiliary[key] for key in ['url', 'contentHash', 'fetchedAt']})
        active = {'generationId': uuid.uuid4().hex, 'startedAt': manifest['startedAt'],
                  'status': 'complete', 'migratedFromVerifiedManifest': True}
        for source in verified:
            source['generationId'] = active['generationId']
            write_json(cache_path(source['url'], directory), source)
        manifest['generationId'] = active['generationId']
        manifest['supportingSources'] = supporting
        write_json(manifest_path, manifest)
        write_json(active_path, active)
        return active
    if offline:
        raise RuntimeError('No active collection exists for offline use')
    active = {'generationId': uuid.uuid4().hex, 'startedAt': now(), 'status': 'collecting'}
    write_json(active_path, active)
    return active


class Fetcher:
    def __init__(self, refresh=False, offline=False):
        self.active = prepare_generation(refresh, offline)
        self.generation_id = self.active['generationId']
        self.offline = offline
        self.started = self.active['startedAt']
        self.robots = RobotFileParser()
        response = requests.get(BASE + '/robots.txt', timeout=40) if not offline else None
        if response is not None:
            response.raise_for_status()
            self.robots.parse(response.text.splitlines())
        self.failures = []

    def ensure_active(self):
        active = json.loads((CACHE / 'active-run.json').read_text(encoding='utf-8'))
        if active['generationId'] != self.generation_id:
            raise RuntimeError('A newer collection generation has started; this collector cannot overwrite it')

    def get(self, url):
        self.ensure_active()
        path = cache_path(url)
        if path.exists():
            old = json.loads(path.read_text(encoding='utf-8'))
            if old.get('generationId') == self.generation_id:
                return read_verified_source({'url': url}, self.generation_id)
        if self.offline:
            raise RuntimeError('No source from the active collection generation: ' + url)
        if not self.robots.can_fetch('UTMCourseExplorer', url):
            raise RuntimeError('robots.txt disallows ' + url)
        if not hasattr(LOCAL, 'session'):
            LOCAL.session = requests.Session()
            LOCAL.session.headers['User-Agent'] = 'UTMCourseExplorer/1.0 (manual academic catalog snapshot)'
        for attempt in range(4):
            try:
                # Six workers maximum, with a pause on each request and bounded retry.
                time.sleep(.12)
                response = LOCAL.session.get(url, timeout=(15, 60))
                if response.status_code in (401, 403):
                    raise PermissionError(f'Access refused: {url} ({response.status_code})')
                response.raise_for_status()
                response.encoding = 'utf-8'
                html = response.text
                if 'page-title' not in html:
                    raise ValueError('Missing Calendar page title: ' + url)
                item = {'url': url, 'finalUrl': response.url, 'fetchedAt': now(),
                        'contentHash': hashlib.sha256(html.encode()).hexdigest(), 'html': html,
                        'generationId': self.generation_id}
                self.ensure_active()
                write_json(path, item)
                return item
            except PermissionError:
                raise
            except (requests.RequestException, ValueError):
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)
        raise RuntimeError(url)


def discover(fetcher, kind, workers):
    entry = BASE + ('/course-search' if kind == 'course' else '/program-search')
    pending = {entry}
    visited = set()
    pages = []
    entities = {}
    duplicates = []
    fingerprints = {}
    while pending:
        batch = sorted(pending)
        pending.clear()
        with ThreadPoolExecutor(max_workers=workers) as pool:
            tasks = {pool.submit(fetcher.get, url): url for url in batch}
            for future in as_completed(tasks):
                url = tasks[future]
                if url in visited:
                    continue
                visited.add(url)
                source = future.result()
                soup = BeautifulSoup(source['html'], 'html.parser')
                headers = soup.select('h3.js-views-accordion-group-header')
                if not headers:
                    raise ValueError('Empty directory page: ' + url)
                ids = []
                for header in headers:
                    title = ' '.join(header.get_text(' ', strip=True).split())
                    if kind == 'course':
                        match = re.match(r'([A-Z]{3}\d{3}[HY]5)\s*[•·-]\s*(.*)', title)
                        if not match:
                            raise ValueError('Unrecognized course entity: ' + title)
                        code = match[1]
                        detail = BASE + '/course/' + code.lower()
                    else:
                        links = header.parent.select('a[href*="/program/"]')
                        matches = [(a, re.search(r'/program/([^/?#]+)', a['href'])) for a in links]
                        matches = [(a, m) for a, m in matches if m and (
                            m[1].upper() in title.upper() or ' '.join(a.get_text(' ', strip=True).split()) == title)]
                        if len(matches) != 1:
                            raise ValueError('Unrecognized program entity: ' + title)
                        link, match = matches[0]
                        code = match[1].upper()
                        detail = urljoin(BASE, link['href'])
                    ids.append(code)
                    if code in entities:
                        duplicates.append({'code': code, 'page': url, 'firstPage': entities[code]['directoryUrl']})
                    else:
                        entities[code] = {'code': code, 'title': title, 'url': detail, 'directoryUrl': url}
                fingerprint = hashlib.sha256('|'.join(ids).encode()).hexdigest()
                if fingerprint in fingerprints:
                    raise ValueError(f'Repeated directory response: {url} and {fingerprints[fingerprint]}')
                fingerprints[fingerprint] = url
                page_number = int(parse_qs(urlparse(url).query).get('page', ['0'])[0])
                pages.append({'url': url, 'page': page_number, 'count': len(ids), 'codes': ids,
                              'contentHash': source['contentHash'], 'fetchedAt': source['fetchedAt']})
                for anchor in soup.select('nav.pager a[href]'):
                    linked = urljoin(url, anchor['href'])
                    parsed = urlparse(linked)
                    if parsed.path != urlparse(entry).path:
                        continue
                    number = int(parse_qs(parsed.query).get('page', ['0'])[0])
                    linked = entry if number == 0 else entry + '?page=' + str(number)
                    if linked not in visited:
                        pending.add(linked)
        print(f'{kind} directory: {len(visited)} pages, {len(entities)} distinct entities', flush=True)
    pages.sort(key=lambda p: p['page'])
    if [p['page'] for p in pages] != list(range(len(pages))):
        raise ValueError('Non-contiguous discovered pages: ' + kind)
    return {'entryUrl': entry, 'pages': pages, 'entities': sorted(entities.values(), key=lambda e: e['code']),
            'duplicates': duplicates, 'complete': True}


def collect(args):
    fetcher = Fetcher(args.refresh, args.offline)
    home = fetcher.get(BASE + '/')
    title = BeautifulSoup(home['html'], 'html.parser').select_one('h1.page-title').get_text(' ', strip=True)
    year = re.search(r'(20\d{2})\s*[-–]\s*(20\d{2})', title)
    if not year:
        raise ValueError('Academic year cannot be established from homepage heading: ' + title)
    manifest = {'generationId': fetcher.generation_id, 'startedAt': fetcher.started, 'academicYear': year[1] + '-' + year[2],
                'academicYearEvidence': {'url': BASE + '/', 'heading': title, 'contentHash': home['contentHash']},
                'directories': {}, 'details': [], 'failures': [], 'supportingSources': []}
    for slug in ['understanding-courses', 'course-enrolment']:
        supporting = fetcher.get(BASE + '/' + slug)
        manifest['supportingSources'].append({key: supporting[key] for key in ['url', 'contentHash', 'fetchedAt']})
    for kind in ['course', 'program']:
        manifest['directories'][kind] = discover(fetcher, kind, args.workers)
    fetcher.ensure_active()
    write_json(CACHE / 'manifest.json', manifest)
    entities = [(kind, entry) for kind, directory in manifest['directories'].items() for entry in directory['entities']]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        tasks = {pool.submit(fetcher.get, entry['url']): (kind, entry) for kind, entry in entities}
        for count, future in enumerate(as_completed(tasks), 1):
            kind, entry = tasks[future]
            try:
                source = future.result()
                manifest['details'].append({'kind': kind, 'code': entry['code'], 'url': entry['url'],
                                            'contentHash': source['contentHash'], 'fetchedAt': source['fetchedAt'], 'status': 'ok'})
            except Exception as exc:
                manifest['failures'].append({'kind': kind, 'code': entry['code'], 'url': entry['url'], 'error': str(exc)})
            if count % 100 == 0 or count == len(entities):
                print(f'Details {count}/{len(entities)}; failures {len(manifest["failures"])}', flush=True)
                fetcher.ensure_active()
                write_json(CACHE / 'manifest.json', manifest)
    manifest['finishedAt'] = now()
    manifest['complete'] = not manifest['failures']
    fetcher.ensure_active()
    write_json(CACHE / 'manifest.json', manifest)
    fetcher.active['status'] = 'complete' if manifest['complete'] else 'collecting'
    write_json(CACHE / 'active-run.json', fetcher.active)
    return manifest


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh', action='store_true', help='Manually fetch a fresh current snapshot, replacing the local source cache')
    parser.add_argument('--offline', action='store_true', help='Use cached sources only')
    parser.add_argument('--collect-only', action='store_true')
    parser.add_argument('--parse-only', action='store_true')
    parser.add_argument('--allow-decrease', action='store_true', help='Accept a reviewed >10%% entity count decline when replacing the snapshot')
    parser.add_argument('--accept', action='store_true', help='Replace the published current snapshot after all collection and count checks pass')
    parser.add_argument('--workers', type=int, default=6, choices=range(1, 7))
    args = parser.parse_args()
    if args.parse_only:
        if args.refresh:
            parser.error('--parse-only cannot be combined with --refresh')
        prepare_generation(offline=True)
        manifest = json.loads((CACHE / 'manifest.json').read_text(encoding='utf-8'))
    else:
        manifest = collect(args)
    if not args.collect_only:
        from calendar_parser import build_catalog
        build_catalog(manifest, args.allow_decrease, args.accept)
    if manifest.get('failures'):
        raise SystemExit('Incomplete source collection; see .cache/calendar/manifest.json')


if __name__ == '__main__':
    main()
