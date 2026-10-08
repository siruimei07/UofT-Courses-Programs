"""Which codes in official requirement text become graph edges (live-audit regressions)."""
from contextlib import redirect_stdout
import dataclasses
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from pipeline.cache import cache_path  # noqa: E402
from pipeline.calendar_parser import (ADMISSION_REASON, CONTEXT_REASON, Audit, build_catalog, course_requirement,  # noqa: E402
                                      parse_course, parse_program, program_groups)
from pipeline.campuses import UTM  # noqa: E402
from pipeline.files import write_json  # noqa: E402
from pipeline.references import (COREQ_OR_REASON, COREQ_REST_REASON, UNRESOLVED_REASON, CodeContext, analyse,  # noqa: E402
                                 normalise_codes, strip_unresolved)
from pipeline.rules import exclusion_rule, parse_rule, rule_course_ids, walk  # noqa: E402

URL = 'https://utm.calendar.utoronto.ca/course/tst300h5'
KNOWN = frozenset({'CSC108H5', 'CSC111H5', 'CSC148H5', 'MAT102H5', 'PHL103H5', 'PHL105Y5', 'PHL245H5', 'PSY325H5',
                   'GGR111H5', 'GGR112H5', 'ENV100Y5', 'FAH287H5', 'FAH288H5', 'LIN104H5', 'LIN105H5', 'LIN231H5',
                   'LIN233H5', 'ENG201Y5', 'CSC110Y5', 'MGT421H5', 'MGT422H5', 'MAT157H5', 'BIO205H5', 'BIO259H5',
                   'FSC239Y5', 'FSC302H5', 'FSC407H5', 'ANT407H5', 'GGR335H5', 'CSC392H5', 'TST300H5'})
CTX = CodeContext('UTM', '5', KNOWN, 2026)
# Calendar of the retired-code tests: FAH105H5, FAH202H5, VCC201H5 and BIO215H5 are absent.
RETIRED_CTX = CodeContext('UTM', '5', frozenset({'FAH101H5', 'FAH288H5', 'FAH289H5', 'FAH385H5', 'BIO206H5', 'BIO304H5',
                                                 'BIO407H5', 'PHL200H5', 'PHL210Y5', 'MGM221H5', 'MGT120H5'}), 2026)


def req(text, field='prerequisites', code='TST300H5', ctx=CTX, parser=None):
    kwargs = {'parser': parser} if parser else {}
    return course_requirement(text, URL, ctx, field, code, **kwargs)[0]


def ast_ids(requirement):
    return rule_course_ids(requirement['rule'])


def course_page(code='TST300H5', **fields):
    items = ''.join(f'<div class="field--name-field-{name}"><div class="field__item">{value}</div></div>'
                    for name, value in fields.items())
    return (f'<html><body><h1 class="page-title">{code} • Synthetic Course</h1><article class="node--type-courses">'
            f'<div class="node__content">{items}</div></article></body></html>')


def program_page(code='ERMAJ9999', **fields):
    items = ''.join(f'<div class="field--name-field-{name}"><div class="field__item">{value}</div></div>'
                    for name, value in fields.items())
    return (f'<html><body><h1 class="page-title">Synthetic Program Major</h1><article class="node">'
            f'<div class="node__content">{items}</div></article></body></html>')


def source(html, url=URL):
    return {'html': html, 'finalUrl': url, 'contentHash': hashlib.sha256(html.encode()).hexdigest(),
            'fetchedAt': '2026-10-08T04:30:00+00:00'}


def groups(html, category='completion'):
    item = BeautifulSoup(f'<div>{html}</div>', 'html.parser').div
    return program_groups(item, 'https://utm.calendar.utoronto.ca/program/example', 'EXAMPLE', category, UTM, CTX)


class NegationMasking(unittest.TestCase):
    def test_except_code_is_mentioned_never_an_edge(self):
        text = ('Open to students who have successfully completed at least 4.0 full credits. Students who do not meet '
                'the prerequisite but are enrolled in any 100-level ENG or DRE course (except ENG100H5 ) may petition '
                'the department in writing for approval to take the course.')
        result = req(text, code='ENG201Y5')
        self.assertEqual(result['courseIds'], [])
        self.assertEqual(result['mentionedIds'], ['UTM:ENG100H5'])
        self.assertNotIn('UTM:ENG100H5', ast_ids(result))

    def test_excluding_list_is_mentioned(self):
        result = req('0.5 credit from any 200-level LIN/JAL/JLP course (excluding LIN204H5 / LIN208H5 / LIN233H5 )')
        self.assertNotIn('UTM:LIN233H5', result['courseIds'])
        self.assertEqual(result['mentionedIds'], ['UTM:LIN204H5', 'UTM:LIN208H5', 'UTM:LIN233H5'])

    def test_negation_stops_at_its_own_list(self):
        result = req('LIN231H5 and 0.5 credit from any LIN course, other than LIN233H5 or LIN104H5. ')
        self.assertEqual(result['courseIds'], ['UTM:LIN231H5'])
        self.assertEqual(result['mentionedIds'], ['UTM:LIN104H5', 'UTM:LIN233H5'])
        bracket = req('1.0 credit from any CSC course (except for CSC392H5 and any CSC ROP courses) or GGR335H5')
        self.assertEqual(bracket['courseIds'], ['UTM:GGR335H5'])
        self.assertEqual(bracket['mentionedIds'], ['UTM:CSC392H5'])

    def test_program_groups_mask_negated_codes(self):
        found = groups('<ol><li>1.0 credit from any 300/400 level CSC course (except for CSC392H5 and CSC393H5 ) or GGR335H5</li>'
                       '<li>ECO220Y5 cannot be substituted for STA256H5 or STA258H5 .</li></ol>')
        self.assertEqual(found[0]['courseIds'], ['UTM:GGR335H5'])
        self.assertEqual(found[0]['mentionedIds'], ['UTM:CSC392H5', 'UTM:CSC393H5'])
        self.assertNotIn('UTM:ECO220Y5', found[1]['courseIds'])
        self.assertIn('UTM:ECO220Y5', found[1]['mentionedIds'])

    def test_retired_alternative_is_pruned_once_its_date_has_passed(self):
        text = ('BIO205H5 and ( BIO259H5 or STA215H5 ) and permission of instructor * STA215H5 will no longer be accepted '
                'as an appropriate prerequisite course AFTER 2022-2023 Academic year.')
        result = req(text)
        self.assertEqual(result['courseIds'], ['UTM:BIO205H5', 'UTM:BIO259H5'])
        self.assertEqual(result['mentionedIds'], ['UTM:STA215H5'])
        self.assertNotIn('UTM:STA215H5', ast_ids(result))
        known = CodeContext('UTM', '5', KNOWN | {'STA215H5'}, 2026)
        future = req('STA215H5 or BIO259H5. STA215H5 will no longer be accepted past September 2027 .', ctx=known)
        self.assertEqual(future['courseIds'], ['UTM:BIO259H5', 'UTM:STA215H5'])
        self.assertNotIn('mentionedIds', future)


class CodeRecognition(unittest.TestCase):
    def test_glued_codes_are_recognised(self):
        result = req('(60% or higher in CSC111H5 )or((60% or higher inCSC148H5) and (60% or higher in MAT102H5 ))', code='CSC236H5')
        self.assertIn('UTM:CSC148H5', result['courseIds'])
        self.assertEqual(result['rule']['kind'], 'any')
        self.assertEqual(result['rule']['items'][1]['items'][0], {'kind': 'minGrade', 'courseId': 'UTM:CSC148H5', 'minimum': 60.0})
        self.assertIn('UTM:PHL105Y5', req('PHL103H5 orPHL105Y5')['courseIds'])

    def test_spaced_codes_are_joined(self):
        result = req('PHL 245H5 and 1.5 additional credits in PHL')
        self.assertEqual(result['courseIds'], ['UTM:PHL245H5'])

    def test_missing_campus_digit_and_suffix_need_exactly_one_catalog_match(self):
        repaired = req('PSY320H5 or PSY325H')
        self.assertEqual(repaired['courseIds'], ['UTM:PSY325H5'])
        self.assertEqual(repaired['unresolvedIds'], ['UTM:PSY320H5'])
        self.assertEqual(req('14.0 credits including GGR111H5 and GGR112 or ENV100Y5')['courseIds'],
                         ['UTM:ENV100Y5', 'UTM:GGR111H5', 'UTM:GGR112H5'])
        self.assertIn('UTM:FAH287H5', req('FAH101H5 and (FAH287 or FAH288H5 )')['courseIds'])
        for text in ['Any 2.0 credits from the ERS300 level', 'FAS200 level courses', 'RLG300-level', 'MAT300/400 level']:
            with self.subTest(text=text):
                normalised, repairs = normalise_codes(text, CTX)
                self.assertEqual(normalised, text)
        # Without a catalog nothing is guessed.
        self.assertEqual(normalise_codes('GGR112 or PSY325H')[0], 'GGR112 or PSY325H')

    def test_misprints_are_not_partial_matches(self):
        self.assertEqual(req('MATH135H5 or MAT102H5')['courseIds'], ['UTM:MAT102H5'])

    def test_weight_mismatch_is_reported_never_substituted(self):
        result, analysis = course_requirement('CSC110H5 or CSC108H5', URL, CTX, 'prerequisites', 'TST300H5')
        self.assertEqual(result['courseIds'], ['UTM:CSC108H5'])
        self.assertEqual(result['unresolvedIds'], ['UTM:CSC110H5'])
        self.assertIn({'kind': 'weightMismatch', 'code': 'CSC110H5', 'existing': 'CSC110Y5'}, analysis.repairs)

    def test_off_campus_digit_zero_is_utsg(self):
        self.assertEqual(req('ACT398H0 / CSC148H1', ctx=CodeContext())['courseIds'], ['UTSG:ACT398H0', 'UTSG:CSC148H1'])


class NonRequirementText(unittest.TestCase):
    def test_no_prerequisite_statement_is_true_without_edges(self):
        result = req('This course has no prerequisites. It can be taken independently, before, or after LIN105H5 .', code='LIN104H5')
        self.assertEqual(result['rule'], {'kind': 'true'})
        self.assertEqual(result['courseIds'], [])
        self.assertEqual(result['mentionedIds'], ['UTM:LIN105H5'])

    def test_advisory_corequisites_are_mentions(self):
        highly = req('Highly Recommended: MGT421H5 and MGT422H5 and ( MGT326H5 or MGT426H5 ) and MGT429H5', 'corequisites', 'MGT420H5')
        self.assertEqual((highly['rule'], highly['courseIds']), ({'kind': 'true'}, []))
        self.assertIn('UTM:MGT421H5', highly['mentionedIds'])
        strongly = req('MAT102H5 (strongly recommended in the Fall term for students taking MAT157H5 in their first year).',
                       'corequisites', 'MAT157H5')
        self.assertEqual((strongly['rule'], strongly['courseIds'], strongly['mentionedIds']), ({'kind': 'true'}, [], ['UTM:MAT102H5']))

    def test_advisory_parenthetical_naming_another_code_keeps_the_preceding_code_required(self):
        result = req('CSC148H5 (CSC108H5 is highly recommended)')
        self.assertEqual(result['rule'], {'kind': 'course', 'courseId': 'UTM:CSC148H5'})
        self.assertEqual(result['courseIds'], ['UTM:CSC148H5'])
        self.assertEqual(result['mentionedIds'], ['UTM:CSC108H5'])

    def test_advisory_parenthetical_without_a_code_makes_only_its_own_course_advisory(self):
        result = req('CSC108H5 and CSC148H5 (highly recommended)')
        self.assertEqual(result['rule'], {'kind': 'course', 'courseId': 'UTM:CSC108H5'})
        self.assertEqual((result['courseIds'], result['mentionedIds']), (['UTM:CSC108H5'], ['UTM:CSC148H5']))
        # A preferred alternative is still an alternative.
        choice = req('CSC108H5 or CSC148H5 (highly recommended)')
        self.assertEqual(choice['rule'], {'kind': 'any', 'items': [{'kind': 'course', 'courseId': 'UTM:CSC108H5'},
                                                                   {'kind': 'course', 'courseId': 'UTM:CSC148H5'}]})
        self.assertNotIn('mentionedIds', choice)

    def test_independently_needs_the_no_prerequisite_lead(self):
        result = req('CSC108H5 and CSC148H5. This course can be taken independently.')
        self.assertEqual(result['courseIds'], ['UTM:CSC108H5', 'UTM:CSC148H5'])
        self.assertNotIn('mentionedIds', result)
        self.assertNotEqual(result['rule'], {'kind': 'true'})
        self.assertIn({'kind': 'course', 'courseId': 'UTM:CSC108H5'}, result['rule']['items'])

    def test_chm_recommended_corequisite_moves_to_recommended(self):
        coreq = ('Recommended Corequisite: ( MAT132H5 and MAT134H5 ) or ( MAT157H5 and MAT159H5 ); this recommended '
                 'corequisite is a prerequisite for all 200 level CHM courses.')
        course = parse_course({'code': 'TST300H5', 'url': URL}, source(course_page(corequisite=coreq)), UTM, CTX)
        self.assertEqual(course['corequisites']['rule'], {'kind': 'true'})
        self.assertEqual(course['corequisites']['courseIds'], [])
        self.assertIn('UTM:MAT157H5', course['corequisites']['mentionedIds'])
        self.assertIn('Recommended Corequisite', course['recommended']['rawText'])
        self.assertEqual(course['corequisites']['rawText'], coreq)

    def test_graded_course_stays_mandatory_before_a_highly_recommended_tail(self):
        text = ('Grade 12 Chemistry (SCH4U) (minimum grade of 70) and Grade 12 Advanced Functions (MHF4U0) (minimum grade of 70) '
                'and Grade 12 Calculus and Vectors (MCV4U) highly recommended')
        analysis = analyse(text, CTX, 'prerequisites')
        self.assertEqual(analysis.advisory_text, 'Grade 12 Calculus and Vectors (MCV4U) highly recommended')
        self.assertIn('Advanced Functions', analysis.rule_text)

    def test_conditional_sentences_are_mentions(self):
        text = ('( FSC239Y5 and FSC302H5 ) or Permission of Instructor. Students seeking to use FSC407H5 as their capstone '
                'placement must have: Completion of FSC302H5 Completion of ( ANT407H5 or BIO259H5 ). Course Application is required.')
        result = req(text, code='FSC407H5')
        self.assertEqual(result['courseIds'], ['UTM:FSC239Y5', 'UTM:FSC302H5'])
        self.assertEqual(result['mentionedIds'], ['UTM:ANT407H5', 'UTM:BIO259H5'])
        self.assertEqual(result['rule']['kind'], 'all')
        self.assertEqual(result['rule']['items'][0]['kind'], 'any')
        self.assertEqual(result['rule']['items'][-1]['kind'], 'unknown')

    def test_waiver_relaxes_instead_of_restricting(self):
        result = req('ARA312Y5 or ARA311H5. Students who have not completed ARA312Y5 or ARA311H5 must obtain permission '
                     'from the department before enrolling.', ctx=CodeContext())
        self.assertEqual(result['rule']['kind'], 'any')
        self.assertEqual(result['courseIds'], ['UTM:ARA311H5', 'UTM:ARA312Y5'])

    def test_route_statements_keep_their_edges(self):
        known = CodeContext('UTM', '5', KNOWN | {'ITA100Y5'}, 2026)
        result = req('Open to all students. If enrolled in an Italian program: ITA100Y5 or permission of the department.', ctx=known)
        self.assertEqual(result['courseIds'], ['UTM:ITA100Y5'])
        self.assertNotIn('mentionedIds', result)

    def test_may_be_taken_as_corequisite_becomes_a_corequisite_reference(self):
        text = '( PHL101H5 or PHL103H5 orPHL105Y5 ) (may be taken as a corequisite) or 4.0 credits'
        course = parse_course({'code': 'PHL299Y5', 'url': URL}, source(course_page('PHL299Y5', prerequisite=text)), UTM, CTX)
        prereq, coreq = course['prerequisites'], course['corequisites']
        self.assertEqual(prereq['courseIds'], [])
        self.assertEqual(prereq['rule']['reason'], COREQ_OR_REASON)
        self.assertEqual(coreq['courseIds'], ['UTM:PHL103H5', 'UTM:PHL105Y5'])
        self.assertEqual(coreq['unresolvedIds'], ['UTM:PHL101H5'])
        # The official corequisite field is empty, and the courses are alternatives to "4.0 credits",
        # not required corequisites: the rule says so instead of claiming nothing is required.
        self.assertEqual(coreq['rawText'], '')
        self.assertEqual(coreq['rule'], {'kind': 'any', 'items': [
            {'kind': 'course', 'courseId': 'UTM:PHL103H5'}, {'kind': 'course', 'courseId': 'UTM:PHL105Y5'},
            {'kind': 'unknown', 'text': '4.0 credits', 'reason': COREQ_REST_REASON}]})

    def test_corequisite_note_beside_a_required_course_or_alone(self):
        both = parse_course({'code': 'TST300H5', 'url': URL},
                            source(course_page(prerequisite='CSC108H5 and CSC148H5 (may be taken as a corequisite)')), UTM, CTX)
        self.assertEqual(both['prerequisites']['rule'], {'kind': 'course', 'courseId': 'UTM:CSC108H5'})
        self.assertEqual(both['prerequisites']['courseIds'], ['UTM:CSC108H5'])
        self.assertEqual(both['corequisites']['rule'], {'kind': 'course', 'courseId': 'UTM:CSC148H5'})
        self.assertEqual(both['corequisites']['courseIds'], ['UTM:CSC148H5'])
        alone = parse_course({'code': 'TST300H5', 'url': URL},
                             source(course_page(prerequisite='PHL103H5 (may be taken concurrently)')), UTM, CTX)
        self.assertEqual((alone['prerequisites']['rule'], alone['prerequisites']['courseIds']), ({'kind': 'true'}, []))
        self.assertEqual(alone['corequisites']['rule'], {'kind': 'course', 'courseId': 'UTM:PHL103H5'})

    def test_corequisite_note_outside_course_fields_keeps_the_reference(self):
        # EDS388H5's recommended preparation: the annotated code must not vanish from every list.
        result = req('CSC108H5 and CSC148H5 (may be taken as a co-requisite).', 'recommended')
        self.assertEqual(result['courseIds'], ['UTM:CSC108H5', 'UTM:CSC148H5'])
        self.assertLessEqual(ast_ids(result), set(result['courseIds']))

    def test_self_references_are_dropped(self):
        result = req('ANT202H5 or ( BIO206H5 , BIO207H5 ). Enrolment without the above requirements may be granted by '
                     'permission of instructor, if FSC307H5 is being used to satisfy the IDENT requirement.',
                     code='FSC307H5', ctx=CodeContext())
        self.assertNotIn('UTM:FSC307H5', result['courseIds'] + result.get('mentionedIds', []))
        self.assertEqual(req('ECO358H5 is not open to Commerce students.', 'restrictions', 'ECO358H5')['courseIds'], [])

    def test_self_reference_is_pruned_from_the_rule(self):
        self.assertEqual(req('CSC108H5 or TST300H5')['rule'], {'kind': 'course', 'courseId': 'UTM:CSC108H5'})
        self.assertEqual(req('CSC108H5 and TST300H5 and CSC148H5')['rule'],
                         {'kind': 'all', 'items': [{'kind': 'course', 'courseId': 'UTM:CSC108H5'},
                                                   {'kind': 'course', 'courseId': 'UTM:CSC148H5'}]})
        self.assertEqual(req('TST300H5')['rule'], {'kind': 'true'})


class UnresolvedReferences(unittest.TestCase):
    def test_same_campus_codes_absent_from_the_catalog_are_never_edges(self):
        result = req('HIN312Y5 or BIO205H5')
        self.assertEqual(result['courseIds'], ['UTM:BIO205H5'])
        self.assertEqual(result['unresolvedIds'], ['UTM:HIN312Y5'])
        self.assertEqual(result['rule'], {'kind': 'course', 'courseId': 'UTM:BIO205H5'})
        other_campus = req('CSC148H1 or CSC148H5')
        self.assertEqual(other_campus['courseIds'], ['UTM:CSC148H5', 'UTSG:CSC148H1'])

    def test_unresolved_codes_leave_the_ast(self):
        ctx = CodeContext('UTM', '5', frozenset({'CHM110H5', 'MAT132H5', 'MAT134H5', 'BIO205H5'}), 2026)
        math = req('CHM110H5 and [( MAT132H5 and MAT134H5 ) or ( MAT134Y5 or MAT137Y5 )]', ctx=ctx)
        self.assertEqual(math['rule'], {'kind': 'all', 'items': [
            {'kind': 'course', 'courseId': 'UTM:CHM110H5'},
            {'kind': 'all', 'items': [{'kind': 'course', 'courseId': 'UTM:MAT132H5'}, {'kind': 'course', 'courseId': 'UTM:MAT134H5'}]}]})
        self.assertEqual(math['unresolvedIds'], ['UTM:MAT134Y5', 'UTM:MAT137Y5'])
        required = req('BIO204H5 and BIO205H5', ctx=ctx)
        self.assertEqual(required['rule']['items'][0]['kind'], 'unknown')
        self.assertEqual(required['rule']['items'][0]['text'], 'BIO204H5')
        self.assertEqual(required['rule']['items'][1], {'kind': 'course', 'courseId': 'UTM:BIO205H5'})
        only = req('HIN312Y5')
        self.assertEqual((only['rule']['kind'], only['courseIds'], only['unresolvedIds']), ('unknown', [], ['UTM:HIN312Y5']))
        pool = req('1.0 credit from BIO205H5 or BIO204H5', ctx=ctx)
        self.assertEqual(pool['rule'], {'kind': 'credits', 'minimum': 1.0, 'courseIds': ['UTM:BIO205H5']})

    def test_an_and_branch_of_an_or_keeps_its_current_courses(self):
        text = '( FAH101H5 or FAH105H5 or FAH202H5 ) and VCC201H5 and ( FAH288H5 or FAH289H5 ) or permission of instructor'
        result = req(text, code='FAH385H5', ctx=RETIRED_CTX)
        self.assertEqual(result['courseIds'], ['UTM:FAH101H5', 'UTM:FAH288H5', 'UTM:FAH289H5'])
        self.assertEqual(result['unresolvedIds'], ['UTM:FAH105H5', 'UTM:FAH202H5', 'UTM:VCC201H5'])
        self.assertEqual(result['rule']['kind'], 'any')
        branch, permission = result['rule']['items']
        self.assertEqual(permission['kind'], 'permission')
        self.assertEqual(branch, {'kind': 'all', 'items': [
            {'kind': 'course', 'courseId': 'UTM:FAH101H5'},
            {'kind': 'unknown', 'text': 'VCC201H5', 'reason': UNRESOLVED_REASON},
            {'kind': 'any', 'items': [{'kind': 'course', 'courseId': 'UTM:FAH288H5'}, {'kind': 'course', 'courseId': 'UTM:FAH289H5'}]}]})
        # Every graph edge of the field is backed by the rule.
        self.assertEqual(ast_ids(result), set(result['courseIds']))

    def test_an_alternative_made_only_of_retired_codes_is_dropped(self):
        rule = parse_rule('( FAH105H5 and FAH202H5 ) or FAH101H5')
        self.assertEqual(strip_unresolved(rule, {'UTM:FAH105H5', 'UTM:FAH202H5'}), {'kind': 'course', 'courseId': 'UTM:FAH101H5'})
        self.assertEqual(strip_unresolved(rule, {'UTM:FAH105H5', 'UTM:FAH202H5', 'UTM:FAH101H5'})['kind'], 'unknown')

    def test_recommendations_drop_only_the_retired_atom(self):
        bio = req('BIO206H5 and BIO215H5 and BIO304H5', 'recommended', 'BIO407H5', ctx=RETIRED_CTX)
        self.assertEqual(bio['rule'], {'kind': 'all', 'items': [{'kind': 'course', 'courseId': 'UTM:BIO206H5'},
                                                                {'kind': 'course', 'courseId': 'UTM:BIO304H5'}]})
        self.assertEqual(bio['unresolvedIds'], ['UTM:BIO215H5'])
        phl = req('PHL200H5 or PHL202H5 and PHL210Y5', 'recommended', 'PHL301H5', ctx=RETIRED_CTX)
        self.assertEqual(phl['rule'], {'kind': 'any', 'items': [{'kind': 'course', 'courseId': 'UTM:PHL200H5'},
                                                                {'kind': 'course', 'courseId': 'UTM:PHL210Y5'}]})
        only = req('BIO215H5', 'recommended', 'BIO407H5', ctx=RETIRED_CTX)
        self.assertEqual((only['rule'], only['unresolvedIds']), ({'kind': 'true'}, ['UTM:BIO215H5']))

    def test_exclusions_never_turn_half_of_a_pair_into_a_certain_trigger(self):
        pair = req('MGM221H5 or MGT120H5 and MGT121H5', 'exclusions', ctx=RETIRED_CTX, parser=exclusion_rule)
        self.assertEqual(pair['rule'], {'kind': 'any', 'items': [
            {'kind': 'course', 'courseId': 'UTM:MGM221H5'},
            {'kind': 'all', 'items': [{'kind': 'course', 'courseId': 'UTM:MGT120H5'},
                                      {'kind': 'unknown', 'text': 'MGT121H5', 'reason': UNRESOLVED_REASON}]}]})
        listed = req('MGM221H5, MGT121H5', 'exclusions', ctx=RETIRED_CTX, parser=exclusion_rule)
        self.assertEqual((listed['rule'], listed['unresolvedIds']), ({'kind': 'course', 'courseId': 'UTM:MGM221H5'}, ['UTM:MGT121H5']))
        retired = req('MGT121H5', 'exclusions', ctx=RETIRED_CTX, parser=exclusion_rule)
        self.assertEqual((retired['rule'], retired['courseIds'], retired['unresolvedIds']), ({'kind': 'true'}, [], ['UTM:MGT121H5']))

    def test_formerly_codes_stay_exclusion_triggers(self):
        audit = Audit()
        text = 'FAH248H5 : Canadian Painting 1665-1960 (formerly FAH286H1 ) or VPHB60H3 : Canadian Visual Art'
        course = parse_course({'code': 'FAH292H5', 'url': URL}, source(course_page('FAH292H5', exclusion=text)), UTM, CTX, audit)
        exclusions = course['exclusions']
        self.assertEqual(exclusions['courseIds'], ['UTSC:VPHB60H3', 'UTSG:FAH286H1'])
        self.assertEqual(exclusions['unresolvedIds'], ['UTM:FAH248H5'])
        self.assertNotIn('mentionedIds', exclusions)
        self.assertEqual(exclusions['rawText'], text)
        # The alias belongs to the code of its own clause, not to the course whose page cites it.
        self.assertEqual([(a['formerly'], a['current']) for a in audit.aliases], [('UTSG:FAH286H1', 'UTM:FAH248H5')])
        plain = req('CSC108H5 (formerly CSC108H1 ), CSC148H1', 'exclusions', parser=exclusion_rule)
        self.assertEqual(plain['rule'], {'kind': 'any', 'items': [{'kind': 'course', 'courseId': 'UTM:CSC108H5'},
                                                                  {'kind': 'course', 'courseId': 'UTSG:CSC108H1'},
                                                                  {'kind': 'course', 'courseId': 'UTSG:CSC148H1'}]})

    def test_formerly_codes_are_aliases_not_requirements(self):
        audit = Audit()
        course = parse_course({'code': 'LIN205H5', 'url': URL},
                              source(course_page('LIN205H5', prerequisite='LIN105H5 (formerly LIN204H5 )')), UTM, CTX, audit)
        prereq = course['prerequisites']
        self.assertEqual(prereq['rule'], {'kind': 'course', 'courseId': 'UTM:LIN105H5'})
        self.assertEqual(prereq['courseIds'], ['UTM:LIN105H5'])
        self.assertEqual(prereq['unresolvedIds'], ['UTM:LIN204H5'])
        self.assertEqual([(a['formerly'], a['current']) for a in audit.aliases], [('UTM:LIN204H5', 'UTM:LIN105H5')])


class ProgramGroups(unittest.TestCase):
    def test_stream_context_does_not_leak_into_later_paragraphs(self):
        cmp1 = 'For students who were admitted to UTM in the CMP1 stream, those 4.0 credits must include:'
        found = groups(f'<p>{cmp1}</p><ol><li>CSC110Y5</li></ol>'
                       '<p>For students admitted to UTM in Fall 2026 and beyond through any admission category, those 4.0 credits must include:</p>'
                       '<ol><li>CSC148H5</li></ol>', 'admission')
        later = [g for g in found if 'UTM:CSC148H5' in g['courseIds']]
        self.assertTrue(later)
        for group in later:
            self.assertNotIn('CMP1', json.dumps(group))
        # A cohort paragraph is the cohort and the label of its groups; the official text stays the item's own.
        first = next(g for g in found if 'UTM:CSC110Y5' in g['courseIds'])
        self.assertEqual(first['rawText'], 'CSC110Y5')
        self.assertEqual(first['label'], cmp1 + ' · 1')
        self.assertEqual(first['rule']['cohort'], cmp1)

    def test_admission_context_is_a_reason_never_official_text(self):
        found = groups('<ol><li>CSC148H5</li></ol><p>A cumulative grade point average, determined annually.</p>', 'admission')
        self.assertEqual([g['rawText'] for g in found], ['CSC148H5', 'A cumulative grade point average, determined annually.'])
        self.assertEqual(found[0]['rule'], {'kind': 'all', 'items': [{'kind': 'unknown', 'text': '', 'reason': ADMISSION_REASON},
                                                                     {'kind': 'course', 'courseId': 'UTM:CSC148H5'}]})
        self.assertEqual(found[0]['courseIds'], ['UTM:CSC148H5'])
        for group in found:
            self.assertNotIn('Admission clauses depend', json.dumps(group))
        # Completion groups get no admission context.
        self.assertEqual(groups('<ol><li>CSC148H5</li></ol>')[0]['rule'], {'kind': 'course', 'courseId': 'UTM:CSC148H5'})

    def test_stream_section_frames_its_cohort_pathways_and_trailing_paragraphs(self):
        utmcip = ('Enrolment in the UTMCIP stream of this program is limited to students who have completed 4.0 credits. '
                  'There are three admissions pathways, and students must satisfy one.')
        html = ('<p>For students admitted to UTM in Fall 2026 and beyond:</p><ol><li>CSC148H5</li></ol>'
                '<p>Students who have achieved a cumulative GPA of at least 2.5 are encouraged to apply.</p>'
                f'<p>Notes:</p><p>{utmcip}</p>'
                '<p>For students who were admitted to UTM in the CMP1 stream, those 4.0 credits must include:</p><ol><li>CSC110Y5</li></ol>'
                '<p>For students admitted to UTM in Fall 2026 and beyond, those 4.0 credits must include:</p><ol><li>CSC148H5</li></ol>'
                '<p>Students who have achieved a cumulative GPA of at least 2.5 are encouraged to apply.</p>')
        found = groups(html, 'admission')
        start = next(i for i, g in enumerate(found) if g['rawText'] == utmcip)
        regular, stream = found[:start], found[start + 1:]
        self.assertEqual(found[start]['label'], 'UTMCIP stream')
        self.assertEqual(len(stream), 5)
        for group in regular:
            self.assertNotIn('UTMCIP', json.dumps(group))
        for group in stream:
            self.assertTrue(group['label'].startswith('UTMCIP stream · '), group['label'])
            self.assertNotIn('UTMCIP', group['rawText'])
            self.assertIn({'kind': 'unknown', 'text': utmcip, 'reason': CONTEXT_REASON}, list(walk(group['rule'])))
        self.assertEqual(stream[-1]['rawText'], 'Students who have achieved a cumulative GPA of at least 2.5 are encouraged to apply.')

    def test_route_paragraph_without_pathways_frames_only_its_list(self):
        found = groups('<p>Enrolment in the UTMCIP stream requires:</p><ol><li>ISP100H5</li></ol>'
                       '<p>Students who have achieved a cumulative GPA of at least 3.0 are encouraged to apply.</p>', 'admission')
        self.assertIn('UTMCIP', found[0]['rawText'])
        # Only the heading label carries on; the paragraph's text and rule do not get the route.
        self.assertNotIn('UTMCIP', found[-1]['rawText'] + json.dumps(found[-1]['rule']))
        self.assertEqual(found[-1]['rule']['items'][0], {'kind': 'unknown', 'text': '', 'reason': ADMISSION_REASON})

    def test_program_group_repairs_and_aliases_reach_the_audit(self):
        audit = Audit()
        html = program_page('ERMIN1425', **{'post-code': 'ERMIN1425', 'enrolment-requirements': '<p>ENV100Y or GGR112</p>',
                                            'completion-req': '<p>GGR111H5 and LIN105H5 (formerly LIN204H5 )</p>'})
        program = parse_program({'code': 'ERMIN1425', 'url': URL}, source(html), UTM, CTX, audit)
        self.assertEqual(program['groups'][0]['courseIds'], ['UTM:ENV100Y5', 'UTM:GGR112H5'])
        repairs = {(r['entityId'], r['field'], r['kind'], r.get('code')) for r in audit.repairs}
        self.assertIn(('UTM:ERMIN1425', 'UTM:ERMIN1425:admission:1', 'campusDigit', 'ENV100Y5'), repairs)
        self.assertIn(('UTM:ERMIN1425', 'UTM:ERMIN1425:admission:1', 'suffix', 'GGR112H5'), repairs)
        self.assertIn({'formerly': 'UTM:LIN204H5', 'current': 'UTM:LIN105H5', 'entityId': 'UTM:ERMIN1425',
                       'field': 'UTM:ERMIN1425:completion:1'}, audit.aliases)

    def test_context_paragraph_text_is_not_duplicated(self):
        text = '1. In addition to the course requirements above, students must complete the UTM Co-op or CSC490H5.'
        found = groups(f'<p>Notes:</p><p>{text}</p>')
        self.assertEqual(found[0]['rawText'], text)

    def test_nested_list_is_attached_to_the_item_before_it(self):
        found = groups('<ul><li>1.0 credit: LIN101H5 and LIN102H5</li><li>1.0 credit: Electives</li>'
                       '<ul><li>1.0 credit from any LIN courses at the 200-level or higher, excluding LIN204H5 , LIN208H5 , and LIN233H5 .</li></ul></ul>')
        self.assertEqual(len(found), 2)
        self.assertIn('excluding LIN204H5', found[1]['rawText'])
        self.assertEqual(found[1]['mentionedIds'], ['UTM:LIN204H5', 'UTM:LIN208H5', 'UTM:LIN233H5'])

    def test_conjunction_fragments_are_not_groups(self):
        found = groups('<p>2.0 credits from ANT200H5 or ANT201H5</p><p>and</p><p>2. ANT204H5</p><p>-</p><p>___</p>')
        self.assertEqual([g['rawText'] for g in found], ['2.0 credits from ANT200H5 or ANT201H5', '2. ANT204H5'])

    def test_focus_program_uses_its_url_slug_as_code(self):
        audit = Audit()
        html = program_page(**{'post-code': 'Focus in Business Data Analytics', 'completion-req': '<p>MGT201H5</p>'})
        program = parse_program({'code': 'FOCUS-BUSINESS-DATA-ANALYTICS', 'url': URL}, source(html), UTM, CTX, audit)
        self.assertEqual(program['code'], 'FOCUS-BUSINESS-DATA-ANALYTICS')
        self.assertEqual(program['codeSource'], 'url-slug')
        self.assertEqual(audit.program_codes[0]['postCodeField'], 'Focus in Business Data Analytics')
        regular = parse_program({'code': 'ERMAJ9999', 'url': URL},
                                source(program_page(**{'post-code': 'ERMAJ9999', 'completion-req': '<p>MGT201H5</p>'})), UTM, CTX)
        self.assertEqual(regular['code'], 'ERMAJ9999')
        self.assertNotIn('codeSource', regular)


class CourseFields(unittest.TestCase):
    def test_optional_delivery_experience_and_international_fields(self):
        html = course_page(campus='Sheridan', **{'course-experience': 'Partnership-Based Experience',
                                                  'international-component': 'International - Optional'})
        course = parse_course({'code': 'TST300H5', 'url': URL}, source(html), UTM, CTX)
        self.assertEqual(course['deliveryCampus'], 'Sheridan')
        self.assertEqual(course['courseExperience'], 'Partnership-Based Experience')
        self.assertEqual(course['internationalComponent'], 'International - Optional')
        plain = parse_course({'code': 'TST300H5', 'url': URL}, source(course_page()), UTM, CTX)
        for name in ['deliveryCampus', 'courseExperience', 'internationalComponent']:
            self.assertNotIn(name, plain)

    def test_exclusions_mixing_and_with_or_keep_the_pairing(self):
        rule = exclusion_rule('MGM221H5 or MGAB01H3 and MGAB02H3 or RSM219H1')
        self.assertEqual(rule['kind'], 'any')
        self.assertEqual(rule['items'][1], {'kind': 'all', 'items': [{'kind': 'course', 'courseId': 'UTSC:MGAB01H3'},
                                                                    {'kind': 'course', 'courseId': 'UTSC:MGAB02H3'}]})
        self.assertEqual(exclusion_rule('ANT378H1 and ANTC19H3 or ANTC20H3, ANT100Y5')['kind'], 'unknown')
        self.assertEqual(exclusion_rule('HIS101H5 and HIS103H5')['kind'], 'any')

    def test_ast_never_references_a_code_outside_courseids_or_unresolvedids(self):
        for text in ['CSC148H5 or CSC111H5 (except CSC111H5 )', 'LIN231H5 and LIN233H5 except LIN233H5',
                     'HIN312Y5 and BIO205H5', 'PHL103H5 (may be taken as a corequisite)']:
            with self.subTest(text=text):
                result = req(text)
                self.assertLessEqual(ast_ids(result), set(result['courseIds']))
                self.assertFalse(set(result.get('mentionedIds', [])) & set(result['courseIds']))


class BuildCatalog(unittest.TestCase):
    """End-to-end over a tiny verified cache: candidates, accept, LF output, untouched sources."""

    def test_build_and_accept_from_a_fixture_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            campus = dataclasses.replace(UTM, cache_dir=base / 'cache', data_root=base / 'data')
            generation = 'fixture'

            def store(url, html):
                record = {'url': url, 'finalUrl': url, 'html': html, 'generationId': generation,
                          'contentHash': hashlib.sha256(html.encode()).hexdigest(), 'fetchedAt': '2026-10-08T04:30:00+00:00'}
                write_json(cache_path(url, campus.cache_dir), record)
                return {'url': url, 'contentHash': record['contentHash'], 'fetchedAt': record['fetchedAt']}

            home = store(campus.calendar_url, '<h1 class="page-title">2026-2027 Calendar</h1>')
            courses = {'CSC148H5': course_page('CSC148H5'),
                       'CSC236H5': course_page('CSC236H5', prerequisite='(60% or higher inCSC148H5) and HIN312Y5')}
            entities = {'course': [], 'program': []}
            details = []
            for code, html in courses.items():
                reference = store(campus.course_url(code), html)
                entities['course'].append({'code': code, 'title': code, 'url': reference['url'], 'directoryUrl': campus.course_search_url})
                details.append({'kind': 'course', 'code': code, 'status': 'ok', **reference})
            program = store(campus.program_url('ERMAJ9999'), program_page(**{'post-code': 'ERMAJ9999', 'completion-req': '<p>CSC236H</p>'}))
            entities['program'].append({'code': 'ERMAJ9999', 'title': 'Synthetic', 'url': program['url'], 'directoryUrl': campus.program_search_url})
            details.append({'kind': 'program', 'code': 'ERMAJ9999', 'status': 'ok', **program})
            directories = {kind: {'entryUrl': campus.search_url(kind), 'entities': items, 'duplicates': [], 'complete': True,
                                  'pages': [{'page': 0, 'count': len(items), 'codes': [e['code'] for e in items],
                                             **store(campus.search_url(kind), '<h3>directory ' + kind + '</h3>')}]}
                           for kind, items in entities.items()}
            manifest = {'generationId': generation, 'startedAt': '2026-10-08T04:29:00+00:00', 'finishedAt': '2026-10-08T04:31:00+00:00',
                        'academicYear': '2026-2027', 'academicYearEvidence': {**home, 'heading': '2026-2027 Calendar'},
                        'directories': directories, 'details': details, 'failures': [], 'supportingSources': [], 'complete': True}
            write_json(campus.cache_dir / 'manifest.json', manifest)
            write_json(campus.cache_dir / 'active-run.json', {'generationId': generation})
            sources_before = {p.name: p.read_bytes() for p in campus.cache_dir.iterdir()}
            with redirect_stdout(io.StringIO()):
                catalog, report = build_catalog(manifest, campus, accept=True)
            after = {p.name: p.read_bytes() for p in campus.cache_dir.iterdir()}
            self.assertEqual({name: after[name] for name in sources_before}, sources_before)
            self.assertEqual(set(after) - set(sources_before), {'catalog.candidate.json', 'quality-report.candidate.json'})
            for name in ['catalog.json', 'quality-report.json', 'manifest.json', 'data-quality.md']:
                raw = (campus.out_dir / name).read_bytes()
                self.assertNotIn(b'\r', raw, name)
            published = json.loads((campus.out_dir / 'catalog.json').read_text(encoding='utf-8'))
            self.assertEqual(published, catalog)
            csc236 = next(c for c in catalog['courses'] if c['code'] == 'CSC236H5')
            self.assertEqual(csc236['prerequisites']['courseIds'], ['UTM:CSC148H5'])
            self.assertEqual(csc236['prerequisites']['unresolvedIds'], ['UTM:HIN312Y5'])
            self.assertEqual(catalog['programs'][0]['groups'][0]['courseIds'], ['UTM:CSC236H5'])
            self.assertEqual([r['courseId'] for r in report['unresolvedReferences']], ['UTM:HIN312Y5'])
            self.assertIn({'entityId': 'UTM:ERMAJ9999', 'field': 'UTM:ERMAJ9999:completion:1', 'kind': 'campusDigit',
                           'text': 'CSC236H', 'code': 'CSC236H5'}, report['codeRepairs'])
            self.assertEqual(report['unresolvedReferences'][0]['roles'], ['unresolved'])
            markdown = (campus.out_dir / 'data-quality.md').read_text(encoding='utf-8')
            self.assertIn('data/utm/quality-report.json', markdown)
            self.assertEqual(csc236['prerequisites']['rule']['items'][0],
                             {'kind': 'minGrade', 'courseId': 'UTM:CSC148H5', 'minimum': 60.0})
            self.assertEqual(csc236['prerequisites']['rule']['items'][1]['text'], 'HIN312Y5')
            self.assertEqual([n['kind'] for n in walk(csc236['prerequisites']['rule'])].count('unknown'), 1)


if __name__ == '__main__':
    unittest.main()
