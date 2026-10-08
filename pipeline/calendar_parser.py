"""Conservative Calendar requirement parser and auditable single-snapshot builder.

An extracted course reference is not a mandatory requirement. The parser only
emits executable rules for grammar it understands completely; prose stays unknown.
"""
from __future__ import annotations

from collections import Counter, defaultdict
import json
from pathlib import Path
import re

from bs4 import BeautifulSoup, Tag

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache' / 'calendar'
OUT = ROOT / 'data' / 'utm'
PARSER_VERSION = '1.0.1'
COURSE_PATTERN = r'[A-Z]{3}(?:\d{3}|[A-Z]\d{2})[HY][135]'
COURSE_RE = re.compile(r'\b' + COURSE_PATTERN + r'\b')


def clean(text):
    return re.sub(r'\s+', ' ', text.replace('\u200b', '').replace('\xa0', ' ')).strip()


def course_id(code):
    return {'5': 'UTM', '1': 'UTSG', '3': 'UTSC'}.get(code[-1], 'external') + ':' + code


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


def requirement(text, url, rule=None):
    return {'rawText': text, 'sourceUrl': url, 'rule': parse_rule(text) if rule is None else rule, 'courseIds': refs(text)}


def exclusion_rule(text):
    """A plain list names independent exclusion triggers, not all-at-once prerequisites."""
    if not text:
        return {'kind': 'true'}
    residual = COURSE_RE.sub('', text)
    residual = re.sub(r'\b(?:or|and)\b|[\s,;/&+.]', '', residual, flags=re.I)
    if not residual and refs(text):
        return combine('any', [{'kind': 'course', 'courseId': reference} for reference in refs(text)])
    # Parenthetical exceptions, transfer policies and combined-course exclusions
    # cannot safely use prerequisite expression semantics.
    return unknown(text, 'Context-dependent exclusion; confirm official credit restrictions')


def field(soup, name):
    return soup.select_one('.node__content .field--name-field-' + name + ' .field__item')


def text_field(soup, name):
    el = field(soup, name)
    return clean(el.get_text(' ', strip=True)) if el else ''


def source(entry, manifest):
    from collect_calendar import read_verified_source
    reference = next(item for item in manifest['details'] if item['url'] == entry['url'] and item.get('status') == 'ok')
    return read_verified_source(reference, manifest['generationId'], CACHE)


def parse_course(entry, source_data):
    soup = BeautifulSoup(source_data['html'], 'html.parser')
    title_node = soup.select_one('h1.page-title')
    heading = clean(title_node.get_text(' ', strip=True)) if title_node else ''
    code = entry['code']
    if not heading.startswith(code) or not soup.select_one('article.node--type-courses'):
        raise ValueError('Detail identity mismatch: ' + entry['url'])
    url = source_data['finalUrl']
    pre = text_field(soup, 'prerequisite')
    core = text_field(soup, 'corequisite')
    recommended = text_field(soup, 'recommended-preparation')
    notes = text_field(soup, 'note')
    # CHM and other explicitly recommended co-requisites are advisory, even when
    # Drupal places them in the corequisite field. Preserve complete source text.
    if re.match(r'^recommended\s+co-?requisite', core, re.I):
        recommended = clean(recommended + ' ' + core)
        core_req = requirement(core, url, {'kind': 'true'})
        core_req['courseIds'] = []
    else:
        core_req = requirement(core, url)
    # A recommendation sentence mixed into prerequisites is kept verbatim in
    # prerequisite provenance but removed from the mandatory expression.
    mandatory_pre = pre
    advisory = re.search(r'\s+and\s+([^;]+?\b(?:highly\s+)?recommended)\.?$', pre, re.I)
    if advisory:
        recommended = clean(recommended + ' ' + advisory[1])
        mandatory_pre = pre[:advisory.start()]
    prereq = requirement(pre, url, parse_rule(mandatory_pre))
    if advisory:
        prereq['courseIds'] = refs(mandatory_pre)
    return {'id': course_id(code), 'campus': 'UTM', 'code': code,
            'title': heading[len(code):].lstrip(' •·-'), 'subject': code[:3], 'level': int(code[3]) * 100,
            'credits': .5 if code[-2] == 'H' else 1, 'description': text_field(soup, 'desc'),
            'sourceUrl': url, 'contentHash': source_data['contentHash'], 'fetchedAt': source_data['fetchedAt'],
            'prerequisites': prereq, 'corequisites': core_req,
            'exclusions': requirement(text_field(soup, 'exclusion'), url, exclusion_rule(text_field(soup, 'exclusion'))),
            'recommended': requirement(recommended, url),
            'restrictions': requirement(text_field(soup, 'enrolment-limits'), url),
            'notes': notes, 'distribution': text_field(soup, 'distribution-requirements')}


def program_groups(item, url, code, category):
    if item is None:
        return []
    groups = []
    heading = category.title()
    cohort = ''
    pending = ''
    conditional = ''
    def add(text, label, scoped=cohort):
        text = clean(text)
        if not text:
            return
        # A leading decimal is a credit amount, not an outline marker: removing
        # "1." from "1.0 credit" would silently turn the minimum into zero.
        rule = parse_rule(re.sub(r'^\d+(?:\.(?!\d)|\))\s*', '', text))
        context = conditional
        if category == 'admission':
            context = context or 'Admission clauses depend on the complete program admission policy and route.'
        if re.search(r'\b(?:group\s+[A-Z0-9]|list\s+[A-Z0-9]|cluster\s+[A-Z0-9]|electives?|option|stream)\b', label, re.I):
            context = context or label
        if context:
            rule = combine('all', [unknown(context, 'Parent requirement context, route or elective allocation must be confirmed'), rule])
            text = clean(context + ' ' + text)
        if scoped:
            rule = {'kind': 'applicability', 'cohort': scoped, 'rule': rule}
        group = requirement(text, url, rule)
        group.update({'id': f'UTM:{code}:{category}:{len(groups) + 1}', 'label': label[:180], 'category': category})
        groups.append(group)
    for child in item.children:
        if not isinstance(child, Tag):
            continue
        text = clean(child.get_text(' ', strip=True))
        if not text:
            continue
        if child.name in {'ol', 'ul'}:
            if pending:
                add(pending + ' ' + text, heading, cohort)
                pending = ''
            else:
                for number, li in enumerate(child.find_all('li', recursive=False), 1):
                    add(li.get_text(' ', strip=True), f'{heading} · {number}', cohort)
            continue
        if re.search(r'\b(?:UTMCIP|co-?op|stream|option|focus)\b', text, re.I):
            conditional = text
        if re.search(r'(?:for students|students who|students entering|admitted|entry|entering).*(?:20\d\d|CMP1)', text, re.I):
            cohort = text
            heading = text
            add(text, heading, cohort)
            continue
        if re.search(r'all students have the same', text, re.I):
            cohort = ''
            conditional = ''
            heading = text
            continue
        if not refs(text) and re.search(r'(?:credits?.*(?:from|following|list)|one of the following|program electives)', text, re.I):
            heading = text
            pending = text
            continue
        if (len(text) < 180 and not refs(text) and (text.endswith(':') or child.name in {'h3', 'h4', 'h5'})):
            heading = text
            if re.search(r'credits?.*(?:from|following|list)|one of the following', text, re.I):
                pending = text
            elif re.search(r'\d.*credits?', text, re.I):
                add(text, heading, cohort)
            continue
        add(text, heading, cohort)
    if pending:
        add(pending, heading, cohort)
    return groups


def parse_program(entry, source_data):
    soup = BeautifulSoup(source_data['html'], 'html.parser')
    heading = clean(soup.select_one('h1.page-title').get_text(' ', strip=True))
    if not soup.select_one('article.node'):
        raise ValueError('Program detail content missing: ' + entry['url'])
    code, url = entry['code'], source_data['finalUrl']
    official_code = text_field(soup, 'post-code')
    if official_code and re.fullmatch(r'ER[A-Z]+\d+', code) and code not in official_code.upper():
        raise ValueError('Program identity mismatch: ' + entry['url'])
    type_match = re.search(r'\b(Specialist|Major|Minor|Certificate|Focus)\b', heading, re.I)
    program_type = type_match[1].title() if type_match else 'Other'
    admission = text_field(soup, 'enrolment-requirements')
    completion = text_field(soup, 'completion-req')
    groups = program_groups(field(soup, 'enrolment-requirements'), url, code, 'admission')
    groups += program_groups(field(soup, 'completion-req'), url, code, 'completion')
    def whole(text, category):
        # Full programs include overlap, subclauses, annual cutoffs and alternate
        # paths. Leaf groups support explainable recommendations, not certification.
        return requirement(text, url, unknown(text, f'Full program {category} requires official contextual and allocation review')
                           if text else unknown('', f'Official {category} field absent; not assumed to have no requirements'))
    return {'id': 'UTM:' + code, 'campus': 'UTM', 'code': official_code or code, 'title': heading,
            'type': program_type, 'description': text_field(soup, 'description'), 'sourceUrl': url,
            'contentHash': source_data['contentHash'], 'fetchedAt': source_data['fetchedAt'],
            'admission': whole(admission, 'admission'), 'completion': whole(completion, 'completion'),
            'groups': groups, 'notes': text_field(soup, 'program-note')}


def walk(rule):
    yield rule
    for item in rule.get('items', []):
        yield from walk(item)
    if 'rule' in rule:
        yield from walk(rule['rule'])


def cycles(courses):
    """Tarjan SCC on reference projection, not a claim that OR routes are cyclic."""
    graph = {c['id']: c['prerequisites']['courseIds'] for c in courses}
    serial, stack, on_stack, index, low, found = 0, [], set(), {}, {}, []
    def visit(node):
        nonlocal serial
        index[node] = low[node] = serial
        serial += 1
        stack.append(node)
        on_stack.add(node)
        for neighbor in graph[node]:
            if neighbor not in graph:
                continue
            if neighbor not in index:
                visit(neighbor)
                low[node] = min(low[node], low[neighbor])
            elif neighbor in on_stack:
                low[node] = min(low[node], index[neighbor])
        if index[node] == low[node]:
            group = []
            while True:
                neighbor = stack.pop()
                on_stack.remove(neighbor)
                group.append(neighbor)
                if neighbor == node:
                    break
            if len(group) > 1 or node in graph[node]:
                found.append(sorted(group))
    for node in graph:
        if node not in index:
            visit(node)
    return sorted(found)


def quality(catalog, manifest, parse_failures):
    ids = {c['id'] for c in catalog['courses']}
    ast = Counter()
    missing = defaultdict(set)
    unknowns = []
    field_summary = defaultdict(Counter)
    requirements = []
    for course in catalog['courses']:
        for key in ['prerequisites', 'corequisites', 'exclusions', 'recommended', 'restrictions']:
            requirements.append((course['id'], key, course[key]))
    for program in catalog['programs']:
        for key in ['admission', 'completion']:
            requirements.append((program['id'], key, program[key]))
        requirements.extend((program['id'], group['id'], group) for group in program['groups'])
    for entity_id, name, requirement_value in requirements:
        nodes = list(walk(requirement_value['rule']))
        ast.update(node['kind'] for node in nodes)
        is_unknown = any(node['kind'] in {'unknown', 'applicability'} for node in nodes)
        summary = field_summary[name if ':' not in name else 'programGroups']
        summary['unknown' if is_unknown else 'parsed'] += 1
        summary['nonempty' if requirement_value['rawText'] else 'absentOrEmpty'] += 1
        if requirement_value['rawText'] and not is_unknown:
            summary['nonemptyParsed'] += 1
        if is_unknown:
            unknowns.append({'entityId': entity_id, 'field': name, 'sourceUrl': requirement_value['sourceUrl'],
                             'text': requirement_value['rawText'][:300],
                             'reasons': sorted({node.get('reason', 'Cohort applicability requires confirmation') for node in nodes if node['kind'] in {'unknown', 'applicability'}})})
        for referenced in requirement_value['courseIds']:
            if referenced not in ids:
                missing[referenced].add(entity_id)
    report = {'academicYear': catalog['metadata']['academicYear'], 'generatedAt': manifest.get('finishedAt', manifest['startedAt']),
              'parserVersion': PARSER_VERSION, 'complete': catalog['metadata']['complete'],
              'coverage': {}, 'failures': manifest.get('failures', []) + parse_failures,
              'astCounts': dict(ast), 'ruleCoverage': dict(field_summary), 'unknownRules': unknowns,
              'unresolvedReferences': [{'courseId': key, 'status': 'external' if not key.startswith('UTM:') else 'unresolved',
                                        'referencedBy': sorted(values)} for key, values in sorted(missing.items())],
              'cycles': cycles(catalog['courses']),
              'cycleMeaning': 'Strongly connected components of all prerequisite references, including OR alternatives and unknown clauses; not guaranteed impossible study paths.',
              'manualCorrections': [], 'programTypes': dict(Counter(p['type'] for p in catalog['programs'])),
              'missingFields': {'courseDescriptions': [c['id'] for c in catalog['courses'] if not c['description']],
                                'programAdmission': [p['id'] for p in catalog['programs'] if not p['admission']['rawText']],
                                'programCompletion': [p['id'] for p in catalog['programs'] if not p['completion']['rawText']]}}
    for kind, plural in [('course', 'courses'), ('program', 'programs')]:
        directory = manifest['directories'][kind]
        report['coverage'][plural] = {'discovered': len(directory['entities']), 'collected': len(catalog[plural]),
                                     'pages': len(directory['pages']), 'duplicates': directory['duplicates'],
                                     'pageNumbers': [p['page'] for p in directory['pages']]}
    return report


def build_catalog(manifest, allow_decrease=False, accept=False):
    from collect_calendar import validate_manifest_cache, write_json
    validate_manifest_cache(manifest, CACHE)
    catalog = {'schemaVersion': 1, 'metadata': {'campus': 'UTM', 'academicYear': manifest['academicYear'],
                'academicYearSource': manifest['academicYearEvidence']['url'],
                'fetchedAt': manifest.get('finishedAt', manifest['startedAt']), 'parserVersion': PARSER_VERSION,
                'sources': ['https://utm.calendar.utoronto.ca/course-search', 'https://utm.calendar.utoronto.ca/program-search'],
                'complete': manifest.get('complete', False)}, 'courses': [], 'programs': []}
    failures = []
    for kind, plural, parse in [('course', 'courses', parse_course), ('program', 'programs', parse_program)]:
        for entry in manifest['directories'][kind]['entities']:
            try:
                catalog[plural].append(parse(entry, source(entry, manifest)))
            except Exception as exc:
                failures.append({'kind': kind, 'code': entry['code'], 'url': entry['url'], 'error': str(exc)})
    catalog['metadata']['complete'] = catalog['metadata']['complete'] and not failures
    report = quality(catalog, manifest, failures)
    prior_path = OUT / 'catalog.json'
    diff = {'previousSnapshot': prior_path.exists(), 'courses': {}, 'programs': {}}
    if prior_path.exists():
        old = json.loads(prior_path.read_text(encoding='utf-8'))
        for plural in ['courses', 'programs']:
            before = {x['id']: x for x in old[plural]}
            after = {x['id']: x for x in catalog[plural]}
            rule_fields = ['prerequisites', 'corequisites', 'exclusions', 'recommended', 'restrictions'] if plural == 'courses' else ['admission', 'completion']
            diff[plural] = {'added': sorted(after.keys() - before.keys()), 'removed': sorted(before.keys() - after.keys()),
                            'changedSource': sorted(k for k in before.keys() & after.keys() if before[k]['contentHash'] != after[k]['contentHash']),
                            'changedRequirements': sorted(k for k in before.keys() & after.keys()
                                                          if any(before[k][field]['rawText'] != after[k][field]['rawText'] for field in rule_fields)),
                            'before': len(before), 'after': len(after)}
            if len(after) < .9 * len(before) and not allow_decrease:
                report['failures'].append({'error': f'{plural} count declined >10%; inspect candidate and rerun with --allow-decrease only after review'})
        prior_report_path = OUT / 'quality-report.json'
        if prior_report_path.exists():
            previous_report = json.loads(prior_report_path.read_text(encoding='utf-8'))
            diff['ruleCoverage'] = {'before': previous_report.get('ruleCoverage', {}), 'after': report['ruleCoverage']}
    report['snapshotDiff'] = diff
    # A second process must not start a new refresh while this parser is reading
    # the previous generation and then let it publish a stale mixed manifest.
    validate_manifest_cache(manifest, CACHE)
    write_json(CACHE / 'catalog.candidate.json', catalog)
    write_json(CACHE / 'quality-report.candidate.json', report)
    if not catalog['metadata']['complete'] or report['failures']:
        raise RuntimeError('Candidate incomplete or count guard failed; existing published snapshot preserved. See .cache/calendar/quality-report.candidate.json')
    if accept:
        write_json(prior_path, catalog)
        write_json(OUT / 'quality-report.json', report)
        write_json(OUT / 'manifest.json', manifest)
        external = sum(r['status'] == 'external' for r in report['unresolvedReferences'])
        unresolved = len(report['unresolvedReferences']) - external
        prerequisite = report['ruleCoverage']['prerequisites']
        markdown = f'''# UTM 当前快照数据质量报告

学年：{manifest['academicYear']}。官方证据：{manifest['academicYearEvidence']['url']} 的页面标题 `{manifest['academicYearEvidence']['heading']}`。

抓取完成：{manifest.get('finishedAt', manifest['startedAt'])}（UTC）；解析器：{PARSER_VERSION}。

| 检查项 | 实际结果 |
| --- | ---: |
| Courses 目录分页 | {len(manifest['directories']['course']['pages'])} |
| Programs 目录分页 | {len(manifest['directories']['program']['pages'])} |
| 课程发现 / 成功详情 / 发布 | {len(manifest['directories']['course']['entities'])} / {len(catalog['courses'])} / {len(catalog['courses'])} |
| 专业发现 / 成功详情 / 发布 | {len(manifest['directories']['program']['entities'])} / {len(catalog['programs'])} / {len(catalog['programs'])} |
| 抓取或解析失败 | {len(report['failures'])} |
| 重复目录身份 | {sum(len(d['duplicates']) for d in manifest['directories'].values())} |
| 非空先修字段 | {prerequisite['nonempty']} |
| 非空先修已结构化 | {prerequisite.get('nonemptyParsed', 0)} |
| 先修含未知条件 | {prerequisite.get('unknown', 0)} |
| 全字段及专业组含未知 / applicability | {len(report['unknownRules'])} |
| 跨校区引用身份 | {external} |
| 当前 UTM 目录外引用身份 | {unresolved} |
| 先修引用图强连通分量 | {len(report['cycles'])} |

实体覆盖完整不等于所有要求已机器理解。程序整体录取/毕业要求保守保留 unknown，条款组用于带来源的规划建议；年度 cutoff、cohort、stream、选修池分配、许可、高中课、复杂学分组合和其它未解析文字需要人工确认。简单 exclusion 列表是任一触发；含上下文例外的 exclusion 保留 unknown。

环路是包含 OR 备选与 unknown 引用的投影结果，不代表必然无法完成的学习路径。外部/目录外引用保留完整代码和来源，未扩张为其他校区目录，也未自动当作等价课程。

详单：`data/utm/manifest.json` 保留每页 URL、实际页码、课程/专业清单、哈希、抓取时间和每个详情状态；`data/utm/quality-report.json` 保留每项未知规则、未解析原因、跨校区/目录外引用、引用它们的实体、全部环路与手动更新差异。原始 HTML 只在本机 `.cache/calendar/`，不发布到浏览器。

当前专业类型：{', '.join(f'{key} {value}' for key, value in sorted(report['programTypes'].items()))}。

## 环路详单

''' + '\n'.join('- ' + ', '.join(group) for group in report['cycles']) + '\n'
        report_path = ROOT / 'data' / 'utm' / 'data-quality.md'
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(markdown, encoding='utf-8')
    print(json.dumps({'accepted': accept, 'courses': len(catalog['courses']), 'programs': len(catalog['programs']),
                      'unknownRequirements': len(report['unknownRules']), 'unresolvedReferences': len(report['unresolvedReferences']),
                      'cycles': len(report['cycles']), 'ruleCoverage': report['ruleCoverage']}, ensure_ascii=False, indent=2), flush=True)
    return catalog, report
