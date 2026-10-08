"""Course references in official requirement text: code recognition and requirement roles.

A code found in requirement text is not automatically a requirement. ``analyse`` gives every
code one role, and only the required ones become ``courseIds`` (graph edges):

- required      courseIds; same-campus codes absent from the calendar go to unresolvedIds
- corequisite   "(may be taken as a corequisite)": edges of the corequisite field instead
- mentioned     ruled out ("except X", "excluding X", "X will no longer be accepted"),
                advisory ("Highly Recommended: X"), conditional ("Students seeking ...: X"),
                or a field that states it has no prerequisites
- alias         "(formerly X)": retired numbering, reported in the alias table; in exclusions
                the old code stays a trigger (having taken it is having taken the course)
- self          the course's own code; always dropped, and pruned from the rule

Code recognition also repairs official typography when it is unambiguous: glued codes
("inCSC148H5"), spaced codes ("PHL 245H5"), a missing campus digit ("PSY325H") or a bare
"GGR112" when exactly one catalog code matches. H/Y mismatches are reported, never fixed.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import re

from .rules import COURSE_PATTERN, COURSE_RE, FORMERLY, clean, combine, course_id, parse_rule, rule_course_ids, unknown

# --- Code recognition -------------------------------------------------------------------

GLUED_CODE = re.compile(r'(?<=[a-z])(?=' + COURSE_PATTERN + r'(?![0-9A-Z]))')
GLUED_CONNECTIVE = re.compile(r'(?<=[)\]])(or|and)(?=[(\[])')
SPACED_CODE = re.compile(r'(?<![A-Za-z0-9])([A-Z]{3}) (\d{3}[HY][0135])(?![0-9A-Z])')
NO_CAMPUS_DIGIT = re.compile(r'(?<![A-Z0-9])([A-Z]{3}\d{3}[HY])(?![0-9A-Za-z])')
BARE_NUMBER = re.compile(r'(?<![A-Z0-9])([A-Z]{3}\d{3})(?![0-9A-Za-z])(?!\s*(?:-|/|\(|[Ll]evel\b))')


@dataclass(frozen=True)
class CodeContext:
    """What the parser knows about the campus being parsed."""
    campus_id: str = 'UTM'
    campus_digit: str = '5'
    known: frozenset = frozenset()
    academic_year: int | None = None

    def resolves(self, cid):
        return not self.known or not cid.startswith(self.campus_id + ':') or cid.split(':', 1)[1] in self.known


NO_CONTEXT = CodeContext()


def normalise_codes(text, ctx: CodeContext = NO_CONTEXT):
    """Rewrite unambiguous code typography; returns (text, repairs)."""
    repairs = []
    text = GLUED_CONNECTIVE.sub(lambda m: ' ' + m[1] + ' ', text)
    for match in GLUED_CODE.finditer(text):
        repairs.append({'kind': 'glued', 'text': text[max(0, match.start() - 2):match.start() + 8]})
    text = GLUED_CODE.sub(' ', text)

    def spaced(match):
        code = match[1] + match[2]
        repairs.append({'kind': 'spaced', 'text': match[0], 'code': code})
        return code

    text = SPACED_CODE.sub(spaced, text)

    def campus_digit(match):
        code = match[1] + ctx.campus_digit
        if ctx.known and code in ctx.known:
            repairs.append({'kind': 'campusDigit', 'text': match[0], 'code': code})
            return code
        repairs.append({'kind': 'unrecognizedCode', 'text': match[0]})
        return match[0]

    text = NO_CAMPUS_DIGIT.sub(campus_digit, text)

    def bare(match):
        if not ctx.known:
            return match[0]
        candidates = [match[1] + weight + ctx.campus_digit for weight in 'HY' if match[1] + weight + ctx.campus_digit in ctx.known]
        if len(candidates) == 1:
            repairs.append({'kind': 'suffix', 'text': match[0], 'code': candidates[0]})
            return candidates[0]
        if re.fullmatch(r'[A-Z]{3}[1-4]\d{2}', match[1]):
            repairs.append({'kind': 'unrecognizedCode', 'text': match[0]})
        return match[0]

    text = BARE_NUMBER.sub(bare, text)
    return text, repairs


def mismatch_warnings(codes, ctx: CodeContext):
    """Same-campus codes absent from the calendar whose H/Y twin exists."""
    warnings = []
    for code in sorted(set(codes)):
        if not ctx.known or not code.endswith(ctx.campus_digit) or code in ctx.known:
            continue
        twin = code[:-2] + ('Y' if code[-2] == 'H' else 'H') + code[-1]
        if twin in ctx.known:
            warnings.append({'kind': 'weightMismatch', 'code': code, 'existing': twin})
    return warnings


# --- Roles ------------------------------------------------------------------------------

CODE_LIST = r'(?:\s*(?:,\s*(?:and\s+|or\s+)?|/|\bor\b|\band\b|&)?\s*' + COURSE_PATTERN + r')+'
NEGATION_CUE = re.compile(r'\b(?:except(?:\s+for)?|excluding|other\s+than|not\s+including)\b(?:\s+the\s+following(?:\s+courses?)?\s*:?)?', re.I)
NOT_OPEN = re.compile(r'\bnot\s+open\s+to\b', re.I)
NO_LONGER = re.compile(r'(' + COURSE_PATTERN + r'(?:\s*(?:,|/|\bor\b|\band\b)\s*' + COURSE_PATTERN + r')*)\s+(?:will\s+)?no\s+longer\s+be\s+accepted', re.I)
NOT_SUBSTITUTE = re.compile(r'(' + COURSE_PATTERN + r')\s+(?:cannot|can\s+not|may\s+not)\s+be\s+(?:substituted|used)\b', re.I)
COREQ_NOTE = re.compile(r'\(\s*(?:which\s+)?(?:may|can)\s+be\s+taken\s+(?:as\s+a\s+co-?requisite|concurrently)\s*\)', re.I)
ADVISORY_FIELD = re.compile(r'^\s*(?:highly\s+|strongly\s+)?recommended\b', re.I)
ADVISORY_PAREN = re.compile(r'(' + COURSE_PATTERN + r')?\s*\(([^()]*\b(?:highly|strongly)\s+recommended\b[^()]*)\)', re.I)
ADVISORY_END = re.compile(r'\b(?:highly\s+|strongly\s+)?recommended\.?$', re.I)
# Only the field's lead sentence: "... can be taken independently" elsewhere may sit next to
# required courses ("CSC209H5 and CSC258H5. This course can be taken independently.").
NO_PREREQUISITE = re.compile(r'^\s*this\s+course\s+has\s+no\s+pre-?requisites?\b', re.I)
OR_BEFORE = re.compile(r'(?:\bor|/)\s*$', re.I)
CLAUSE_SEPARATOR = re.compile(r'\bor\b|\band\b|[,;/(\[{]', re.I)
WAIVER_CUE = re.compile(r'^(?:students?\s+who\s+(?:do|have|did)\s+not\b|enrolment\s+without\b)|\b(?:may\s+petition|may\s+be\s+granted|may\s+be\s+waived|do(?:es)?\s+not\s+require|must\s+obtain\s+permission)\b', re.I)
CONDITIONAL_CUE = re.compile(r'^(?:students?\s+(?:seeking|wishing|intending|planning|who|with|enrolled|admitted)\b|for\s+students\b|those\s+(?:who|seeking)\b|if\s+(?!enrolled\b))', re.I)
FOOTNOTE_MARK = re.compile(r'\s*\*(?=\s|$)')

COURSE_FIELDS = {'prerequisites', 'corequisites'}


@dataclass
class Analysis:
    """Roles of every code in one requirement text, plus the text left for the rule parser."""
    text: str
    rule_text: str
    field_name: str = 'prerequisites'
    tails: list = field(default_factory=list)
    required: list = field(default_factory=list)
    corequisite: list = field(default_factory=list)
    mentioned: list = field(default_factory=list)
    aliases: list = field(default_factory=list)
    demoted: set = field(default_factory=set)
    repairs: list = field(default_factory=list)
    alias_codes: list = field(default_factory=list)
    advisory: bool = False
    advisory_text: str = ''
    no_prerequisites: bool = False
    self_code: str | None = None
    # "(may be taken as a corequisite)": the annotated text, how the rest of the field joins it
    # ('' when nothing else is left, 'and', 'or'; None when the placement is not understood)
    # and that rest.
    coreq_texts: list = field(default_factory=list)
    coreq_join: str | None = None
    coreq_rest: str = ''


def _tidy_connectives(text):
    """Drop connectives left dangling after a clause was cut out ("A and  and B", "A and")."""
    text = clean(text)
    text = re.sub(r'\b(and|or)(?:\s+(?:and|or)\b)+', r'\1', text, flags=re.I)
    text = re.sub(r'^(?:(?:and|or)\b|[,;])\s*', '', text, flags=re.I)
    return re.sub(r'\s*(?:\b(?:and|or)|[,;])$', '', text, flags=re.I)


def _alias_target(text, start, self_code):
    """The code a "(formerly X)" note renames: the last code of the clause it closes.

    The clause runs back to the previous top-level separator, so a title between the code and
    the note does not hide it ("FAH248H5 : Canadian Painting 1665-1960 (formerly FAH286H1 )").
    A note that opens the text renames the course itself; a clause without a code names nothing.
    """
    before = text[:start]
    if not before.strip():
        return self_code
    codes = COURSE_RE.findall(CLAUSE_SEPARATOR.split(before)[-1])
    return codes[-1] if codes else None


def _depths(text):
    depth, depths = 0, []
    for char in text:
        if char in '([{':
            depth += 1
        depths.append(depth)
        if char in ')]}':
            depth = max(0, depth - 1)
    return depths


def _closing(text, start):
    depth = 0
    for i in range(start, len(text)):
        if text[i] in '([{':
            depth += 1
        elif text[i] in ')]}':
            depth -= 1
            if depth < 0:
                return i
    return len(text)


def _opening(text, end):
    """Index of the bracket that opens the group closed at ``end``."""
    depth = 0
    for i in range(end, -1, -1):
        if text[i] in ')]}':
            depth += 1
        elif text[i] in '([{':
            depth -= 1
            if depth == 0:
                return i
    return end


def _sentence_end(text, start):
    match = re.compile(r'[.;](?=\s|$)').search(text, start)
    return match.end() if match else len(text)


def negated_spans(text):
    spans = []
    depths = _depths(text)
    for cue in NEGATION_CUE.finditer(text):
        if depths[cue.start()] > 0:
            spans.append((cue.start(), _closing(text, cue.end())))
            continue
        codes = re.match(CODE_LIST, text[cue.end():])
        if codes:
            spans.append((cue.start(), cue.end() + codes.end()))
    for cue in NOT_OPEN.finditer(text):
        spans.append((cue.start(), _sentence_end(text, cue.end())))
    for match in NOT_SUBSTITUTE.finditer(text):
        spans.append(match.span(1))
    return spans


def advisory_tail(text):
    """'A and B highly recommended': (start, advisory text) for the last conjunct only.

    The advisory clause starts at the first ' and ' whose remainder carries no grade or
    percentage requirement ('Advanced Functions (minimum grade of 70) and Calculus ...
    highly recommended' keeps the graded course mandatory)."""
    if not ADVISORY_END.search(text):
        return None
    for match in re.finditer(r'\s+and\s+', text, re.I):
        rest = text[match.end():]
        if ';' in rest or re.search(r'\b(?:minimum|final)\s+grade\b|\bgrade\s+of\s+\d|%', rest, re.I):
            continue
        return match.start(), rest.rstrip(' .')
    return None


def split_tail(text):
    """Split off the first conditional / waiver / retirement-note sentence and everything after."""
    depths = _depths(text)
    boundaries = []
    for match in re.finditer(r'(?<=[.!?])\s+(?=[A-Z*(\[])|\s*\*\s*(?=[A-Z])', text):
        if depths[match.start()] == 0:
            boundaries.append(match)
    for boundary in boundaries:
        tail = text[boundary.end():].lstrip('* ')
        first = re.split(r'(?<=[.!?])\s+', tail, maxsplit=1)[0]
        has_code = bool(COURSE_RE.search(tail))
        if NO_LONGER.match(first):
            kind = 'retired'
        elif WAIVER_CUE.search(first):
            kind = 'waiver'
        elif CONDITIONAL_CUE.match(first) and has_code:
            kind = 'conditional'
        else:
            continue
        main = text[:boundary.start()]
        footnote = boundary[0].strip().startswith('*') or tail != text[boundary.end():]
        if footnote:
            main = FOOTNOTE_MARK.sub('', main)
        return clean(main), kind, clean(text[boundary.end():])
    return text, None, ''


def _in_spans(position, spans):
    return any(start <= position < end for start, end in spans)


def _past(sentence, ctx: CodeContext):
    years = [int(year) for year in re.findall(r'\b(20\d\d)\b', sentence)]
    return ctx.academic_year is None or not years or max(years) <= ctx.academic_year


def analyse(raw, ctx: CodeContext = NO_CONTEXT, field_name='prerequisites', self_code=None):
    text, repairs = normalise_codes(clean(raw), ctx)
    result = Analysis(text=text, rule_text=text, field_name=field_name, repairs=repairs, self_code=self_code)
    course_field = field_name in COURSE_FIELDS
    roles = {}

    def assign(code, role):
        order = ['required', 'corequisite', 'alias', 'mentioned']
        current = roles.get(code)
        if current is None or order.index(role) < order.index(current):
            roles[code] = role

    # Whole-field statements first: they make every code a mention.
    if course_field and NO_PREREQUISITE.search(text):
        result.no_prerequisites = True
        result.rule_text = ''
        for code in COURSE_RE.findall(text):
            assign(code, 'mentioned')
        return _finish(result, roles, ctx, self_code, field_name)
    if course_field and ADVISORY_FIELD.match(text):
        result.advisory = True
        result.advisory_text = text
        result.rule_text = ''
        for code in COURSE_RE.findall(text):
            assign(code, 'mentioned')
        return _finish(result, roles, ctx, self_code, field_name)

    rule_text = text
    if course_field:
        tail = advisory_tail(rule_text)
        if tail:
            start, result.advisory_text = tail
            for code in COURSE_RE.findall(result.advisory_text):
                assign(code, 'mentioned')
            rule_text = rule_text[:start]
        advisory_codes = []
        touched = []

        def advisory(match):
            # "X (strongly recommended ...)" makes X advisory, but only when the brackets name
            # no other code: in "CSC148H5 (CSC207H5 is highly recommended)" CSC148H5 stays
            # required, and an OR alternative ("A or B (highly recommended)") stays a choice.
            inner = COURSE_RE.findall(match[2])
            preceding = match[1]
            if not inner and not preceding:
                return match[0]
            touched.append(match[0])
            advisory_codes.extend(inner)
            if preceding and not [code for code in inner if code != self_code] \
                    and not OR_BEFORE.search(rule_text[:match.start()]):
                advisory_codes.append(preceding)
                return ' '
            return ' ' + (preceding or '') + ' '

        stripped = ADVISORY_PAREN.sub(advisory, rule_text)
        if touched:
            result.advisory_text = clean(result.advisory_text + ' ' + text)
            for code in advisory_codes:
                assign(code, 'mentioned')
            rule_text = _tidy_connectives(stripped)
            if not COURSE_RE.search(rule_text) and not re.search(r'[A-Za-z]', rule_text):
                result.advisory = True
                rule_text = ''
        main, kind, tail = split_tail(rule_text)
        if kind == 'retired':
            retired = NO_LONGER.match(tail.lstrip('* '))
            if _past(tail, ctx):
                result.demoted.update(COURSE_RE.findall(retired[1]))
                rule_text = main
            else:
                kind = None
        elif kind:
            result.tails.append((kind, tail))
            for code in COURSE_RE.findall(tail):
                assign(code, 'mentioned')
            rule_text = main

    exclusions = field_name == 'exclusions'
    for match in FORMERLY.finditer(rule_text):
        current = _alias_target(rule_text, match.start(), self_code)
        for old in COURSE_RE.findall(match[1]):
            # Exclusions keep the old code as a trigger (exclusion_rule reads the note).
            assign(old, 'required' if exclusions else 'alias')
            result.aliases.append({'formerly': old, 'current': current})
    if not exclusions:
        rule_text = clean(FORMERLY.sub('', rule_text))

    # Only a prerequisite or corequisite field can move codes to the corequisite field; elsewhere
    # (EDS388H5's recommended preparation) the annotated code stays an ordinary reference.
    coreq_spans = []
    for match in COREQ_NOTE.finditer(rule_text if course_field else ''):
        end = match.start() - 1
        while end >= 0 and rule_text[end] == ' ':
            end -= 1
        if end >= 0 and rule_text[end] in ')]}':
            coreq_spans.append((_opening(rule_text, end), end + 1))
        else:
            previous = list(COURSE_RE.finditer(rule_text[:end + 1]))
            if previous:
                coreq_spans.append(previous[-1].span())
    if coreq_spans:
        _split_corequisite_note(result, rule_text, coreq_spans)
    negated = negated_spans(rule_text)
    for match in COURSE_RE.finditer(rule_text):
        if _in_spans(match.start(), negated):
            assign(match[0], 'mentioned')
        elif _in_spans(match.start(), coreq_spans):
            assign(match[0], 'corequisite')
        else:
            assign(match[0], 'required')
    for match in NO_LONGER.finditer(rule_text):
        sentence = rule_text[match.start():_sentence_end(rule_text, match.end())]
        if _past(sentence, ctx):
            result.demoted.update(COURSE_RE.findall(match[1]))
    # What is left beside a corequisite note is this field's own rule; an OR across the two
    # fields cannot be expressed, so that case keeps the whole text (see corequisite_rule).
    result.rule_text = result.coreq_rest if result.coreq_texts and result.coreq_join in ('', 'and') else rule_text
    return _finish(result, roles, ctx, self_code, field_name)


def _split_corequisite_note(result: Analysis, rule_text, spans):
    """Record the "(may be taken as a corequisite)" text and how the rest of the field joins it."""
    result.coreq_texts = [rule_text[start:end] for start, end in spans]
    cuts = sorted(list(spans) + [match.span() for match in COREQ_NOTE.finditer(rule_text)], reverse=True)
    rest = rule_text
    for start, end in cuts:
        rest = rest[:start] + ' ' + rest[end:]
    rest = clean(rest).strip(' .;')
    lead = re.match(r'^(and|or)\b\s*', rest, re.I)
    trail = re.search(r'\s*\b(and|or)$', rest, re.I)
    if not rest:
        result.coreq_join, result.coreq_rest = '', ''
    elif len(spans) == 1 and bool(lead) != bool(trail):
        joiner = lead or trail
        result.coreq_join = joiner[1].lower()
        result.coreq_rest = clean(rest[lead.end():] if lead else rest[:trail.start()])
    else:
        result.coreq_join, result.coreq_rest = None, rest


COREQ_OR_REASON = ('One alternative may be taken as a corequisite and is listed under corequisites; '
                   'the alternatives span both fields, so manual confirmation is required')
COREQ_REST_REASON = ('Alternative to these corequisites stated in the prerequisite field; it is not a corequisite '
                     'and needs manual confirmation')
COREQ_PLACEMENT_REASON = 'Corequisite note in a position the parser cannot scope; manual confirmation required'


def corequisite_rule(analysis: Analysis, ctx: CodeContext):
    """Corequisite-field rule for codes the prerequisite text allows to be taken concurrently.

    "( PHL101H5 or ... ) (may be taken as a corequisite) or 4.0 credits": the courses are
    corequisite references (taken before or together), and the rest of the prerequisite stays
    visible as an alternative instead of the field claiming nothing is required.
    """
    resolved, unresolved = partition(analysis.corequisite, ctx)
    if analysis.coreq_join is None:
        return unknown(analysis.text, COREQ_PLACEMENT_REASON)
    rule = combine('all', [parse_rule(text) for text in analysis.coreq_texts])
    rule = strip_unresolved(rule, unresolved, analysis.text)
    if analysis.coreq_join == 'or' and analysis.coreq_rest:
        items = rule['items'] if rule['kind'] == 'any' else [rule]
        rule = combine('any', items + [unknown(analysis.coreq_rest, COREQ_REST_REASON)])
    return guard(rule, resolved, analysis.text)


def _finish(result: Analysis, roles, ctx: CodeContext, self_code, field_name):
    for code in result.demoted:
        roles[code] = 'mentioned'
    if self_code:
        roles.pop(self_code, None)
    ordered = sorted(roles)
    result.required = [code for code in ordered if roles[code] == 'required']
    result.corequisite = [code for code in ordered if roles[code] == 'corequisite']
    result.mentioned = [code for code in ordered if roles[code] == 'mentioned']
    result.alias_codes = [code for code in ordered if roles[code] == 'alias']
    if field_name != 'exclusions':
        # Exclusions routinely cite the retired other-weight version on purpose.
        result.repairs += mismatch_warnings(result.required + result.corequisite + result.alias_codes, ctx)
    return result


def partition(codes, ctx: CodeContext):
    """(resolved ids, unresolved same-campus ids) for codes in a requirement role."""
    ids = sorted({course_id(code) for code in codes})
    return [i for i in ids if ctx.resolves(i)], [i for i in ids if not ctx.resolves(i)]


def prune_any(rule, demoted_ids):
    """Remove ruled-out alternatives from OR nodes; other placements are left for the guard."""
    if rule['kind'] == 'any':
        items = [prune_any(item, demoted_ids) for item in rule['items']
                 if not (item['kind'] in ('course', 'minGrade') and item['courseId'] in demoted_ids)]
        return combine('any', items) if items else unknown('', 'Every alternative was ruled out by the official text')
    if rule['kind'] == 'all':
        return {'kind': 'all', 'items': [prune_any(item, demoted_ids) for item in rule['items']]}
    if rule['kind'] == 'applicability':
        return {**rule, 'rule': prune_any(rule['rule'], demoted_ids)}
    return rule


def _without_ids(rule, ids):
    """The rule with every leaf on ``ids`` removed (from OR and AND alike); None if nothing is left."""
    kind = rule['kind']
    if kind in ('course', 'minGrade'):
        return None if rule['courseId'] in ids else rule
    if kind == 'credits' and rule.get('courseIds'):
        kept = [i for i in rule['courseIds'] if i not in ids]
        return {**rule, 'courseIds': kept} if kept else None
    if kind in ('any', 'all'):
        items = [item for item in (_without_ids(item, ids) for item in rule['items']) if item is not None]
        return combine(kind, items) if items else None
    if kind == 'applicability':
        inner = _without_ids(rule['rule'], ids)
        return None if inner is None else {**rule, 'rule': inner}
    return rule


def prune_self(rule, self_id):
    """A course never requires itself: its own code is removed wherever it sits in the rule.

    "CSC209H5 or CSC369H5" in CSC369H5's field leaves CSC209H5 instead of a mixed-roles unknown.
    """
    if self_id not in rule_course_ids(rule):
        return rule
    return _without_ids(rule, {self_id}) or {'kind': 'true'}


UNRESOLVED_REASON = ('Cites a course code that is not in the current calendar (retired or misprinted); '
                     'manual confirmation required')


def _retired_only(rule, ids):
    """True when the rule consists of nothing but codes absent from the calendar."""
    kind = rule['kind']
    if kind in ('course', 'minGrade'):
        return rule['courseId'] in ids
    if kind == 'credits':
        return bool(rule.get('courseIds')) and set(rule['courseIds']) <= ids
    if kind in ('any', 'all'):
        return all(_retired_only(item, ids) for item in rule['items'])
    if kind == 'applicability':
        return _retired_only(rule['rule'], ids)
    return False


def _retired_leaf(rule, ids, text):
    cited = ' / '.join(sorted(i.split(':', 1)[1] for i in rule_course_ids(rule) & ids))
    return unknown(cited or text, UNRESOLVED_REASON)


def _keep_branches(rule, ids, text):
    """OR alternatives made only of absent codes are dropped; any other absent code becomes an
    ``unknown`` leaf in place, so an AND branch of an OR keeps its current courses."""
    if not rule_course_ids(rule) & ids:
        return rule
    if _retired_only(rule, ids):
        return _retired_leaf(rule, ids, text)
    kind = rule['kind']
    if kind == 'credits':
        return {**rule, 'courseIds': [i for i in rule['courseIds'] if i not in ids]}
    if kind == 'any':
        return combine('any', [_keep_branches(item, ids, text) for item in rule['items'] if not _retired_only(item, ids)])
    if kind == 'all':
        return {'kind': 'all', 'items': [_keep_branches(item, ids, text) for item in rule['items']]}
    if kind == 'applicability':
        return {**rule, 'rule': _keep_branches(rule['rule'], ids, text)}
    return rule


STRIP_MODES = ('require', 'trigger', 'drop')


def strip_unresolved(rule, ids, text='', mode='require'):
    """Codes absent from the calendar never stay in the AST; ``unresolvedIds`` keeps them.

    - ``require`` (prerequisites, corequisites, program groups): an OR alternative that only such
      codes satisfy is dropped; any other one becomes an ``unknown`` leaf where it stands, so
      "(A or B) and RETIRED and C" inside an OR keeps its branch with A, C and the unknown leaf.
    - ``trigger`` (exclusions): the same, except that nothing but absent codes leaves no trigger
      (``true``). An absent half of an "A and B" pair stays an unknown leaf, so the current half
      alone never blocks for certain; the engine reports a record match as "may exclude".
    - ``drop`` (recommendations): only the absent atoms are removed; the rest of an AND stays.
    """
    ids = set(ids)
    if not ids or not rule_course_ids(rule) & ids:
        return rule
    if mode not in STRIP_MODES:
        raise ValueError(f'Unknown strip mode {mode!r}')
    if mode == 'drop':
        return _without_ids(rule, ids) or {'kind': 'true'}
    if mode == 'trigger' and _retired_only(rule, ids):
        return {'kind': 'true'}
    return _keep_branches(rule, ids, text)


def combine_tails(rule, tails):
    """Waivers relax the main rule (any); conditional clauses restrict it (all)."""
    for kind, tail in tails:
        clause = unknown(tail, 'Waiver or alternative route that needs permission or review' if kind == 'waiver'
                         else 'Conditional clause that applies only to some students; manual confirmation required')
        joined = 'any' if kind == 'waiver' else 'all'
        items = rule['items'] if rule['kind'] == joined else [rule]
        rule = combine(joined, [item for item in items + [clause] if item['kind'] != 'true'])
    return rule


def guard(rule, allowed_ids, text):
    """The AST may only reference required codes; anything else means the roles are mixed."""
    if rule_course_ids(rule) <= set(allowed_ids):
        return rule
    return unknown(text, 'Course references in this requirement have mixed roles (excluded, advisory or conditional); manual confirmation required')
