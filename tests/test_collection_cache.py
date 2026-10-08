"""Generation isolation, source integrity, pacing and file hygiene; no network required."""
import argparse
from contextlib import redirect_stdout
from copy import deepcopy
import dataclasses
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from pipeline import cache, http  # noqa: E402
from pipeline import collect_calendar as collector  # noqa: E402
from pipeline import collect_supporting_sources as supporting  # noqa: E402
from pipeline.campuses import UTM  # noqa: E402
from pipeline.files import write_json  # noqa: E402


class CollectionGeneration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def source(self, url, generation='old', text='old source'):
        source = {'url': url, 'finalUrl': url, 'html': text,
                  'contentHash': hashlib.sha256(text.encode()).hexdigest(),
                  'fetchedAt': '2026-10-08T04:30:00+00:00'}
        if generation is not None:
            source['generationId'] = generation
        write_json(cache.cache_path(url, self.directory), source)
        return source

    def manifest(self, generation='old'):
        home = self.source(UTM.calendar_url, generation, '2026-2027 Calendar')
        page = self.source(UTM.course_search_url, generation, 'directory')
        detail = self.source(UTM.course_url('CSC108H5'), generation, 'course details')
        manifest = {'startedAt': '2026-10-08T04:29:00+00:00', 'finishedAt': '2026-10-08T04:31:00+00:00',
                    'complete': True, 'failures': [], 'academicYear': '2026-2027',
                    'academicYearEvidence': {'url': home['url'], 'contentHash': home['contentHash']},
                    'directories': {'course': {'entities': [{'url': detail['url']}],
                                               'pages': [{'url': page['url'], 'contentHash': page['contentHash']}]}},
                    'details': [{'url': detail['url'], 'contentHash': detail['contentHash'], 'status': 'ok'}]}
        if generation is not None:
            manifest['generationId'] = generation
        write_json(self.directory / 'manifest.json', manifest)
        return manifest

    def prepare(self, **kwargs):
        return cache.prepare_generation(directory=self.directory, **kwargs)

    def snapshot(self):
        return {path.name: path.read_bytes() for path in sorted(self.directory.iterdir())}

    def test_resume_keeps_generation_and_refresh_creates_new_one(self):
        first = self.prepare()
        self.assertEqual(self.prepare()['generationId'], first['generationId'])
        second = self.prepare(refresh=True)
        self.assertNotEqual(first['generationId'], second['generationId'])
        self.assertEqual(self.prepare()['generationId'], second['generationId'])

    def test_offline_rejects_previous_year_source_even_with_valid_hash(self):
        self.source(UTM.course_url('CSC108H5'), 'previous-year')
        self.prepare(refresh=True)
        fetcher = collector.Fetcher(UTM, offline=True, directory=self.directory)
        with self.assertRaisesRegex(RuntimeError, 'active collection generation'):
            fetcher.get(UTM.course_url('CSC108H5'))

    def test_running_collector_cannot_resume_after_new_refresh(self):
        self.prepare(refresh=True)
        fetcher = collector.Fetcher(UTM, offline=True, directory=self.directory)
        self.prepare(refresh=True)
        with self.assertRaisesRegex(RuntimeError, 'newer collection generation'):
            fetcher.get(UTM.calendar_url)

    def test_resume_refetches_only_old_generation_and_reuses_new_pages(self):
        url = UTM.course_url('CSC108H5')
        self.source(url, 'previous-year')
        active = self.prepare(refresh=True)
        response = Mock(status_code=200, url=url, text='<h1 class="page-title">CSC108H5</h1>')
        robots = Mock(status_code=200, url=UTM.base_url + '/robots.txt', content=b'User-agent: *\nAllow: /')
        session = Mock()
        session.get.side_effect = [robots, response]
        with patch.object(http, 'session', return_value=session), patch.object(http.THROTTLE, 'wait'):
            fetcher = collector.Fetcher(UTM, directory=self.directory)
            refreshed = fetcher.get(url)
            self.assertEqual(refreshed['generationId'], active['generationId'])
            self.assertEqual(fetcher.get(url), refreshed)
        self.assertEqual(session.get.call_count, 2)
        self.assertEqual(session.get.call_args_list[1].args[0], url)

    def test_parse_rejects_manifest_from_before_a_refresh(self):
        manifest = self.manifest()
        self.prepare(refresh=True)
        with self.assertRaisesRegex(RuntimeError, 'earlier generation'):
            cache.validate_manifest_cache(manifest, self.directory)

    def test_parse_rejects_changed_source_hash_even_if_generation_matches(self):
        manifest = self.manifest('same')
        write_json(self.directory / 'active-run.json', {'generationId': 'same'})
        self.source(UTM.course_url('CSC108H5'), 'same', 'replaced details')
        with self.assertRaisesRegex(RuntimeError, 'does not match collection manifest'):
            cache.validate_manifest_cache(manifest, self.directory)

    def test_legacy_migration_checks_every_hash_before_adopting_cache(self):
        manifest = self.manifest(None)
        active = self.prepare(offline=True)
        migrated = json.loads((self.directory / 'manifest.json').read_text(encoding='utf-8'))
        self.assertTrue(active['migratedFromVerifiedManifest'])
        self.assertEqual(migrated['generationId'], active['generationId'])
        cache.validate_manifest_cache(migrated, self.directory)
        self.assertEqual(migrated['academicYearEvidence'], manifest['academicYearEvidence'])

    def test_interrupted_legacy_refresh_cannot_be_adopted_as_complete(self):
        self.manifest(None)
        self.source(UTM.course_url('CSC108H5'), None, 'new year course')
        with self.assertRaisesRegex(RuntimeError, 'does not match collection manifest'):
            self.prepare(offline=True)
        self.assertFalse((self.directory / 'active-run.json').exists())

    def test_missing_manifest_detail_stops_parse(self):
        manifest = self.manifest('same')
        write_json(self.directory / 'active-run.json', {'generationId': 'same'})
        bad = deepcopy(manifest)
        bad['details'] = []
        with self.assertRaisesRegex(RuntimeError, 'denominator mismatch'):
            cache.validate_manifest_cache(bad, self.directory)

    def test_parse_only_never_migrates_or_rewrites_a_legacy_cache(self):
        self.manifest(None)
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, 'no active-run.json'):
            cache.load_manifest_for_parse(self.directory)
        self.assertEqual(self.snapshot(), before)

    def test_parse_only_reads_a_verified_generation_without_writing(self):
        self.manifest('same')
        write_json(self.directory / 'active-run.json', {'generationId': 'same'})
        before = self.snapshot()
        self.assertEqual(cache.load_manifest_for_parse(self.directory)['generationId'], 'same')
        self.assertEqual(self.snapshot(), before)

    def test_parse_only_cli_uses_the_read_only_path(self):
        campus = dataclasses.replace(UTM, cache_dir=self.directory)
        self.manifest(None)
        with patch.object(collector, 'get_campus', return_value=campus), \
                patch.object(collector, 'collect') as collect, redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'no active-run.json'):
                collector.main(['--parse-only'])
        collect.assert_not_called()
        self.assertFalse((self.directory / 'active-run.json').exists())


class FileHygiene(unittest.TestCase):
    def test_json_is_written_with_lf_line_endings(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'nested' / 'value.json'
            write_json(path, {'a': [1, 2], 'text': 'é'})
            raw = path.read_bytes()
            self.assertNotIn(b'\r', raw)
            self.assertEqual(raw, json.dumps({'a': [1, 2], 'text': 'é'}, ensure_ascii=False, indent=2).encode('utf-8'))

    def test_supporting_sources_default_to_the_campus_caches(self):
        args = supporting.build_parser().parse_args([])
        self.assertIsNone(args.source_cache)
        self.assertIsNone(args.output)
        self.assertEqual(UTM.cache_dir, ROOT / '.cache' / 'calendar')
        self.assertEqual(UTM.supplementary_dir, ROOT / '.cache' / 'supplementary')
        self.assertEqual(supporting.repo_path(UTM.supplementary_dir / 'x.json'), '.cache/supplementary/x.json')

    def test_supporting_scope_rules_are_campus_aware(self):
        self.assertEqual(supporting.canonical('/section/Computer-Science/', UTM),
                         'https://utm.calendar.utoronto.ca/section/Computer-Science')
        self.assertIsNone(supporting.exclusion('https://utm.calendar.utoronto.ca/degree-requirements', UTM))
        self.assertEqual(supporting.exclusion('https://utm.calendar.utoronto.ca/course/csc108h5', UTM),
                         'entity-search-archive-or-system-path')
        self.assertEqual(supporting.exclusion('https://artsci.calendar.utoronto.ca/x', UTM),
                         'outside-current-UTM-Calendar-host')


class Pacing(unittest.TestCase):
    def test_one_browser_like_user_agent(self):
        self.assertTrue(http.USER_AGENT.startswith('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'))
        with patch.object(http, '_local', threading.local()):
            self.assertEqual(http.session().headers['User-Agent'], http.USER_AGENT)

    def test_throttle_spaces_request_starts_across_threads(self):
        # The clock stands still; each thread starts when its own sleep ends.
        local = threading.local()
        lock = threading.Lock()
        starts = []

        def sleep(seconds):
            local.slept = seconds

        throttle = http.Throttle(0.1, clock=lambda: 100.0, sleep=sleep)
        self.assertEqual(throttle.interval, http.MIN_INTERVAL)

        def request():
            local.slept = 0.0
            throttle.wait()
            with lock:
                starts.append(100.0 + local.slept)

        threads = [threading.Thread(target=request) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        starts.sort()
        self.assertEqual(starts, [100.0 + i * http.MIN_INTERVAL for i in range(6)])

    def test_throttle_spaces_real_request_starts(self):
        interval = 0.05
        with patch.object(http, 'MIN_INTERVAL', interval):
            throttle = http.Throttle(interval)
        lock = threading.Lock()
        starts = []

        def request():
            throttle.wait()
            started = time.monotonic()
            with lock:
                starts.append(started)

        first = time.monotonic()
        threads = [threading.Thread(target=request) for _ in range(5)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        starts.sort()
        # Five starts need four full intervals on the wall clock, whatever the thread scheduling
        # (a sleep may overshoot, never undershoot beyond timer granularity).
        self.assertEqual(len(starts), 5)
        self.assertGreaterEqual(starts[-1] - first, 4 * interval - 0.005)

    def test_robots_crawl_delay_raises_the_shared_interval(self):
        throttle = http.Throttle(clock=lambda: 0.0, sleep=lambda seconds: None)
        response = Mock(status_code=200, url='https://x/robots.txt', content=b'User-agent: *\nCrawl-delay: 2\nAllow: /')
        response.raise_for_status = Mock()
        with patch.object(http, 'session', return_value=Mock(get=Mock(return_value=response))):
            robots, evidence = http.load_robots('https://x', throttle=throttle)
        self.assertEqual(throttle.interval, 2.0)
        self.assertTrue(http.allowed(robots, 'https://x/course/a'))
        self.assertEqual(len(evidence['contentHash']), 64)

    def test_missing_robots_txt_allows_everything(self):
        throttle = http.Throttle(clock=lambda: 0.0, sleep=lambda seconds: None)
        for status in (404, 410):
            response = Mock(status_code=status, url='https://x/robots.txt', content=b'<h1>Not found</h1>')
            response.raise_for_status = Mock(side_effect=AssertionError('a missing robots.txt is not an error'))
            with patch.object(http, 'session', return_value=Mock(get=Mock(return_value=response))):
                robots, evidence = http.load_robots('https://x', throttle=throttle)
            self.assertTrue(http.allowed(robots, 'https://x/course/a'))
            self.assertEqual((evidence['httpStatus'], evidence['text']), (status, ''))

    def test_refused_robots_txt_stops_before_anything_else(self):
        response = Mock(status_code=403, url='https://x/robots.txt', content=b'')
        with patch.object(http, 'session', return_value=Mock(get=Mock(return_value=response))):
            with self.assertRaises(http.AccessRefused):
                http.load_robots('https://x', throttle=http.Throttle(clock=lambda: 0.0, sleep=lambda seconds: None))

    def test_a_stopped_collection_sends_nothing(self):
        stop = threading.Event()
        stop.set()
        session = Mock()
        with patch.object(http, 'session', return_value=session), patch.object(http.THROTTLE, 'wait'):
            with self.assertRaises(http.CollectionStopped):
                http.get('https://x/course/a', stop=stop)
        session.get.assert_not_called()


def page(html):
    return f'<html><body><h1 class="page-title">{html}</h1></body></html>'


class FakeCalendar:
    """Answers every calendar URL; ``refuse`` maps URLs to a 401/403/429 status."""

    def __init__(self, courses, refuse=None):
        self.courses = courses
        self.refuse = refuse or {}
        self.requested = []
        self.lock = threading.Lock()

    def html(self, url):
        if url == UTM.calendar_url:
            return page('2026-2027 Calendar')
        if url == UTM.course_search_url:
            headers = ''.join(f'<h3 class="js-views-accordion-group-header">{code} • Course {code}</h3>' for code in self.courses)
            return page('Course search') + headers
        if url == UTM.program_search_url:
            return (page('Program search') + '<div><h3 class="js-views-accordion-group-header">Synthetic Major - ERMAJ9999</h3>'
                    '<a href="/program/ermaj9999">ERMAJ9999</a></div>')
        return page(url)

    def get(self, url, timeout=None, allow_redirects=True):
        with self.lock:
            self.requested.append(url)
        if url.endswith('/robots.txt'):
            return Mock(status_code=200, url=url, content=b'User-agent: *\nAllow: /')
        if url in self.refuse:
            return Mock(status_code=self.refuse[url], url=url)
        return Mock(status_code=200, url=url, text=self.html(url))


class AccessRefusal(unittest.TestCase):
    """The first 401/403/429 stops the collection: no further request, manifest saved, non-zero exit."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.campus = dataclasses.replace(UTM, cache_dir=Path(self.temp.name))
        self.args = argparse.Namespace(refresh=True, offline=False, workers=1, allow_planned=False)

    def tearDown(self):
        self.temp.cleanup()

    def collect(self, site):
        with patch.object(http, 'session', return_value=site), patch.object(http.THROTTLE, 'wait'), \
                redirect_stdout(io.StringIO()):
            with self.assertRaises(http.AccessRefused):
                collector.collect(self.args, self.campus)
        return json.loads((self.campus.cache_dir / 'manifest.json').read_text(encoding='utf-8'))

    def test_refused_detail_cancels_the_queue_and_saves_the_manifest(self):
        courses = [f'CSC{100 + i}H5' for i in range(12)]
        refused = UTM.course_url(courses[1])
        site = FakeCalendar(courses, {refused: 429})
        manifest = self.collect(site)
        details = [url for url in site.requested if '/course/' in url or '/program/' in url]
        # One worker: the first detail succeeds, the second is refused, nothing after it is sent.
        self.assertEqual(details, [UTM.course_url(courses[0]), refused])
        self.assertFalse(manifest['complete'])
        self.assertIn('stoppedAt', manifest)
        self.assertLessEqual({d['code'] for d in manifest['details']}, {courses[0]})
        self.assertEqual(manifest['failures'], [{'kind': 'collection', 'url': refused, 'httpStatus': 429,
                                                 'error': 'Access refused (HTTP 429); collection stopped'}])
        self.assertEqual(len(manifest['directories']['course']['entities']), 12)
        # Resumable: the generation is still the active one and is not marked complete.
        active = json.loads((self.campus.cache_dir / 'active-run.json').read_text(encoding='utf-8'))
        self.assertEqual((active['generationId'], active['status']), (manifest['generationId'], 'collecting'))

    def test_refusal_with_several_workers_sends_at_most_the_requests_in_flight(self):
        self.args.workers = 3
        courses = [f'CSC{100 + i}H5' for i in range(40)]
        site = FakeCalendar(courses, {UTM.course_url(courses[0]): 403})
        manifest = self.collect(site)
        details = [url for url in site.requested if '/course/' in url or '/program/' in url]
        self.assertLessEqual(len(details), 3)
        self.assertEqual(manifest['failures'][0]['httpStatus'], 403)

    def test_refused_directory_page_stops_discovery(self):
        site = FakeCalendar(['CSC108H5'], {UTM.course_search_url: 401})
        manifest = self.collect(site)
        self.assertFalse([url for url in site.requested if '/course/' in url or url == UTM.program_search_url])
        self.assertEqual(manifest['failures'][0]['httpStatus'], 401)
        self.assertEqual(manifest['directories'], {})

    def test_cli_exits_non_zero_after_a_refusal(self):
        with patch.object(collector, 'get_campus', return_value=self.campus), \
                patch.object(collector, 'collect', side_effect=http.AccessRefused('Access refused: x (HTTP 429)')):
            with self.assertRaises(SystemExit) as stopped:
                collector.main(['--campus', 'utm'])
        self.assertIsInstance(stopped.exception.code, str)
        self.assertIn('resume later without --refresh', stopped.exception.code.lower())

    def test_supporting_sources_stop_on_the_first_refusal(self):
        source_cache = Path(self.temp.name) / 'calendar'
        output = Path(self.temp.name) / 'supplementary'
        write_json(source_cache / 'manifest.json', {'academicYear': '2026-2027', 'directories': {}, 'details': []})
        seeds = sorted(UTM.base_url + '/' + slug for slug in UTM.seed_slugs)
        site = FakeCalendar([], {seeds[0]: 429})
        with patch.object(http, 'session', return_value=site), patch.object(http.THROTTLE, 'wait'), \
                redirect_stdout(io.StringIO()):
            code = supporting.main(['--source-cache', str(source_cache), '--output', str(output), '--workers', '1'])
        self.assertEqual(code, supporting.STOPPED_EXIT)
        self.assertEqual([url for url in site.requested if not url.endswith('robots.txt')], [seeds[0]])
        manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
        self.assertEqual((manifest['stopped']['url'], manifest['stopped']['httpStatus']), (seeds[0], 429))
        # The refused page and everything queued after it are listed as not fetched.
        self.assertEqual(manifest['stopped']['unfetched'], seeds)
        self.assertFalse(manifest['coverage']['completeWithinDeclaredBoundary'])


if __name__ == '__main__':
    unittest.main()
