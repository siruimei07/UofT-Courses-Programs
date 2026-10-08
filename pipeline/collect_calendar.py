"""Manually collect one campus's current calendar, then parse it into a candidate snapshot.

No scheduler and no historical database. Run from the repository root (npm run data:collect):

  python -I pipeline --campus utm --refresh                # annual collection (resumable)
  python -I pipeline --campus utm --parse-only             # offline re-parse into candidates
  python -I pipeline --campus utm --parse-only --accept    # publish to data/utm/

The first HTTP 401/403/429 stops the whole collection: queued fetches are cancelled, the
manifest is saved (incomplete) and the command exits non-zero. Resume later without --refresh.
"""
from __future__ import annotations

if __name__ == '__main__' and not __package__:
    raise SystemExit('Run the pipeline as a package from the repository root: python -I pipeline --help')

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import re
import sys
import threading
import time
from urllib.parse import parse_qs, urljoin, urlparse
from urllib.robotparser import RobotFileParser

from bs4 import BeautifulSoup
import requests

from . import http
from .cache import cache_path, load_manifest_for_parse, prepare_generation, read_verified_source
from .campuses import UTM, Campus, campus_keys, get_campus
from .files import now, read_json, write_json

MAX_ATTEMPTS = 4


class Fetcher:
    """Fetches calendar pages into the active generation of one campus cache."""

    def __init__(self, campus: Campus = UTM, refresh=False, offline=False, directory=None):
        self.campus = campus
        self.directory = directory or campus.cache_dir
        self.active = prepare_generation(refresh, offline, self.directory, campus)
        self.generation_id = self.active['generationId']
        self.offline = offline
        self.started = self.active['startedAt']
        self.robots = RobotFileParser()
        # Set by the first refusal (or any abort): no further request leaves this process.
        self.stop = threading.Event()
        self.refusal = None
        if not offline:
            self.robots, _ = http.load_robots(campus.base_url)
        self.failures = []

    def ensure_active(self):
        active = read_json(self.directory / 'active-run.json')
        if active['generationId'] != self.generation_id:
            raise RuntimeError('A newer collection generation has started; this collector cannot overwrite it')

    def get(self, url):
        self.ensure_active()
        path = cache_path(url, self.directory)
        if path.exists():
            old = read_json(path)
            if old.get('generationId') == self.generation_id:
                return read_verified_source({'url': url}, self.generation_id, self.directory)
        if self.offline:
            raise RuntimeError('No source from the active collection generation: ' + url)
        if not http.allowed(self.robots, url):
            raise RuntimeError('robots.txt disallows ' + url)
        for attempt in range(MAX_ATTEMPTS):
            try:
                response = http.get(url, stop=self.stop)
                if response.status_code in http.REFUSED_STATUSES and self.refusal is None:
                    self.refusal = {'url': url, 'httpStatus': response.status_code,
                                    'error': f'Access refused (HTTP {response.status_code}); collection stopped'}
                http.refuse(response, url, self.stop)
                response.raise_for_status()
                response.encoding = 'utf-8'
                html = response.text
                if self.campus.page_title_marker not in html:
                    raise ValueError('Missing Calendar page title: ' + url)
                item = {'url': url, 'finalUrl': response.url, 'fetchedAt': now(),
                        'contentHash': hashlib.sha256(html.encode()).hexdigest(), 'html': html,
                        'generationId': self.generation_id}
                self.ensure_active()
                write_json(path, item)
                return item
            except (http.AccessRefused, http.CollectionStopped):
                raise
            except (requests.RequestException, ValueError):
                if attempt == MAX_ATTEMPTS - 1:
                    raise
                time.sleep(2 ** attempt)
        raise RuntimeError(url)


STOPPING = (http.AccessRefused, http.CollectionStopped)


def abort_pool(pool: ThreadPoolExecutor, fetcher: Fetcher):
    """Stop now: queued fetches are cancelled and running ones send nothing more."""
    fetcher.stop.set()
    pool.shutdown(wait=True, cancel_futures=True)


def discover(fetcher: Fetcher, kind, workers):
    campus = fetcher.campus
    entry = campus.search_url(kind)
    pending = {entry}
    visited = set()
    pages = []
    entities = {}
    duplicates = []
    fingerprints = {}
    while pending:
        batch = sorted(pending)
        pending.clear()
        pool = ThreadPoolExecutor(max_workers=workers)
        try:
            tasks = {pool.submit(fetcher.get, url): url for url in batch}
            for future in as_completed(tasks):
                url = tasks[future]
                if url in visited:
                    continue
                visited.add(url)
                source = future.result()
                soup = BeautifulSoup(source['html'], 'html.parser')
                headers = soup.select(campus.directory_header_selector)
                if not headers:
                    raise ValueError('Empty directory page: ' + url)
                ids = []
                for header in headers:
                    title = ' '.join(header.get_text(' ', strip=True).split())
                    if kind == 'course':
                        match = re.match(campus.directory_course_re, title)
                        if not match:
                            raise ValueError('Unrecognized course entity: ' + title)
                        code = match[1]
                        detail = campus.course_url(code)
                    else:
                        links = header.parent.select(campus.program_link_selector)
                        matches = [(a, re.search(r'/program/([^/?#]+)', a['href'])) for a in links]
                        matches = [(a, m) for a, m in matches if m and (
                            m[1].upper() in title.upper() or ' '.join(a.get_text(' ', strip=True).split()) == title)]
                        if len(matches) != 1:
                            raise ValueError('Unrecognized program entity: ' + title)
                        link, match = matches[0]
                        code = match[1].upper()
                        detail = urljoin(campus.base_url, link['href'])
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
                for anchor in soup.select(campus.pager_selector):
                    linked = urljoin(url, anchor['href'])
                    parsed = urlparse(linked)
                    if parsed.path != urlparse(entry).path:
                        continue
                    number = int(parse_qs(parsed.query).get('page', ['0'])[0])
                    linked = entry if number == 0 else entry + '?page=' + str(number)
                    if linked not in visited:
                        pending.add(linked)
        except BaseException:
            # A refusal or a malformed page ends the collection: queued pages are never fetched.
            abort_pool(pool, fetcher)
            raise
        pool.shutdown()
        print(f'{kind} directory: {len(visited)} pages, {len(entities)} distinct entities', flush=True)
    pages.sort(key=lambda p: p['page'])
    if [p['page'] for p in pages] != list(range(len(pages))):
        raise ValueError('Non-contiguous discovered pages: ' + kind)
    return {'entryUrl': entry, 'pages': pages, 'entities': sorted(entities.values(), key=lambda e: e['code']),
            'duplicates': duplicates, 'complete': True}


def collect(args, campus: Campus = UTM):
    campus.require_supported(getattr(args, 'allow_planned', False))
    fetcher = Fetcher(campus, args.refresh, args.offline)
    directory = fetcher.directory
    home = fetcher.get(campus.calendar_url)
    title = BeautifulSoup(home['html'], 'html.parser').select_one(campus.title_selector).get_text(' ', strip=True)
    year = campus.academic_year(title)
    if not year:
        raise ValueError('Academic year cannot be established from homepage heading: ' + title)
    manifest = {'generationId': fetcher.generation_id, 'startedAt': fetcher.started, 'academicYear': year,
                'academicYearEvidence': {'url': campus.calendar_url, 'heading': title, 'contentHash': home['contentHash']},
                'directories': {}, 'details': [], 'failures': [], 'supportingSources': []}
    try:
        for slug in campus.supporting_slugs:
            supporting = fetcher.get(campus.base_url + '/' + slug)
            manifest['supportingSources'].append({key: supporting[key] for key in ['url', 'contentHash', 'fetchedAt']})
        for kind in ['course', 'program']:
            manifest['directories'][kind] = discover(fetcher, kind, args.workers)
        fetcher.ensure_active()
        write_json(directory / 'manifest.json', manifest)
        collect_details(fetcher, manifest, args.workers)
    except STOPPING as exc:
        # Saved incomplete, so it is never parsed; a plain rerun resumes this generation.
        refusal = fetcher.refusal or {'error': str(exc)}
        manifest['failures'].append({'kind': 'collection', **refusal})
        manifest['stoppedAt'] = now()
        manifest['complete'] = False
        fetcher.ensure_active()
        write_json(directory / 'manifest.json', manifest)
        if isinstance(exc, http.AccessRefused):
            raise
        # Another worker noticed the stop first; report the refusal itself.
        raise http.AccessRefused(f"Access refused: {refusal.get('url')} (HTTP {refusal.get('httpStatus')}); collection stopped") from exc
    manifest['finishedAt'] = now()
    manifest['complete'] = not manifest['failures']
    fetcher.ensure_active()
    write_json(directory / 'manifest.json', manifest)
    fetcher.active['status'] = 'complete' if manifest['complete'] else 'collecting'
    write_json(directory / 'active-run.json', fetcher.active)
    return manifest


def collect_details(fetcher: Fetcher, manifest, workers):
    """Fetch every discovered detail page; ordinary failures are recorded, a refusal stops everything."""
    directory = fetcher.directory
    entities = [(kind, entry) for kind, group in manifest['directories'].items() for entry in group['entities']]
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        tasks = {pool.submit(fetcher.get, entry['url']): (kind, entry) for kind, entry in entities}
        for count, future in enumerate(as_completed(tasks), 1):
            kind, entry = tasks[future]
            try:
                source = future.result()
                manifest['details'].append({'kind': kind, 'code': entry['code'], 'url': entry['url'],
                                            'contentHash': source['contentHash'], 'fetchedAt': source['fetchedAt'], 'status': 'ok'})
            except STOPPING:
                raise
            except Exception as exc:
                manifest['failures'].append({'kind': kind, 'code': entry['code'], 'url': entry['url'], 'error': str(exc)})
            if count % 100 == 0 or count == len(entities):
                print(f'Details {count}/{len(entities)}; failures {len(manifest["failures"])}', flush=True)
                fetcher.ensure_active()
                write_json(directory / 'manifest.json', manifest)
    except BaseException:
        abort_pool(pool, fetcher)
        raise
    pool.shutdown()


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--campus', default='utm', choices=campus_keys(), help='Campus adapter (default: utm)')
    parser.add_argument('--allow-planned', action='store_true', help='Run a planned (unverified) campus adapter experimentally')
    parser.add_argument('--refresh', action='store_true', help='Manually fetch a fresh current snapshot, replacing the local source cache')
    parser.add_argument('--offline', action='store_true', help='Use cached sources only')
    parser.add_argument('--collect-only', action='store_true')
    parser.add_argument('--parse-only', action='store_true', help='Re-parse the verified cache; never fetches, migrates or rewrites it')
    parser.add_argument('--allow-decrease', action='store_true', help='Accept a reviewed >10%% entity count decline when replacing the snapshot')
    parser.add_argument('--accept', action='store_true', help='Replace the published current snapshot after all collection and count checks pass')
    parser.add_argument('--workers', type=int, default=2, choices=range(1, 7),
                        help='Concurrent fetch workers (default 2); requests are globally paced at >= 0.5 s regardless')
    return parser


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser = build_parser()
    args = parser.parse_args(argv)
    campus = get_campus(args.campus)
    if args.parse_only and (args.refresh or args.collect_only):
        parser.error('--parse-only cannot be combined with --refresh or --collect-only')
    try:
        campus.require_supported(args.allow_planned)
    except NotImplementedError as exc:
        parser.error(str(exc))
    if args.parse_only:
        manifest = load_manifest_for_parse(campus.cache_dir)
    else:
        try:
            manifest = collect(args, campus)
        except STOPPING as exc:
            raise SystemExit(f'{exc}. Nothing more was requested; the incomplete manifest is saved in '
                             f'{campus.cache_dir / "manifest.json"}. Resume later without --refresh.') from exc
    if not args.collect_only:
        from .calendar_parser import build_catalog
        build_catalog(manifest, campus, allow_decrease=args.allow_decrease, accept=args.accept,
                      allow_planned=args.allow_planned)
    if manifest.get('failures'):
        raise SystemExit(f'Incomplete source collection; see {campus.cache_dir / "manifest.json"}')


if __name__ == '__main__':
    main()
