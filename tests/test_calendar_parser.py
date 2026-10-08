"""Official representative semantics and collection integrity; no network required."""
import json
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'pipeline'))
from calendar_parser import course_id, cycles, exclusion_rule, parse_rule, program_groups, refs, walk  # noqa: E402
from bs4 import BeautifulSoup  # noqa: E402


class RequirementSemantics(unittest.TestCase):
    def test_or_course_alternatives(self):
        rule = parse_rule('ANT101H5 or BIO152H5')
        self.assertEqual(rule['kind'], 'any')
        self.assertEqual({r['courseId'] for r in rule['items']}, {'UTM:ANT101H5', 'UTM:BIO152H5'})

    def test_grade_scope_and_nested_math(self):
        rule = parse_rule('CHM110H5 and a minimum grade of 60% in CHM120H5 and [(MAT132H5 and MAT134H5) or (MAT135H5 and MAT136H5)].')
        self.assertEqual(rule['kind'], 'all')
        self.assertEqual(rule['items'][1], {'kind': 'minGrade', 'courseId': 'UTM:CHM120H5', 'minimum': 60.0})
        self.assertEqual(rule['items'][2]['kind'], 'any')
        self.assertTrue(all(r['kind'] == 'all' for r in rule['items'][2]['items']))
        self.assertFalse(any(r['kind'] == 'unknown' for r in walk(rule)))

    def test_slash_with_semicolon_is_and_of_alternatives(self):
        rule = parse_rule('CSC108H5/CSC110Y5; MAT102H5/MAT157H5')
        self.assertEqual(rule['kind'], 'all')
        self.assertEqual([r['kind'] for r in rule['items']], ['any', 'any'])

    def test_credit_set_retains_credit_amount_and_identity(self):
        rule = parse_rule('1.0 credit from the following: CSC209H5 or CSC258H5 or CSC263H5')
        self.assertEqual(rule['kind'], 'credits')
        self.assertEqual(rule['minimum'], 1.0)
        self.assertEqual(len(rule['courseIds']), 3)

    def test_permission_and_annual_cutoff_stay_non_course_conditions(self):
        self.assertEqual(parse_rule('Permission of the instructor')['kind'], 'permission')
        self.assertEqual(parse_rule('The minimum grade is determined annually and is never lower than 60%.')['kind'], 'all')
        self.assertTrue(all(n['kind'] != 'minGrade' for n in walk(parse_rule('The minimum grade is determined annually and is never lower than 60%.'))))

    def test_complex_credit_distribution_is_unknown(self):
        rule = parse_rule('2.0 credits from CSC300H5 or CSC400H5, of which 1.0 must be at the 400 level')
        self.assertTrue(any(n['kind'] == 'unknown' for n in walk(rule)))

    def test_credit_alternative_packages_cannot_mix_courses(self):
        rule = parse_rule('1.0 credits from (MAT132H5 and MAT134H5) or (MAT135H5 and MAT136H5)')
        self.assertNotEqual(rule['kind'], 'credits')
        self.assertTrue(any(n['kind'] == 'unknown' for n in walk(rule)))

    def test_grade_scope_cannot_be_bypassed_by_an_alternative(self):
        for text in ['A minimum grade of 70% in CSC108H5 or CSC148H5',
                     'CSC108H5 or CSC148H5 with a minimum grade of 70%']:
            self.assertEqual(parse_rule(text)['kind'], 'unknown')

    def test_one_of_does_not_swallow_tail_and(self):
        text = 'One of CSC108H5, CSC148H5, or CSC207H5, and MAT102H5'
        self.assertEqual(parse_rule(text)['kind'], 'unknown')

    def test_credit_total_cannot_be_bypassed_by_or(self):
        for text in ['A minimum of 8.0 credits including CCT109H5 or CCT110H5 or CCT111H5',
                     '4.0 credits including GGR112H5 or ENV100Y5',
                     'JLP285H5/equivalent and 1.0 credit from the following list: LIN318H5 or LIN328H5']:
            self.assertEqual(parse_rule(text)['kind'], 'unknown')

    def test_unknown_or_qualifier_does_not_leave_a_free_pass(self):
        self.assertEqual(parse_rule('approved preparation CSC108H5 or CSC148H5')['kind'], 'unknown')

    def test_program_stream_context_survives_in_leaf_groups(self):
        item = BeautifulSoup('<div><p>Enrolment in the UTMCIP stream requires:</p><ol><li>ISP100H5</li></ol></div>', 'html.parser').div
        groups = program_groups(item, 'https://utm.calendar.utoronto.ca/program/example', 'EXAMPLE', 'admission')
        self.assertTrue(any(n['kind'] == 'unknown' for n in walk(groups[-1]['rule'])))
        self.assertIn('UTMCIP', groups[-1]['rawText'])

    def test_unquantified_elective_list_cannot_certify_a_group(self):
        item = BeautifulSoup('<div><p>Group B:</p><ul><li>ANT101H5 or ANT102H5</li></ul></div>', 'html.parser').div
        groups = program_groups(item, 'https://utm.calendar.utoronto.ca/program/example', 'EXAMPLE', 'completion')
        self.assertTrue(any(n['kind'] == 'unknown' for n in walk(groups[-1]['rule'])))

    def test_program_credit_amount_is_not_removed_as_an_outline_number(self):
        for amount in [0.5, 1.0, 1.5, 2.0, 3.5]:
            for prefix in ['', '1. ', '2) ', '3)']:
                with self.subTest(amount=amount, prefix=prefix):
                    text = f'{prefix}{amount:.1f} credits from CSC108H5 or CSC148H5'
                    item = BeautifulSoup(f'<div><p>{text}</p></div>', 'html.parser').div
                    group = program_groups(item, 'https://utm.calendar.utoronto.ca/program/example', 'EXAMPLE', 'completion')[0]
                    self.assertEqual(group['rule']['kind'], 'credits')
                    self.assertEqual(group['rule']['minimum'], amount)
                    self.assertEqual(group['rawText'], text)

    def test_program_outline_number_still_supports_course_requirements(self):
        for prefix in ['1. ', '2) ', '3.', '4)']:
            with self.subTest(prefix=prefix):
                item = BeautifulSoup(f'<div><p>{prefix}CSC108H5</p></div>', 'html.parser').div
                group = program_groups(item, 'https://utm.calendar.utoronto.ca/program/example', 'EXAMPLE', 'completion')[0]
                self.assertEqual(group['rule'], {'kind': 'course', 'courseId': 'UTM:CSC108H5'})

    def test_cluster_catalogue_is_not_a_list_of_mandatory_courses(self):
        item = BeautifulSoup('<div><p>0.5 credits at 300-level from Cluster A</p>'
                             '<h3>Cluster A - Behavioural Neuroscience area:</h3>'
                             '<p>BIO318Y5, BIO320H5, PSY316H5</p></div>', 'html.parser').div
        group = next(group for group in program_groups(item, 'https://utm.calendar.utoronto.ca/program/example', 'EXAMPLE', 'completion')
                     if 'UTM:BIO318Y5' in group['courseIds'])
        self.assertTrue(any(node['kind'] == 'unknown' for node in walk(group['rule'])))
        self.assertIn('Cluster A', group['rawText'])
        self.assertEqual(group['courseIds'], ['UTM:BIO318Y5', 'UTM:BIO320H5', 'UTM:PSY316H5'])

    def test_exclusion_list_is_any_trigger(self):
        rule = exclusion_rule('CSC108H1, CSCA08H3; CSC108H5')
        self.assertEqual(rule['kind'], 'any')
        self.assertEqual(len(rule['items']), 3)
        self.assertEqual(exclusion_rule('(CSC108H5 and CSC148H5) or permission')['kind'], 'unknown')

    def test_full_codes_are_not_merged(self):
        self.assertEqual(course_id('CSC108H1'), 'UTSG:CSC108H1')
        self.assertEqual(course_id('CSCA08H3'), 'UTSC:CSCA08H3')
        self.assertEqual(len(refs('MAT137H5 MAT137Y5 MAT137Y1')), 3)

    def test_cycle_projection_reports_only_scc(self):
        rows = [{'id': x, 'prerequisites': {'courseIds': deps}} for x, deps in [('a', ['b']), ('b', ['a']), ('c', ['a'])]]
        self.assertEqual(cycles(rows), [['a', 'b']])


class PublishedSnapshot(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = ROOT / 'data' / 'utm' / 'catalog.json'
        if not path.exists():
            raise unittest.SkipTest('Run manual collection before snapshot validation')
        cls.catalog = json.loads(path.read_text(encoding='utf-8'))
        cls.courses = {c['code']: c for c in cls.catalog['courses']}
        cls.report = json.loads((ROOT / 'data' / 'utm' / 'quality-report.json').read_text(encoding='utf-8'))
        cls.manifest = json.loads((ROOT / 'data' / 'utm' / 'manifest.json').read_text(encoding='utf-8'))

    def test_every_discovered_entity_has_one_verified_detail(self):
        self.assertTrue(self.catalog['metadata']['complete'])
        self.assertEqual(self.report['failures'], [])
        for singular, plural in [('course', 'courses'), ('program', 'programs')]:
            directory = self.manifest['directories'][singular]
            published = self.catalog[plural]
            self.assertEqual(len(published), len(directory['entities']))
            self.assertEqual(len(published), len({x['id'] for x in published}))
            self.assertEqual([p['page'] for p in directory['pages']], list(range(len(directory['pages']))))
            self.assertEqual(sum(p['count'] for p in directory['pages']), len(published) + len(directory['duplicates']))
            for row in published:
                self.assertEqual(len(row['contentHash']), 64)
                self.assertTrue(row['fetchedAt'])
                self.assertTrue(row['sourceUrl'].startswith('https://utm.calendar.utoronto.ca/'))

    def test_chm110_recommended_corequisite_does_not_block(self):
        course = self.courses['CHM110H5']
        self.assertEqual(course['corequisites']['rule']['kind'], 'true')
        self.assertEqual(course['corequisites']['courseIds'], [])
        self.assertIn('Recommended Corequisite', course['recommended']['rawText'])
        self.assertTrue(any(n['kind'] == 'unknown' for n in walk(course['prerequisites']['rule'])))

    def test_program_cohort_and_cutoff_provenance_survive(self):
        program = next(p for p in self.catalog['programs'] if p['code'] == 'ERMAJ1688')
        self.assertIn('determined annually', program['admission']['rawText'])
        self.assertEqual(program['admission']['rule']['kind'], 'unknown')
        self.assertTrue(any(n['kind'] == 'applicability' for g in program['groups'] for n in walk(g['rule'])))
        self.assertTrue(any(p['type'] == 'Focus' for p in self.catalog['programs']))

    def test_published_credit_and_placement_conditions_are_not_bypassed(self):
        for code in ['CCT371H5', 'GGR214H5', 'FRE180H5', 'FSL106H5']:
            rule = self.courses[code]['prerequisites']['rule']
            self.assertTrue(any(n['kind'] == 'unknown' for n in walk(rule)), code)
            self.assertNotEqual(rule['kind'], 'any', code)

    def test_published_program_credit_minima_preserve_decimal_amounts(self):
        for program in self.catalog['programs']:
            for group in program['groups']:
                amount = re.match(r'^(\d+\.\d+)\s+credits?', group['rawText'])
                if not amount:
                    continue
                for node in walk(group['rule']):
                    if node['kind'] == 'credits':
                        with self.subTest(group=group['id']):
                            self.assertEqual(node['minimum'], float(amount[1]))


if __name__ == '__main__':
    unittest.main()
