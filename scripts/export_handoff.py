"""Export the collected UTM snapshot and reference implementation without network IO.

Run in this handoff directory with --source pointing to the original workspace.
Supplementary research and handoff documentation are maintained separately.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
FIELDS = ['prerequisites', 'corequisites', 'exclusions', 'recommended', 'restrictions']
RELATIONS = dict(zip(FIELDS, ['prerequisite', 'corequisite', 'exclusion', 'recommended', 'restriction']))


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def clean(text):
    return re.sub(r'\s+', ' ', text.replace('\xa0', ' ').replace('\u200b', '')).strip()


def relative(path):
    return path.relative_to(ROOT).as_posix()


def nodes(rule, pointer=''):
    yield pointer, rule
    for i, child in enumerate(rule.get('items', [])):
        yield from nodes(child, pointer + '/items/' + str(i))
    if 'rule' in rule:
        yield from nodes(rule['rule'], pointer + '/rule')


def requirement_records(catalog):
    for plural, kind in [('courses', 'course'), ('programs', 'program')]:
        for i, entity in enumerate(catalog[plural]):
            fields = FIELDS if kind == 'course' else ['admission', 'completion']
            entries = [(field, entity[field], f'/{plural}/{i}/{field}') for field in fields]
            if kind == 'program':
                entries += [(group['id'], group, f'/{plural}/{i}/groups/{j}') for j, group in enumerate(entity['groups'])]
            for field, req, pointer in entries:
                walked = list(nodes(req['rule']))
                uncertain = [{'rulePointer': path, **node} for path, node in walked if node['kind'] in {'unknown', 'applicability'}]
                ast_refs = set()
                for _, node in walked:
                    if node['kind'] in {'course', 'minGrade'}:
                        ast_refs.add(node['courseId'])
                    if node['kind'] == 'credits':
                        ast_refs.update(node.get('courseIds', []))
                yield {
                    'requirementId': entity['id'] + '/' + field,
                    'entityId': entity['id'], 'entityKind': kind, 'field': field,
                    'category': req.get('category', field), 'label': req.get('label', field),
                    'catalogPointer': pointer, 'rawText': req['rawText'], 'sourceUrl': req['sourceUrl'],
                    'rule': req['rule'], 'courseIds': req['courseIds'],
                    'astCourseIds': sorted(ast_refs), 'requiresConfirmation': bool(uncertain),
                    'uncertainNodes': uncertain,
                }


def links(element, base):
    found, seen = [], set()
    for a in element.select('a[href]'):
        url = urljoin(base, a['href'])
        text = clean(a.get_text(' ', strip=True))
        if (url, text) not in seen:
            found.append({'url': url, 'text': text})
            seen.add((url, text))
    return found


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--source', type=Path, required=True, help='Original UofT Courses workspace; read only')
    args = ap.parse_args()
    source = args.source.resolve()
    if source == ROOT:
        ap.error('Source and handoff directory must differ')
    sys.path.insert(0, str(source / 'scripts'))
    import collect_calendar as collector
    manifest = read(source / 'public/data/manifest.json')
    catalog = read(source / 'public/data/catalog.json')
    quality = read(source / 'public/data/quality-report.json')
    collector.validate_manifest_cache(manifest, source / '.cache/calendar')
    assert catalog['metadata']['complete'] and quality['complete']

    copied = []

    def copy_file(src, dest):
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        copied.append({'sourcePath': src.relative_to(source).as_posix(), 'path': relative(dest),
                       'sha256': hashlib.sha256(dest.read_bytes()).hexdigest()})

    # Preserve the existing implementation as a usable, inspectable reference.
    # Do not install source-project skills or copy its active agent configuration.
    for folder in ['src', 'tests', '.github']:
        for file in (source / folder).rglob('*'):
            if file.is_file() and '__pycache__' not in file.parts:
                copy_file(file, ROOT / file.relative_to(source))
    for name in ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
                 'eslint.config.js', 'playwright.config.ts', 'index.html', '.gitattributes', 'requirements.txt']:
        copy_file(source / name, ROOT / name)
    for name in ['calendar_parser.py', 'collect_calendar.py', 'requirements-calendar.txt',
                 'validate-catalog.ts', 'benchmark.ts', 'serve-e2e.mjs']:
        copy_file(source / 'scripts' / name, ROOT / 'scripts' / name)
    for name in ['collect_calendar.py', 'calendar_parser.py']:
        path = ROOT / 'scripts' / name
        content = path.read_text(encoding='utf-8')
        content = content.replace("ROOT / '.cache' / 'calendar'", "ROOT / 'sources' / 'calendar'")
        content = content.replace('.cache/calendar', 'sources/calendar')
        path.write_text(content, encoding='utf-8')
    for name in ['catalog.json', 'manifest.json', 'quality-report.json']:
        copy_file(source / 'public/data' / name, ROOT / 'public/data' / name)
    copy_file(source / 'public/favicon.svg', ROOT / 'public/favicon.svg')
    copy_file(source / 'src/domain/types.ts', ROOT / 'data/catalog-types.ts')
    for path in (source / 'docs').rglob('*'):
        if path.is_file():
            # Original validation documents describe the original project only.
            dest = ROOT / 'docs' / ('reference' if path.parent.name == 'reference' else 'research') / path.name
            copy_file(path, dest)
    for name in ['AGENTS.md', 'README.md', 'START_PROMPT.md']:
        copy_file(source / name, ROOT / 'docs/research' / ('original-' + name))
    copy_file(source / '.agents/skills/uoft-calendar-data/references/source-notes.md',
              ROOT / 'docs/research/source-notes.md')
    for path in (source / 'reports').rglob('*'):
        if path.is_file():
            copy_file(path, ROOT / 'reports/source-project' / path.relative_to(source / 'reports'))
    for path in (source / '.cache/samples').glob('*'):
        if path.is_file():
            copy_file(path, ROOT / 'sources/research-samples' / path.name)

    # Copy precisely the source records bound to the accepted manifest.
    cache = ROOT / 'sources/calendar'
    cache.mkdir(parents=True, exist_ok=True)
    copy_file(source / '.cache/calendar/active-run.json', cache / 'active-run.json')
    copy_file(source / 'public/data/manifest.json', cache / 'manifest.json')
    source_index, official = [], {'schemaVersion': 1, 'courses': [], 'programs': []}
    source_links = defaultdict(dict)
    by_url = {e['sourceUrl']: e for plural in ['courses', 'programs'] for e in catalog[plural]}
    source_refs = collector.manifest_sources(manifest)
    for reference in source_refs:
        record = collector.read_verified_source(reference, manifest['generationId'], source / '.cache/calendar')
        url = reference['url']
        file_name = hashlib.sha256(url.encode()).hexdigest() + '.json'
        copy_file(source / '.cache/calendar' / file_name, cache / file_name)
        soup = BeautifulSoup(record['html'], 'html.parser')
        article = soup.select_one('article.node') or soup.select_one('main') or soup.body or soup
        title_node = soup.select_one('h1.page-title') or soup.find('h1') or soup.title
        title = clean(title_node.get_text(' ', strip=True)) if title_node else url
        article_text = article.get_text('\n', strip=True)
        article_links = links(article, record['finalUrl'])
        entity = by_url.get(url) or by_url.get(record['finalUrl'])
        if entity:
            kind = 'course' if '/course/' in url else 'program'
            text_path = ROOT / 'sources/text' / kind / (entity['id'].replace(':', '__') + '.md')
            fields = []
            for element in article.select('.field'):
                names = [c for c in element.get('class', []) if c.startswith('field--name-')]
                if not names:
                    continue
                label_node = element.select_one('.field__label')
                items = element.select('.field__item')
                fields.append({'name': names[0], 'label': clean(label_node.get_text(' ', strip=True)) if label_node else '',
                               'rawText': clean(element.get_text(' ', strip=True)),
                               'items': [{'rawText': clean(item.get_text(' ', strip=True)), 'html': str(item),
                                          'links': links(item, record['finalUrl'])} for item in items]})
            official[kind + 's'].append({'id': entity['id'], 'sourceUrl': url, 'sourceRecord': relative(cache / file_name),
                                         'contentHash': record['contentHash'], 'fields': fields,
                                         'articleText': article_text, 'links': article_links})
            for link in article_links:
                code = urlparse(link['url']).path.rstrip('/').split('/')[-1].upper()
                if re.fullmatch(r'[A-Z]{3}(?:\d{3}|[A-Z]\d{2})[HY][135]', code):
                    cid = {'5': 'UTM', '1': 'UTSG', '3': 'UTSC'}[code[-1]] + ':' + code
                    source_links[cid][link['url']] = link['text']
        elif 'page' in reference:
            kind = 'directory'
            base = 'course-search' if 'course-search' in url else 'program-search'
            text_path = ROOT / 'sources/text/directory' / f'{base}-page-{reference["page"]:03d}.md'
        else:
            kind = 'policy'
            slug = urlparse(url).path.strip('/') or 'calendar-home'
            text_path = ROOT / 'sources/text/policy' / (slug.replace('/', '__') + '.md')
        text_path.parent.mkdir(parents=True, exist_ok=True)
        text_path.write_text(f'# {title}\n\nSource: {url}\nFetched: {record["fetchedAt"]}\nHTML SHA-256: {record["contentHash"]}\n\n{article_text}\n\n## Captured links\n\n' +
                             '\n'.join(f'- [{link["text"] or link["url"]}]({link["url"]})' for link in article_links) + '\n', encoding='utf-8')
        source_index.append({'url': url, 'finalUrl': record['finalUrl'], 'kind': kind, 'title': title,
                             'entityId': entity['id'] if entity else None, 'recordPath': relative(cache / file_name),
                             'textPath': relative(text_path), 'contentHash': record['contentHash'],
                             'fetchedAt': record['fetchedAt']})

    write(ROOT / 'data/official-fields.json', official)
    write(ROOT / 'sources/source-index.json', {'schemaVersion': 1, 'sources': source_index,
                                              'supplementaryManifest': 'sources/supplementary/manifest.json'})
    requirements = list(requirement_records(catalog))
    path = ROOT / 'data/requirements.jsonl'
    with path.open('w', encoding='utf-8', newline='\n') as handle:
        for requirement in requirements:
            handle.write(json.dumps(requirement, ensure_ascii=False, separators=(',', ':')) + '\n')
    write(ROOT / 'data/unknown-requirements.json', {'schemaVersion': 1, 'requirements': [r for r in requirements if r['requiresConfirmation']]})

    course_ids = {c['id'] for c in catalog['courses']}
    edges, program_edges = [], []
    for requirement in requirements:
        for reference in requirement['courseIds']:
            edge = {'id': requirement['requirementId'] + '/' + reference,
                    'from': reference, 'to': requirement['entityId'], 'requirementId': requirement['requirementId'],
                    'field': requirement['field'], 'catalogPointer': requirement['catalogPointer'],
                    'sourceUrl': requirement['sourceUrl'], 'requiresConfirmation': requirement['requiresConfirmation'],
                    'presentInAst': reference in requirement['astCourseIds'],
                    'referenceStatus': 'internal' if reference in course_ids else 'unresolved' if reference.startswith('UTM:') else 'external'}
            if requirement['entityKind'] == 'course':
                edge['relation'] = RELATIONS[requirement['field']]
                edges.append(edge)
            else:
                edge['category'] = requirement['category']
                edge['label'] = requirement['label']
                program_edges.append(edge)
    meaning = 'Reference projection only. Edges do not replace the complete requirement AST, assert mandatory course completion, equivalence, eligibility, or guaranteed unlocks.'
    write(ROOT / 'data/relations.json', {'schemaVersion': 1, 'meaning': meaning, 'direction': 'referenced course -> owning course',
                                       'counts': dict(Counter(edge['relation'] for edge in edges)), 'edges': edges})
    write(ROOT / 'data/program-course-relations.json', {'schemaVersion': 1, 'meaning': meaning,
                                                     'direction': 'referenced course -> owning program', 'edges': program_edges})
    by_subject, by_level, by_type = defaultdict(list), defaultdict(list), defaultdict(list)
    incoming, outgoing, req_by_entity, programs_by_course = defaultdict(list), defaultdict(list), defaultdict(list), defaultdict(set)
    for course in catalog['courses']:
        by_subject[course['subject']].append(course['id'])
        by_level[str(course['level'])].append(course['id'])
    for program in catalog['programs']:
        by_type[program['type']].append(program['id'])
    for edge in edges:
        incoming[edge['to']].append(edge['id'])
        outgoing[edge['from']].append(edge['id'])
    for req in requirements:
        req_by_entity[req['entityId']].append(req['requirementId'])
    for edge in program_edges:
        programs_by_course[edge['from']].add(edge['to'])
    write(ROOT / 'data/indexes.json', {
        'schemaVersion': 1, 'courseIdToIndex': {c['id']: i for i, c in enumerate(catalog['courses'])},
        'programIdToIndex': {p['id']: i for i, p in enumerate(catalog['programs'])},
        'bySubject': dict(by_subject), 'byLevel': dict(by_level), 'byProgramType': dict(by_type),
        'courseIncomingRelations': dict(incoming), 'courseOutgoingRelations': dict(outgoing),
        'requirementsByEntity': dict(req_by_entity),
        'programsReferencingCourse': {k: sorted(v) for k, v in programs_by_course.items()},
    })
    external = []
    for ref in quality['unresolvedReferences']:
        external.append({**ref, 'officialLinks': [{'url': url, 'text': text} for url, text in sorted(source_links[ref['courseId']].items())],
                         'requirementIds': [r['requirementId'] for r in requirements if ref['courseId'] in r['courseIds']]})
    write(ROOT / 'data/external-references.json', {'schemaVersion': 1, 'meaning': 'References outside the current UTM course catalog; not a full catalog for any other campus.', 'references': external})
    write(ROOT / 'handoff-manifest.json', {
        'schemaVersion': 1, 'createdAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'sourceWorkspace': str(source), 'academicYear': catalog['metadata']['academicYear'],
        'snapshotFetchedAt': catalog['metadata']['fetchedAt'], 'parserVersion': catalog['metadata']['parserVersion'],
        'generationId': manifest['generationId'], 'entityCoverageComplete': True, 'machineRuleCoverageComplete': False,
        'counts': {'courses': len(catalog['courses']), 'programs': len(catalog['programs']), 'primarySourcePages': len(source_index),
                   'courseDirectoryPages': len(manifest['directories']['course']['pages']), 'programDirectoryPages': len(manifest['directories']['program']['pages']),
                   'requirements': len(requirements), 'uncertainRequirements': sum(r['requiresConfirmation'] for r in requirements),
                   'courseReferenceEdges': len(edges), 'programCourseReferenceEdges': len(program_edges), 'unresolvedCourseIdentities': len(external)},
        'programTypes': dict(Counter(p['type'] for p in catalog['programs'])), 'cycles': quality['cycles'],
        'supplementaryManifest': 'sources/supplementary/manifest.json',
        'collectorPathAdaptation': 'Only the copied collector/parser cache path and diagnostic strings change from .cache/calendar to sources/calendar.',
        'copiedFiles': copied, 'sourceProjectInstructions': 'docs/research/original-AGENTS.md is historical source material, not active instructions for this handoff project.',
    })
    print(json.dumps({'exported': True, 'target': str(ROOT), 'counts': read(ROOT / 'handoff-manifest.json')['counts']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
