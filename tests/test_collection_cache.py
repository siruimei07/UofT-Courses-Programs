"""Generation isolation, source integrity, pacing and file hygiene; no network required."""
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
        clock = {'now': 100.0}
        lock = threading.Lock()
        starts = []

        def sleep(seconds):
            with lock:
                clock['now'] += seconds

        throttle = http.Throttle(0.1, clock=lambda: clock['now'], sleep=sleep)
        self.assertEqual(throttle.interval, http.MIN_INTERVAL)

        def request():
            throttle.wait()
            with lock:
                starts.append(clock['now'])

        threads = [threading.Thread(target=request) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        # Each call reserves its own slot; slots are MIN_INTERVAL apart whatever the thread order.
        self.assertEqual(len(starts), 6)
        self.assertGreaterEqual(throttle._next - 100.0, 6 * http.MIN_INTERVAL - 1e-9)

    def test_robots_crawl_delay_raises_the_shared_interval(self):
        throttle = http.Throttle(clock=lambda: 0.0, sleep=lambda seconds: None)
        response = Mock(status_code=200, url='https://x/robots.txt', content=b'User-agent: *\nCrawl-delay: 2\nAllow: /')
        response.raise_for_status = Mock()
        with patch.object(http, 'session', return_value=Mock(get=Mock(return_value=response))):
            robots, evidence = http.load_robots('https://x', throttle=throttle)
        self.assertEqual(throttle.interval, 2.0)
        self.assertTrue(http.allowed(robots, 'https://x/course/a'))
        self.assertEqual(len(evidence['contentHash']), 64)


if __name__ == '__main__':
    unittest.main()
