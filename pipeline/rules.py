"""Requirement expression grammar: official text -> Rule AST (src/domain/types.ts `Rule`).

An extracted course reference is not a mandatory requirement. The parser only emits executable
rules for grammar it understands completely; prose stays ``unknown`` with its official text.
"""
from __future__ import annotations

import re

from .campuses import CAMPUS_DIGITS

# Campus digit 0 is UTSG off-campus (ACT398H0). Lookarounds instead of word boundaries also find
# codes glued to a lower-case word ("inCSC148H5"), never a fragment of a longer token.
COURSE_PATTERN = r'[A-Z]{3}(?:\d{3}|[A-Z]\d{2})[HY][0135]'
COURSE_RE = re.compile(r'(?<![A-Z0-9])' + COURSE_PATTERN + r'(?![0-9A-Z])')


def clean(text):
    return re.sub(r'\s+', ' ', text.replace('​', '').replace('\xa0', ' ')).strip()


def course_id(code):
    return CAMPUS_DIGITS.get(code[-1], 'external') + ':' + code


def refs(text):
    return sorted({course_id(code) for code in COURSE_RE.findall(text)})


def unknown(text, reason='Unrecognized or context-dependent official wording; manual confirmation required'):
    return {'kind': 'unknown', 'text': text, 'reason': reason}


def combine(kind, items):
    if not items:
        return {'kind': 'true'}
    if len(items) == 1:
        return items[0]
    return {'kind': kind, 'items': items}


def walk(rule):
    yield rule
    for item in rule.get('items', []):
        yield from walk(item)
    if 'rule' in rule:
        yield from walk(rule['rule'])


def rule_course_ids(rule):
    ids = set()
    for node in walk(rule):
        if node['kind'] in ('course', 'minGrade'):
            ids.add(node['courseId'])
        elif node['kind'] == 'credits':
            ids.update(node.get('courseIds', []))
    return ids


def balanced_outer(text):
    if not text.startswith('(') or not text.endswith(')'):
        return False
    level = 0
    for i, char in enumerate(text):
        level += (char == '(') - (char == ')')
        if level == 0 and i != len(text) - 1:
            return False
    return level == 0


def split_top(text, pattern):
    depth = 0
    starts = {match.start(): match for match in re.finditer(pattern, text, re.I)}
    parts = []
    last = 0
    i = 0
    while i < len(text):
        if text[i] == '(':
            depth += 1
        elif text[i] == ')':
            depth -= 1
        if depth == 0 and i in starts:
            match = starts[i]
            parts.append(text[last:i].strip())
            last = match.end()
            i = match.end()
        else:
            i += 1
    if not parts:
        return [text]
    parts.append(text[last:].strip())
    return parts


def parse_rule(raw):
    """Parse explicit AND/OR, course-specific grades, credit sets and permissions.

    Slash binds within comma/semicolon AND groups. Verbal OR combines complete
    AND alternatives. Brackets preserve boundaries. Unknown prose is never erased.
    """
    text = clean(raw).strip(' .;')
    if not text or text.lower() in {'none', 'n/a', 'no prerequisites', 'no prerequisite'}:
        return {'kind': 'true'}
    text = text.replace('[', '(').replace(']', ')').replace('{', '(').replace('}', ')')
    if re.search(r'\bgrade\b', text, re.I) and len(split_top(text, r'\s+or\s+|\s*/\s*')) > 1:
        # A grade qualifier before/after a choice may apply to every alternative.
        # Only per-course parenthetical percentage annotations are unambiguous.
        without_annotations = re.sub(r'\([^()]*(?:grade|%)\s*[^()]*\)', '', text, flags=re.I)
        if re.search(r'\bgrade\b', without_annotations, re.I):
            return unknown(raw, 'Grade scope over alternatives needs manual confirmation')
    # Convert grade annotations into a single atomic token before group parsing.
    text = re.sub(r'(?:a\s+)?(?:minimum|final)\s+grade\s+of\s+(?:at\s+least\s+)?(\d+(?:\.\d+)?)\s*%?\s+in\s+(' + COURSE_PATTERN + ')',
                  lambda m: m[2] + '@' + m[1], text, flags=re.I)
    text = re.sub(r'(' + COURSE_PATTERN + r')\s*\(\s*(?:(?:a\s+)?(?:minimum|final)\s+grade\s+of\s+)?(?:at\s+least\s+)?(\d+(?:\.\d+)?)\s*%\s*\)',
                  lambda m: m[1] + '@' + m[2], text, flags=re.I)
    # "60% or higher in CSC148H5" names one course; a following alternative would share the scope.
    text = re.sub(r'(\d+(?:\.\d+)?)\s*%\s+or\s+(?:higher|better|above)\s+in\s+(' + COURSE_PATTERN + r')(?!\s*(?:or|and|/|,)\s*[A-Z]{3}\d)',
                  lambda m: m[2] + '@' + m[1], text, flags=re.I)
    while balanced_outer(text):
        text = text[1:-1].strip()
    if text.count('(') != text.count(')'):
        return unknown(raw, 'Unbalanced official expression')
    # Numeric course-set requirement is interpreted before separators in its set.
    credits = re.fullmatch(r'(?:select\s+|at least\s+|a minimum of\s+|additional\s+)?(\d+(?:\.\d+)?)\s+credits?\s+(?:from|in)\s+(?:the following(?: courses)?\s*:?\s*)?(.+)', text, re.I)
    if credits:
        minimum, scope = float(credits[1]), credits[2]
        reduced = COURSE_RE.sub('', scope)
        reduced = re.sub(r'\b(?:and|or)\b|[\s,;/()&+.]', '', reduced, flags=re.I)
        # A credit pool is flat. Grouped alternatives cannot be flattened: A+C
        # must not satisfy "(A and B) or (C and D)".
        flat = not any(mark in scope for mark in '()[]{}') and not re.search(r'\band\b|[&+;]', scope, re.I)
        if flat and not reduced and refs(scope):
            return {'kind': 'credits', 'minimum': minimum, 'courseIds': refs(scope)}
        subject_level = re.fullmatch(r'([A-Z]{3})\s+(?:at\s+)?(?:the\s+)?(\d)00(?:\s*(?:/|and|or)\s*400)?[- ]level(?:\s+(?:or above|or higher))?', scope)
        if subject_level and (int(subject_level[2]) == 4 or 'above' in scope or 'higher' in scope or '400' in scope):
            return {'kind': 'credits', 'minimum': minimum, 'subject': subject_level[1], 'level': int(subject_level[2]) * 100}
        return unknown(raw, 'Credit-set grouping, allocation or level restrictions need manual confirmation')
    total = re.fullmatch(r'(?:completion of\s+|completed\s+)?(?:at least\s+|a minimum of\s+)?(\d+(?:\.\d+)?)\s+(?:total\s+)?credits?', text, re.I)
    if total:
        return {'kind': 'credits', 'minimum': float(total[1])}
    # A credit qualifier can govern a following OR list ("8.0 credits including
    # A or B"). Never let a later course branch bypass the credit condition.
    if re.search(r'\bcredits?\b', text, re.I):
        return unknown(raw, 'Credit total and included-course scope require contextual confirmation')
    # A bare one-of list is OR, including official comma-separated lists.
    one_of = re.match(r'^(?:one of|either|any one of)(?: the following)?\s*:?\s*(.+)$', text, re.I)
    if one_of:
        body = one_of[1]
        if len(split_top(body, r'\s+and\s+|\s*[&+]\s*')) > 1:
            return unknown(raw, 'Scope of one-of list and additional AND condition is ambiguous')
        residual = COURSE_RE.sub('', body)
        residual = re.sub(r'\b(?:and|or)\b|[\s,;/()&+.]', '', residual, flags=re.I)
        if residual:
            return unknown(raw, 'One-of list contains modifiers that require contextual confirmation')
        items = split_top(body, r'\s+or\s+|\s*/\s*|\s*,\s*|\s*;\s*')
        return combine('any', [parse_rule(part) for part in items if part])
    # Oxford lists only when the entire expression is a simple course list.
    if ', or ' in text.lower():
        reduced = COURSE_RE.sub('', text)
        reduced = re.sub(r'\b(?:or)\b|[\s,()]', '', reduced, flags=re.I)
        if not reduced:
            return combine('any', [parse_rule(p) for p in re.split(r',\s*(?:or\s+)?|\s+or\s+', text, flags=re.I) if p])
    for pattern, kind in [(r'\s*;\s*(?:and\s+)?|\s*,\s*(?:and\s+)?', 'all'),
                          (r'\s+or\s+', 'any'), (r'\s+and\s+|\s*[&+]\s*', 'all'),
                          (r'\s*/\s*', 'any')]:
        pieces = split_top(text, pattern)
        if len(pieces) > 1:
            # Trailing "and/or" is a list continuation, not a false empty condition.
            if any(not p for p in pieces):
                return unknown(raw, 'Incomplete or ambiguous conjunction')
            children = [parse_rule(part) for part in pieces]
            if kind == 'any' and any(node['kind'] == 'unknown' for child in children for node in walk(child)):
                return unknown(raw, 'OR expression contains unparsed qualifiers; their scope cannot be safely discarded')
            return combine(kind, children)
    atom = re.fullmatch('(' + COURSE_PATTERN + r')(?:@(\d+(?:\.\d+)?))?', text)
    if atom:
        return ({'kind': 'minGrade', 'courseId': course_id(atom[1]), 'minimum': float(atom[2])}
                if atom[2] else {'kind': 'course', 'courseId': course_id(atom[1])})
    if re.fullmatch(r'(?:written\s+)?(?:permission|approval|consent)\s+of\s+(?:the\s+)?(?:instructor|department|program director|supervisor|chair)[\w\s.-]*', text, re.I):
        return {'kind': 'permission', 'text': raw}
    return unknown(raw)


def exclusion_rule(text):
    """A plain list names independent exclusion triggers, not all-at-once prerequisites."""
    if not text:
        return {'kind': 'true'}
    residual = COURSE_RE.sub('', text)
    residual = re.sub(r'\b(?:or|and)\b|[\s,;/&+.]', '', residual, flags=re.I)
    if not residual and refs(text):
        if re.search(r'\band\b|[&+]', text, re.I) and re.search(r'\bor\b|/', text, re.I):
            # "A or B and C or D": here "and" pairs courses, so a flat any-list would be wrong.
            if not re.search(r'[,;/]', text):
                rule = parse_rule(text)
                if not any(node['kind'] == 'unknown' for node in walk(rule)):
                    return rule
            return unknown(text, 'Exclusion joins courses with both "and" and "or"; the pairing needs manual confirmation')
        return combine('any', [{'kind': 'course', 'courseId': reference} for reference in refs(text)])
    # Parenthetical exceptions, transfer policies and combined-course exclusions
    # cannot safely use prerequisite expression semantics.
    return unknown(text, 'Context-dependent exclusion; confirm official credit restrictions')
