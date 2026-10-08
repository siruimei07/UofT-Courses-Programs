"""Calendar detail pages -> auditable single-snapshot catalog for one campus.

``build_catalog`` parses a verified collection (see cache.py), writes candidate files into the
campus cache and, with ``accept=True``, replaces the published snapshot in ``data/<dataDir>/``.
Requirement roles (which codes are edges) are decided in references.py; the expression grammar
lives in rules.py.
"""
from __future__ import annotations

from collections import Counter, defaultdict
import json
import re

from bs4 import BeautifulSoup, Tag

from .cache import read_verified_source, validate_manifest_cache
from .campuses import ROOT, UTM, Campus
from .files import read_json, write_json, write_text
from .references import (COREQ_OR_REASON, COREQ_PLACEMENT_REASON, NO_CONTEXT, Analysis, CodeContext, analyse, combine_tails,
                         corequisite_rule, guard, partition, prune_any, prune_self, strip_unresolved)
from .rules import COURSE_PATTERN, COURSE_RE, clean, combine, course_id, exclusion_rule, parse_rule, refs, unknown, walk

PARSER_VERSION = '1.2.0'
REQUIREMENT_FIELDS = ['prerequisites', 'corequisites', 'exclusions', 'recommended', 'restrictions']
OPTIONAL_COURSE_FIELDS = ['deliveryCampus', 'courseExperience', 'internationalComponent']
# How codes absent from the calendar leave each AST (references.strip_unresolved); default 'require'.
STRIP_MODES = {'exclusions': 'trigger', 'recommended': 'drop'}
FORMERLY_LEAD = re.compile(r'^\(?\s*formerly:?\s+(' + COURSE_PATTERN + r'(?:\s*(?:/|,|\bor\b|\band\b)\s*' + COURSE_PATTERN + r')*)', re.I)
FRAGMENT = re.compile(r'[\W_]*(?:(?:and|or)\b[\W_]*)*', re.I)
# Parent context of a program requirement group. The reason carries the explanation; the
# official rawText is never prefixed with wording the calendar does not contain.
CONTEXT_REASON = 'Parent requirement context, route or elective allocation must be confirmed'
ADMISSION_REASON = ('Admission clause: admission depends on the complete program admission policy and route; '
                    'manual confirmation required')
ELECTIVE_LABEL = re.compile(r'\b(?:group\s+[A-Z0-9]|list\s+[A-Z0-9]|cluster\s+[A-Z0-9]|electives?|option|stream)\b', re.I)
# "the UTMCIP stream" -> "UTMCIP stream": the capitalised name in front of the route word.
STREAM_NAME = re.compile(r'(?:[A-Z(][\w&()-]*\s+){1,6}(?:stream|option)\b')


class Audit:
    """Parser observations that belong in the quality report, not in the catalog."""

    def __init__(self):
        self.repairs = []
        self.aliases = []
        self.corequisite_moves = []
        self.program_codes = []

    def record(self, entity_id, field_name, analysis):
        for repair in analysis.repairs:
            self.repairs.append({'entityId': entity_id, 'field': field_name, **repair})
        for alias in analysis.aliases:
            self.add_alias(entity_id, field_name, alias['formerly'], alias['current'])

    def add_alias(self, entity_id, field_name, formerly, current):
        self.aliases.append({'formerly': course_id(formerly), 'current': course_id(current) if current else None,
                             'entityId': entity_id, 'field': field_name})


def build_requirement(raw, url, analysis: Analysis, ctx: CodeContext, rule):
    """Requirement dict: courseIds are the only references that may become graph edges."""
    resolved, unresolved = partition(analysis.required, ctx)
    alias_resolved, alias_unresolved = partition(analysis.alias_codes, ctx)
    demoted = {course_id(code) for code in analysis.demoted}
    if demoted:
        rule = prune_any(rule, demoted)
    if analysis.self_code:
        rule = prune_self(rule, course_id(analysis.self_code))
    mode = STRIP_MODES.get(analysis.field_name, 'require')
    rule = guard(strip_unresolved(rule, unresolved, analysis.text, mode), resolved, analysis.text)
    mentioned = sorted(({course_id(code) for code in analysis.mentioned} | set(alias_resolved)) - set(resolved) - set(unresolved))
    unresolved = sorted(set(unresolved) | set(alias_unresolved))
    result = {'rawText': raw, 'sourceUrl': url, 'rule': rule, 'courseIds': resolved}
    if mentioned:
        result['mentionedIds'] = mentioned
    if unresolved:
        result['unresolvedIds'] = unresolved
    return result


def course_requirement(raw, url, ctx: CodeContext, field_name, code, parser=parse_rule):
    analysis = analyse(raw, ctx, field_name, code)
    if analysis.no_prerequisites or analysis.advisory:
        rule = {'kind': 'true'}
    elif analysis.coreq_texts and analysis.coreq_join not in ('', 'and'):
        # "X (may be taken as a corequisite) or Y": X moves to the corequisite field, so this
        # field alone cannot say which alternative applies.
        reason = COREQ_OR_REASON if analysis.coreq_join == 'or' else COREQ_PLACEMENT_REASON
        rule = combine_tails(unknown(analysis.rule_text, reason), analysis.tails)
    else:
        rule = combine_tails(parser(analysis.rule_text), analysis.tails)
    return build_requirement(raw, url, analysis, ctx, rule), analysis


def analysed_requirement(text, url, rule=None, ctx: CodeContext = NO_CONTEXT, field_name='group'):
    """Generic requirement (program-level text) with negation masking and code repair, plus its analysis."""
    analysis = analyse(text, ctx, field_name)
    return build_requirement(text, url, analysis, ctx, parse_rule(analysis.rule_text) if rule is None else rule), analysis


def requirement(text, url, rule=None, ctx: CodeContext = NO_CONTEXT, field_name='group'):
    return analysed_requirement(text, url, rule, ctx, field_name)[0]


def field(soup, name):
    return soup.select_one('.node__content .field--name-' + name + ' .field__item')


def text_field(soup, name):
    el = field(soup, name) if name else None
    return clean(el.get_text(' ', strip=True)) if el else ''


def source(entry, manifest, campus: Campus = UTM):
    reference = next(item for item in manifest['details'] if item['url'] == entry['url'] and item.get('status') == 'ok')
    return read_verified_source(reference, manifest['generationId'], campus.cache_dir)


def parse_course(entry, source_data, campus: Campus = UTM, ctx: CodeContext = NO_CONTEXT, audit: Audit | None = None):
    audit = audit or Audit()
    fields = campus.course_fields
    soup = BeautifulSoup(source_data['html'], 'html.parser')
    title_node = soup.select_one(campus.title_selector)
    heading = clean(title_node.get_text(' ', strip=True)) if title_node else ''
    code = entry['code']
    if not heading.startswith(code) or not soup.select_one(campus.course_article_selector):
        raise ValueError('Detail identity mismatch: ' + entry['url'])
    cid = course_id(code)
    url = source_data['finalUrl']
    pre = text_field(soup, fields['prerequisites'])
    core = text_field(soup, fields['corequisites'])
    recommended = text_field(soup, fields['recommended'])
    notes = text_field(soup, fields['notes'])
    description = text_field(soup, fields['description'])
    # Advisory corequisites ("Recommended Corequisite", "Highly Recommended", "(strongly
    # recommended ...)") never block: their codes become mentions and their text moves to
    # recommended. The official field text is always kept verbatim in rawText.
    core_req, core_analysis = course_requirement(core, url, ctx, 'corequisites', code)
    if core_analysis.advisory:
        recommended = clean(recommended + ' ' + core)
    prereq, pre_analysis = course_requirement(pre, url, ctx, 'prerequisites', code)
    if pre_analysis.advisory:
        recommended = clean(recommended + ' ' + pre)
    elif pre_analysis.advisory_text:
        recommended = clean(recommended + ' ' + pre_analysis.advisory_text)
    if pre_analysis.corequisite:
        # "(may be taken as a corequisite)": the courses are corequisite references (taken before
        # or together). The corequisite rule keeps them as the official alternatives, next to any
        # other alternative of the prerequisite text, instead of claiming nothing is required.
        moved, moved_unresolved = partition(pre_analysis.corequisite, ctx)
        core_req['courseIds'] = sorted(set(core_req['courseIds']) | set(moved))
        if moved_unresolved:
            core_req['unresolvedIds'] = sorted(set(core_req.get('unresolvedIds', [])) | set(moved_unresolved))
        if 'mentionedIds' in core_req:
            core_req['mentionedIds'] = [i for i in core_req['mentionedIds'] if i not in set(moved) | set(moved_unresolved)]
            if not core_req['mentionedIds']:
                del core_req['mentionedIds']
        moved_rule = corequisite_rule(pre_analysis, ctx)
        core_req['rule'] = moved_rule if core_req['rule']['kind'] == 'true' else combine('all', [core_req['rule'], moved_rule])
        audit.corequisite_moves.append({'entityId': cid, 'courseIds': moved + moved_unresolved,
                                        'placement': {'': 'alone', None: 'unscoped'}.get(pre_analysis.coreq_join, pre_analysis.coreq_join)})
    exclusions, exclusion_analysis = course_requirement(text_field(soup, fields['exclusions']), url, ctx, 'exclusions', code, exclusion_rule)
    recommended_req, recommended_analysis = course_requirement(recommended, url, ctx, 'recommended', code)
    restrictions, restriction_analysis = course_requirement(text_field(soup, fields['restrictions']), url, ctx, 'restrictions', code)
    for name, analysis in [('prerequisites', pre_analysis), ('corequisites', core_analysis), ('exclusions', exclusion_analysis),
                           ('recommended', recommended_analysis), ('restrictions', restriction_analysis)]:
        audit.record(cid, name, analysis)
    for name, text in [('description', description), ('notes', notes)]:
        lead = FORMERLY_LEAD.match(text)
        if lead:
            for old in COURSE_RE.findall(lead[1]):
                audit.add_alias(cid, name, old, code)
    course = {'id': cid, 'campus': campus.id, 'code': code,
              'title': heading[len(code):].lstrip(campus.title_separators), 'subject': code[:3], 'level': campus.course_level(code),
              'credits': campus.course_credits(code), 'description': description,
              'sourceUrl': url, 'contentHash': source_data['contentHash'], 'fetchedAt': source_data['fetchedAt'],
              'prerequisites': prereq, 'corequisites': core_req, 'exclusions': exclusions,
              'recommended': recommended_req, 'restrictions': restrictions,
              'notes': notes, 'distribution': text_field(soup, fields['distribution'])}
    for name in OPTIONAL_COURSE_FIELDS:
        value = text_field(soup, fields.get(name))
        if value:
            course[name] = value
    return course


def list_items(node):
    """Items of an ol/ul; a nested list placed beside the items belongs to the item before it."""
    items = []
    for child in node.children:
        if not isinstance(child, Tag):
            continue
        if child.name == 'li':
            items.append(child.get_text(' ', strip=True))
        elif child.name in {'ol', 'ul'}:
            if items:
                items[-1] += ' ' + child.get_text(' ', strip=True)
            else:
                items += list_items(child)
    return items


def stream_name(text):
    """Short name of a stream section for labels ("UTMCIP stream"); the first sentence otherwise."""
    match = STREAM_NAME.search(text)
    return clean(match[0]) if match else re.split(r'(?<=[.:;])\s', text, maxsplit=1)[0][:80].rstrip()


def program_groups(item, url, code, category, campus: Campus = UTM, ctx: CodeContext = NO_CONTEXT, audit: Audit | None = None):
    """Leaf requirement groups of one program field, each with its official text and context.

    Context never enters ``rawText`` unless it is official wording that directly frames the
    item (the paragraph right before a list, an elective-list heading). Everything else is an
    ``unknown`` leaf whose reason explains it, a cohort (``applicability``) or the label.
    """
    if item is None:
        return []
    groups = []
    heading = category.title()
    cohort = ''
    pending = ''
    route = ''
    # A stream paragraph followed by its own cohort pathways ("Enrolment in the UTMCIP stream
    # ... There are three admissions pathways") frames every group up to the next reset.
    section = None
    children = [child for child in item.children if isinstance(child, Tag) and clean(child.get_text(' ', strip=True))]

    def is_cohort(text):
        return bool(re.search(campus.cohort_cue_re, text, re.I))

    def add(text, label, scoped):
        text = clean(text)
        if not text or FRAGMENT.fullmatch(text):
            return
        # A leading decimal is a credit amount, not an outline marker: removing
        # "1." from "1.0 credit" would silently turn the minimum into zero.
        analysis = analyse(re.sub(r'^\d+(?:\.(?!\d)|\))\s*', '', text), ctx, 'group')
        rule = parse_rule(analysis.rule_text)
        if analysis.demoted:
            rule = prune_any(rule, {course_id(c) for c in analysis.demoted})
        # The paragraph right before a list, or an elective/group heading, is official framing text.
        framing = route or ('' if category == 'admission' or not ELECTIVE_LABEL.search(label) else label)
        contexts = []
        if framing and not text.startswith(framing):
            contexts.append(unknown(framing, CONTEXT_REASON))
            text = clean(framing + ' ' + text)
        if section and not text.startswith(section['text']):
            contexts.append(unknown(section['text'], CONTEXT_REASON))
            if not label.startswith(section['name']):
                label = f"{section['name']} · {label}"
        if category == 'admission' and not framing and not contexts:
            contexts.append(unknown('', ADMISSION_REASON))
        if contexts:
            rule = combine('all', contexts + [rule])
        if scoped:
            rule = {'kind': 'applicability', 'cohort': scoped, 'rule': rule}
        group, roles = analysed_requirement(text, url, rule, ctx)
        group.update({'id': f'{campus.id}:{code}:{category}:{len(groups) + 1}', 'label': label[:180], 'category': category})
        if audit is not None:
            audit.record(f'{campus.id}:{code}', group['id'], roles)
        groups.append(group)

    for index, child in enumerate(children):
        text = clean(child.get_text(' ', strip=True))
        if child.name in {'ol', 'ul'}:
            if pending:
                add(pending + ' ' + text, heading, cohort)
                pending = ''
            else:
                for number, entry in enumerate(list_items(child), 1):
                    add(entry, f'{heading} · {number}', cohort)
            continue
        # A stream/co-op/option paragraph frames only the list that directly follows it, unless
        # cohort pathways follow it (a section). A cohort paragraph is a cohort, never a route:
        # its wording already is the cohort and the heading of the groups under it.
        route = text if re.search(campus.route_cue_re, text, re.I) and not is_cohort(text) else ''
        if route:
            following = children[index + 1] if index + 1 < len(children) else None
            opens = following is not None and following.name not in {'ol', 'ul'} and is_cohort(clean(following.get_text(' ', strip=True)))
            section = {'text': text, 'name': stream_name(text)} if opens else None
            if section:
                heading = section['name']
        if is_cohort(text):
            cohort = text
            heading = text
            add(text, heading, cohort)
            continue
        if re.search(r'all students have the same', text, re.I):
            cohort = ''
            route = ''
            section = None
            heading = text
            continue
        if re.fullmatch(r'notes?\s*:?', text, re.I):
            if pending:
                add(pending, heading, cohort)
            cohort = ''
            route = ''
            section = None
            pending = ''
            heading = text
            continue
        if not refs(text) and re.search(r'(?:credits?.*(?:from|following|list)|one of the following|program electives)', text, re.I):
            if pending:
                add(pending, heading, cohort)
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


def parse_program(entry, source_data, campus: Campus = UTM, ctx: CodeContext = NO_CONTEXT, audit: Audit | None = None):
    audit = audit or Audit()
    fields = campus.program_fields
    soup = BeautifulSoup(source_data['html'], 'html.parser')
    heading = clean(soup.select_one(campus.title_selector).get_text(' ', strip=True))
    if not soup.select_one(campus.program_article_selector):
        raise ValueError('Program detail content missing: ' + entry['url'])
    code, url = entry['code'], source_data['finalUrl']
    official_code = text_field(soup, fields['code'])
    if official_code and re.fullmatch(campus.post_code_re, code) and code not in official_code.upper():
        raise ValueError('Program identity mismatch: ' + entry['url'])
    type_match = re.search(r'\b(Specialist|Major|Minor|Certificate|Focus)\b', heading, re.I)
    program_type = type_match[1].title() if type_match else 'Other'
    admission = text_field(soup, fields['admission'])
    completion = text_field(soup, fields['completion'])
    groups = program_groups(field(soup, fields['admission']), url, code, 'admission', campus, ctx, audit)
    groups += program_groups(field(soup, fields['completion']), url, code, 'completion', campus, ctx, audit)
    def whole(text, category):
        # Full programs include overlap, subclauses, annual cutoffs and alternate
        # paths. Leaf groups support explainable recommendations, not certification.
        return requirement(text, url, unknown(text, f'Full program {category} requires official contextual and allocation review')
                           if text else unknown('', f'Official {category} field absent; not assumed to have no requirements'), ctx)
    program = {'id': campus.id + ':' + code, 'campus': campus.id, 'code': official_code or code}
    if not re.search(campus.post_code_re, official_code):
        # Focus programs print their name in the POSt code field: the URL slug is the code.
        program['code'] = code
        program['codeSource'] = 'url-slug'
        audit.program_codes.append({'entityId': program['id'], 'code': code, 'postCodeField': official_code})
    program.update({'title': heading, 'type': program_type, 'description': text_field(soup, fields['description']), 'sourceUrl': url,
                    'contentHash': source_data['contentHash'], 'fetchedAt': source_data['fetchedAt'],
                    'admission': whole(admission, 'admission'), 'completion': whole(completion, 'completion'),
                    'groups': groups, 'notes': text_field(soup, fields['notes'])})
    return program


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


def alias_table(audit: Audit, ids):
    grouped = {}
    for alias in audit.aliases:
        key = (alias['formerly'], alias['current'])
        row = grouped.setdefault(key, {'formerly': alias['formerly'], 'current': alias['current'],
                                       'formerlyInCatalog': alias['formerly'] in ids, 'citedBy': set()})
        row['citedBy'].add(alias['entityId'] + ' ' + alias['field'])
    return [{**row, 'citedBy': sorted(row['citedBy'])} for _, row in sorted(grouped.items(), key=lambda item: (item[0][0], item[0][1] or ''))]


def quality(catalog, manifest, parse_failures, campus: Campus = UTM, audit: Audit | None = None):
    audit = audit or Audit()
    ids = {c['id'] for c in catalog['courses']}
    ast = Counter()
    missing = defaultdict(lambda: {'roles': set(), 'referencedBy': set()})
    unknowns = []
    field_summary = defaultdict(Counter)
    role_counts = defaultdict(Counter)
    requirements = []
    for course in catalog['courses']:
        for key in REQUIREMENT_FIELDS:
            requirements.append((course['id'], key, course[key]))
    for program in catalog['programs']:
        for key in ['admission', 'completion']:
            requirements.append((program['id'], key, program[key]))
        requirements.extend((program['id'], group['id'], group) for group in program['groups'])
    for entity_id, name, requirement_value in requirements:
        nodes = list(walk(requirement_value['rule']))
        ast.update(node['kind'] for node in nodes)
        is_unknown = any(node['kind'] in {'unknown', 'applicability'} for node in nodes)
        bucket = name if ':' not in name else 'programGroups'
        summary = field_summary[bucket]
        summary['unknown' if is_unknown else 'parsed'] += 1
        summary['nonempty' if requirement_value['rawText'] else 'absentOrEmpty'] += 1
        if requirement_value['rawText'] and not is_unknown:
            summary['nonemptyParsed'] += 1
        if is_unknown:
            unknowns.append({'entityId': entity_id, 'field': name, 'sourceUrl': requirement_value['sourceUrl'],
                             'text': requirement_value['rawText'][:300],
                             'reasons': sorted({node.get('reason', 'Cohort applicability requires confirmation') for node in nodes if node['kind'] in {'unknown', 'applicability'}})})
        for role, key in [('required', 'courseIds'), ('unresolved', 'unresolvedIds'), ('mentioned', 'mentionedIds')]:
            role_counts[bucket][key] += len(requirement_value.get(key, []))
            for referenced in requirement_value.get(key, []):
                if referenced not in ids:
                    missing[referenced]['roles'].add(role)
                    missing[referenced]['referencedBy'].add(entity_id)
    weight = {repair['code']: repair['existing'] for repair in audit.repairs if repair['kind'] == 'weightMismatch'}
    unresolved_rows = []
    for key, value in sorted(missing.items()):
        row = {'courseId': key, 'status': 'external' if not campus.owns(key) else 'unresolved',
               'roles': sorted(value['roles']), 'referencedBy': sorted(value['referencedBy'])}
        code = key.split(':', 1)[1]
        if code in weight:
            row['existingWeightTwin'] = course_id(weight[code])
        unresolved_rows.append(row)
    report = {'academicYear': catalog['metadata']['academicYear'], 'generatedAt': manifest.get('finishedAt', manifest['startedAt']),
              'parserVersion': PARSER_VERSION, 'complete': catalog['metadata']['complete'],
              'coverage': {}, 'failures': manifest.get('failures', []) + parse_failures,
              'astCounts': dict(ast), 'ruleCoverage': dict(field_summary), 'unknownRules': unknowns,
              'referenceRoles': {bucket: dict(counts) for bucket, counts in sorted(role_counts.items())},
              'unresolvedReferences': unresolved_rows,
              'aliases': alias_table(audit, ids),
              'codeRepairs': sorted(audit.repairs, key=lambda r: (r['entityId'], r['field'], r['kind'], r.get('text', r.get('code', '')))),
              'corequisiteMoves': audit.corequisite_moves,
              'programCodeFallbacks': audit.program_codes,
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


def snapshot_diff(catalog, report, out_dir, allow_decrease):
    prior_path = out_dir / 'catalog.json'
    diff = {'previousSnapshot': prior_path.exists(), 'courses': {}, 'programs': {}}
    if not prior_path.exists():
        return diff
    old = read_json(prior_path)
    for plural in ['courses', 'programs']:
        before = {x['id']: x for x in old[plural]}
        after = {x['id']: x for x in catalog[plural]}
        rule_fields = REQUIREMENT_FIELDS if plural == 'courses' else ['admission', 'completion']
        diff[plural] = {'added': sorted(after.keys() - before.keys()), 'removed': sorted(before.keys() - after.keys()),
                        'changedSource': sorted(k for k in before.keys() & after.keys() if before[k]['contentHash'] != after[k]['contentHash']),
                        'changedRequirements': sorted(k for k in before.keys() & after.keys()
                                                      if any(before[k][name]['rawText'] != after[k][name]['rawText'] for name in rule_fields)),
                        'before': len(before), 'after': len(after)}
        if len(after) < .9 * len(before) and not allow_decrease:
            report['failures'].append({'error': f'{plural} count declined >10%; inspect candidate and rerun with --allow-decrease only after review'})
    prior_report_path = out_dir / 'quality-report.json'
    if prior_report_path.exists():
        previous_report = read_json(prior_report_path)
        diff['ruleCoverage'] = {'before': previous_report.get('ruleCoverage', {}), 'after': report['ruleCoverage']}
    return diff


def quality_markdown(campus: Campus, manifest, catalog, report):
    external = sum(r['status'] == 'external' for r in report['unresolvedReferences'])
    unresolved = len(report['unresolvedReferences']) - external
    prerequisite = report['ruleCoverage']['prerequisites']
    evidence = manifest['academicYearEvidence']
    data = f'data/{campus.data_dir}'
    cache = campus.cache_dir.relative_to(ROOT).as_posix() if campus.cache_dir.is_relative_to(ROOT) else campus.cache_dir.name
    repairs = Counter(repair['kind'] for repair in report['codeRepairs'])
    rows = [
        ('Course directory pages', len(manifest['directories']['course']['pages'])),
        ('Program directory pages', len(manifest['directories']['program']['pages'])),
        ('Courses discovered / detail ok / published', f"{len(manifest['directories']['course']['entities'])} / {len(catalog['courses'])} / {len(catalog['courses'])}"),
        ('Programs discovered / detail ok / published', f"{len(manifest['directories']['program']['entities'])} / {len(catalog['programs'])} / {len(catalog['programs'])}"),
        ('Collection or parse failures', len(report['failures'])),
        ('Duplicate directory identities', sum(len(d['duplicates']) for d in manifest['directories'].values())),
        ('Non-empty prerequisite fields', prerequisite['nonempty']),
        ('Non-empty prerequisites fully structured', prerequisite.get('nonemptyParsed', 0)),
        ('Prerequisites with unknown clauses', prerequisite.get('unknown', 0)),
        ('Requirements (all fields and program groups) with unknown / applicability', len(report['unknownRules'])),
        ('Other-campus referenced ids', external),
        (f'{campus.id} ids not in the current calendar (never edges)', unresolved),
        ('Code typography repaired (glued / spaced / campus digit / suffix)',
         ' / '.join(str(repairs[kind]) for kind in ['glued', 'spaced', 'campusDigit', 'suffix'])),
        ('Unrecognised code-like tokens / H-Y weight mismatches (reported only)', f"{repairs['unrecognizedCode']} / {repairs['weightMismatch']}"),
        ('"(formerly X)" aliases (reported, not substituted)', len(report['aliases'])),
        ('Prerequisite reference cycles (SCCs)', len(report['cycles'])),
    ]
    table = '\n'.join(f'| {label} | {value} |' for label, value in rows)
    cycle_lines = '\n'.join('- ' + ', '.join(group) for group in report['cycles']) or '- none'
    return f'''# {campus.id} current snapshot: data quality report

Academic year: {manifest['academicYear']}. Evidence: the page heading `{evidence['heading']}` at {evidence['url']}.

Collection finished: {manifest.get('finishedAt', manifest['startedAt'])} (UTC); parser {PARSER_VERSION}.

| Check | Result |
| --- | ---: |
{table}

Complete entity coverage does not mean every requirement is machine-understood. Whole program admission and completion rules stay `unknown` on purpose; requirement groups support sourced planning hints. Annual cutoffs, cohorts, streams, elective-pool allocation, permissions, high-school courses, complex credit combinations and other unparsed wording need manual confirmation. A simple exclusion list means any listed course triggers the exclusion; exclusions with contextual exceptions, or with "and" mixed into an "or" list, stay `unknown`.

Only `courseIds` are graph edges. Codes the text rules out ("except", "excluding", "no longer accepted"), advisory codes ("Highly Recommended", "Recommended Corequisite") and codes in conditional sentences ("Students seeking ...") are kept in `mentionedIds`; {campus.id} codes absent from this calendar are kept in `unresolvedIds`. "(formerly X)" aliases are listed in the quality report and never substituted.

Cycles are computed over all prerequisite references, including OR alternatives and unknown clauses; they do not imply an impossible study path. Other-campus and retired references keep their full code and source; they are never expanded into other catalogs or treated as equivalent courses.

Details: `{data}/manifest.json` keeps every directory URL, page number, entity list, hash, fetch time and detail status; `{data}/quality-report.json` keeps every unknown rule with its reason, cross-campus and retired references with the entities citing them, code repairs, aliases, all cycles and the snapshot diff. Raw HTML stays in the local `{cache}/` cache and is never published to the browser.

Program types: {', '.join(f'{key} {value}' for key, value in sorted(report['programTypes'].items()))}.

## Cycles

{cycle_lines}
'''


def code_context(manifest, campus: Campus):
    known = frozenset(entry['code'] for entry in manifest['directories']['course']['entities'])
    year = re.match(r'(20\d\d)', manifest.get('academicYear', ''))
    return CodeContext(campus.id, campus.campus_digit, known, int(year[1]) if year else None)


def parse_snapshot(manifest, campus: Campus = UTM):
    """Pure parse of a verified collection: (catalog, report without snapshotDiff). Writes nothing."""
    catalog = {'schemaVersion': 1, 'metadata': {'campus': campus.id, 'academicYear': manifest['academicYear'],
                'academicYearSource': manifest['academicYearEvidence']['url'],
                'fetchedAt': manifest.get('finishedAt', manifest['startedAt']), 'parserVersion': PARSER_VERSION,
                'sources': campus.catalog_sources,
                'complete': manifest.get('complete', False)}, 'courses': [], 'programs': []}
    ctx = code_context(manifest, campus)
    audit = Audit()
    failures = []
    for kind, plural, parse in [('course', 'courses', parse_course), ('program', 'programs', parse_program)]:
        for entry in manifest['directories'][kind]['entities']:
            try:
                catalog[plural].append(parse(entry, source(entry, manifest, campus), campus, ctx, audit))
            except Exception as exc:
                failures.append({'kind': kind, 'code': entry['code'], 'url': entry['url'], 'error': str(exc)})
    catalog['metadata']['complete'] = catalog['metadata']['complete'] and not failures
    return catalog, quality(catalog, manifest, failures, campus, audit)


def build_catalog(manifest, campus: Campus = UTM, allow_decrease=False, accept=False, allow_planned=False):
    campus.require_supported(allow_planned)
    directory, out_dir = campus.cache_dir, campus.out_dir
    validate_manifest_cache(manifest, directory)
    catalog, report = parse_snapshot(manifest, campus)
    report['snapshotDiff'] = snapshot_diff(catalog, report, out_dir, allow_decrease)
    # A second process must not start a new refresh while this parser is reading
    # the previous generation and then let it publish a stale mixed manifest.
    validate_manifest_cache(manifest, directory)
    write_json(directory / 'catalog.candidate.json', catalog)
    write_json(directory / 'quality-report.candidate.json', report)
    if not catalog['metadata']['complete'] or report['failures']:
        raise RuntimeError('Candidate incomplete or count guard failed; existing published snapshot preserved. '
                           f'See {directory / "quality-report.candidate.json"}')
    if accept:
        write_json(out_dir / 'catalog.json', catalog)
        write_json(out_dir / 'quality-report.json', report)
        write_json(out_dir / 'manifest.json', manifest)
        write_text(out_dir / 'data-quality.md', quality_markdown(campus, manifest, catalog, report))
    summary = {'campus': campus.id, 'accepted': accept, 'courses': len(catalog['courses']), 'programs': len(catalog['programs']),
               'unknownRequirements': len(report['unknownRules']), 'unresolvedReferences': len(report['unresolvedReferences']),
               'cycles': len(report['cycles']), 'ruleCoverage': report['ruleCoverage']}
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    return catalog, report
