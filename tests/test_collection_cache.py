"""Generation isolation and source-integrity regression tests, with no network."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'pipeline'))
import collect_calendar as collector  # noqa: E402


class CollectionGeneration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.cache_patch = patch.object(collector, 'CACHE', self.directory)
        self.cache_patch.start()

    def tearDown(self):
        self.cache_patch.stop()
        self.temp.cleanup()

    def source(self, url, generation='old', text='old source'):
        source = {'url': url, 'finalUrl': url, 'html': text,
                  'contentHash': hashlib.sha256(text.encode()).hexdigest(),
                  'fetchedAt': '2026-10-08T04:30:00+00:00'}
        if generation is not None:
            source['generationId'] = generation
        collector.write_json(collector.cache_path(url), source)
        return source

    def manifest(self, generation='old'):
        home = self.source(collector.BASE + '/', generation, '2026-2027 Calendar')
        page = self.source(collector.BASE + '/course-search', generation, 'directory')
        detail = self.source(collector.BASE + '/course/csc108h5', generation, 'course details')
        manifest = {'startedAt': '2026-10-08T04:29:00+00:00', 'finishedAt': '2026-10-08T04:31:00+00:00',
                    'complete': True, 'failures': [], 'academicYear': '2026-2027',
                    'academicYearEvidence': {'url': home['url'], 'contentHash': home['contentHash']},
                    'directories': {'course': {'entities': [{'url': detail['url']}],
                                               'pages': [{'url': page['url'], 'contentHash': page['contentHash']}]}},
                    'details': [{'url': detail['url'], 'contentHash': detail['contentHash'], 'status': 'ok'}]}
        if generation is not None:
            manifest['generationId'] = generation
        collector.write_json(self.directory / 'manifest.json', manifest)
        return manifest

    def test_resume_keeps_generation_and_refresh_creates_new_one(self):
        first = collector.prepare_generation()
        self.assertEqual(collector.prepare_generation()['generationId'], first['generationId'])
        second = collector.prepare_generation(refresh=True)
        self.assertNotEqual(first['generationId'], second['generationId'])
        self.assertEqual(collector.prepare_generation()['generationId'], second['generationId'])

    def test_offline_rejects_previous_year_source_even_with_valid_hash(self):
        self.source(collector.BASE + '/course/csc108h5', 'previous-year')
        collector.prepare_generation(refresh=True)
        fetcher = collector.Fetcher(offline=True)
        with self.assertRaisesRegex(RuntimeError, 'active collection generation'):
            fetcher.get(collector.BASE + '/course/csc108h5')

    def test_running_collector_cannot_resume_after_new_refresh(self):
        collector.prepare_generation(refresh=True)
        fetcher = collector.Fetcher(offline=True)
        collector.prepare_generation(refresh=True)
        with self.assertRaisesRegex(RuntimeError, 'newer collection generation'):
            fetcher.get(collector.BASE + '/')

    def test_resume_refetches_only_old_generation_and_reuses_new_pages(self):
        url = collector.BASE + '/course/csc108h5'
        self.source(url, 'previous-year')
        active = collector.prepare_generation(refresh=True)
        response = Mock()
        response.status_code = 200
        response.url = url
        response.text = '<h1 class="page-title">CSC108H5</h1>'
        session = Mock()
        session.get.return_value = response
        robots = Mock()
        robots.text = 'User-agent: *\nAllow: /'
        with patch.object(collector.requests, 'get', return_value=robots), \
                patch.object(collector.LOCAL, 'session', session, create=True), \
                patch.object(collector.time, 'sleep'):
            fetcher = collector.Fetcher()
            refreshed = fetcher.get(url)
            self.assertEqual(refreshed['generationId'], active['generationId'])
            self.assertEqual(fetcher.get(url), refreshed)
            session.get.assert_called_once()

    def test_parse_rejects_manifest_from_before_a_refresh(self):
        manifest = self.manifest()
        collector.prepare_generation(refresh=True)
        with self.assertRaisesRegex(RuntimeError, 'earlier generation'):
            collector.validate_manifest_cache(manifest)

    def test_parse_rejects_changed_source_hash_even_if_generation_matches(self):
        manifest = self.manifest('same')
        collector.write_json(self.directory / 'active-run.json', {'generationId': 'same'})
        self.source(collector.BASE + '/course/csc108h5', 'same', 'replaced details')
        with self.assertRaisesRegex(RuntimeError, 'does not match collection manifest'):
            collector.validate_manifest_cache(manifest)

    def test_legacy_migration_checks_every_hash_before_adopting_cache(self):
        manifest = self.manifest(None)
        active = collector.prepare_generation(offline=True)
        migrated = json.loads((self.directory / 'manifest.json').read_text(encoding='utf-8'))
        self.assertTrue(active['migratedFromVerifiedManifest'])
        self.assertEqual(migrated['generationId'], active['generationId'])
        collector.validate_manifest_cache(migrated)
        self.assertEqual(migrated['academicYearEvidence'], manifest['academicYearEvidence'])

    def test_interrupted_legacy_refresh_cannot_be_adopted_as_complete(self):
        self.manifest(None)
        self.source(collector.BASE + '/course/csc108h5', None, 'new year course')
        with self.assertRaisesRegex(RuntimeError, 'does not match collection manifest'):
            collector.prepare_generation(offline=True)
        self.assertFalse((self.directory / 'active-run.json').exists())

    def test_missing_manifest_detail_stops_parse(self):
        manifest = self.manifest('same')
        collector.write_json(self.directory / 'active-run.json', {'generationId': 'same'})
        bad = deepcopy(manifest)
        bad['details'] = []
        with self.assertRaisesRegex(RuntimeError, 'denominator mismatch'):
            collector.validate_manifest_cache(bad)


if __name__ == '__main__':
    unittest.main()
