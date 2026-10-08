"""Campus adapters agree with the registry the Node build uses; planned adapters stay closed."""
from contextlib import redirect_stderr
import io
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from pipeline.calendar_parser import build_catalog  # noqa: E402
from pipeline.campuses import CAMPUS_DIGITS, REGISTRY, UTM, UTSG, get_campus  # noqa: E402
from pipeline.collect_calendar import build_parser, main  # noqa: E402


class CampusRegistry(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        registry = json.loads((ROOT / 'data' / 'campuses.json').read_text(encoding='utf-8'))
        cls.entries = {entry['id']: entry for entry in registry['campuses']}

    def test_every_adapter_matches_data_campuses_json(self):
        self.assertEqual({campus.id for campus in REGISTRY.values()}, set(self.entries))
        for key, campus in REGISTRY.items():
            entry = self.entries[campus.id]
            with self.subTest(campus=campus.id):
                self.assertEqual(key, entry['dataDir'])
                self.assertEqual(campus.data_dir, entry['dataDir'])
                self.assertEqual(campus.campus_digit, entry['campusDigit'])
                self.assertEqual(CAMPUS_DIGITS[campus.campus_digit], campus.id)
                self.assertEqual(campus.status, entry['status'])
                self.assertEqual(campus.calendar_url, entry['calendarUrl'])
                self.assertEqual(campus.course_search_url, entry['courseSearchUrl'])
                self.assertEqual(campus.program_search_url, entry['programSearchUrl'])
                self.assertEqual(campus.course_page_template, entry['coursePageTemplate'])
                self.assertEqual(campus.program_page_template, entry['programPageTemplate'])
                self.assertEqual(campus.out_dir, ROOT / 'data' / entry['dataDir'])

    def test_utm_keeps_the_original_cache_and_campuses_never_share_generation_state(self):
        self.assertEqual(UTM.cache_dir, ROOT / '.cache' / 'calendar')
        self.assertEqual(UTM.supplementary_dir, ROOT / '.cache' / 'supplementary')
        self.assertNotEqual(UTSG.cache_dir, UTM.cache_dir)
        for campus in REGISTRY.values():
            self.assertTrue(campus.cache_dir.is_relative_to(ROOT / '.cache'))
            self.assertTrue(campus.supplementary_dir.is_relative_to(ROOT / '.cache'))

    def test_urls_and_derived_values(self):
        self.assertEqual(UTM.course_url('CSC148H5'), 'https://utm.calendar.utoronto.ca/course/csc148h5')
        self.assertEqual(UTM.course_level('CSC148H5'), 100)
        self.assertEqual(UTM.course_credits('MAT137Y5'), 1)
        self.assertEqual(UTM.academic_year('2026-2027 Calendar'), '2026-2027')
        self.assertEqual(UTSG.academic_year('2026-27 Academic Calendar'), '2026-2027')
        self.assertTrue(UTM.owns('UTM:CSC148H5'))
        self.assertFalse(UTM.owns('UTSG:CSC148H1'))
        self.assertIs(get_campus('UTM'), UTM)
        with self.assertRaises(ValueError):
            get_campus('utsc')

    def test_planned_campus_is_refused_without_allow_planned(self):
        with self.assertRaises(NotImplementedError):
            UTSG.require_supported()
        UTSG.require_supported(allow_planned=True)
        with self.assertRaises(NotImplementedError):
            build_catalog({}, UTSG)
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            main(['--campus', 'utsg', '--parse-only'])

    def test_cli_defaults_to_utm_and_paced_workers(self):
        args = build_parser().parse_args([])
        self.assertEqual(args.campus, 'utm')
        self.assertLessEqual(args.workers, 2)


if __name__ == '__main__':
    unittest.main()
