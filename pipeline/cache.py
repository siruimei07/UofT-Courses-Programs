"""Per-campus source cache: one collection generation at a time, every source hash-verified.

Layout of ``campus.cache_dir``: ``<sha256(url)>.json`` source records, ``manifest.json`` (the
denominator of one collection), ``active-run.json`` (the generation being collected) and the
parser's ``*.candidate.json`` outputs.
"""
from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

from .campuses import UTM, Campus
from .files import now, read_json, write_json


def cache_path(url, directory: Path):
    return directory / (hashlib.sha256(url.encode()).hexdigest() + '.json')


def manifest_sources(manifest):
    """The hashes defining a collection, including discovery and supporting rules."""
    sources = [manifest['academicYearEvidence']]
    sources += manifest.get('supportingSources', [])
    for directory in manifest['directories'].values():
        sources += directory['pages']
    sources += [item for item in manifest.get('details', []) if item.get('status') == 'ok']
    return sources


def read_verified_source(reference, generation_id=None, directory: Path = UTM.cache_dir):
    path = cache_path(reference['url'], directory)
    if not path.exists():
        raise RuntimeError('Source cache missing: ' + reference['url'])
    source = read_json(path)
    actual_hash = hashlib.sha256(source.get('html', '').encode()).hexdigest()
    if source.get('url') != reference['url'] or actual_hash != source.get('contentHash'):
        raise RuntimeError('Cached HTML integrity mismatch: ' + reference['url'])
    if reference.get('contentHash') and actual_hash != reference['contentHash']:
        raise RuntimeError('Cache does not match collection manifest: ' + reference['url'])
    if generation_id and source.get('generationId') != generation_id:
        raise RuntimeError('Source belongs to a different collection generation: ' + reference['url'])
    return source


def validate_manifest_cache(manifest, directory: Path = UTM.cache_dir):
    active_path = directory / 'active-run.json'
    if not active_path.exists() or not manifest.get('generationId'):
        raise RuntimeError('Collection generation missing; run the collector without --parse-only to initialize or migrate its source cache')
    active = read_json(active_path)
    if active['generationId'] != manifest['generationId']:
        raise RuntimeError('Manifest belongs to an earlier generation. Resume the active collection before parsing; published snapshot is preserved.')
    if not manifest.get('complete') or manifest.get('failures'):
        raise RuntimeError('Collection is incomplete; resume it before parsing')
    expected = {entry['url'] for group in manifest['directories'].values() for entry in group['entities']}
    successful = {item['url'] for item in manifest['details'] if item.get('status') == 'ok'}
    if expected != successful:
        raise RuntimeError('Manifest detail denominator mismatch')
    for reference in manifest_sources(manifest):
        read_verified_source(reference, manifest['generationId'], directory)


def load_manifest_for_parse(directory: Path):
    """Read-only entry point of --parse-only: never initialises, migrates or rewrites the cache."""
    manifest_path, active_path = directory / 'manifest.json', directory / 'active-run.json'
    if not manifest_path.exists():
        raise RuntimeError(f'No collection manifest in {directory}; run the collector first')
    if not active_path.exists():
        raise RuntimeError(f'{directory} has a manifest but no active-run.json (an unmigrated legacy cache). '
                           'Run the collector once with --offline (no --parse-only) to verify and adopt it.')
    manifest = read_json(manifest_path)
    validate_manifest_cache(manifest, directory)
    return manifest


def prepare_generation(refresh=False, offline=False, directory: Path = UTM.cache_dir, campus: Campus = UTM):
    """Resume exactly one crawl generation; never silently mix annual caches."""
    active_path, manifest_path = directory / 'active-run.json', directory / 'manifest.json'
    if refresh and offline:
        raise ValueError('--refresh and --offline cannot be combined')
    if refresh:
        active = {'generationId': uuid.uuid4().hex, 'startedAt': now(), 'status': 'collecting'}
        write_json(active_path, active)
        return active
    if active_path.exists():
        return read_json(active_path)
    # One-time migration of the original complete cache. Every entity, directory
    # and homepage must match its recorded source hash before assigning a batch.
    if manifest_path.exists():
        manifest = read_json(manifest_path)
        if not manifest.get('complete') or manifest.get('failures'):
            raise RuntimeError('Legacy cache is incomplete and has no generation identity. Start one complete --refresh; the published snapshot will be retained.')
        expected = {entry['url'] for group in manifest['directories'].values() for entry in group['entities']}
        successful = {item['url'] for item in manifest.get('details', []) if item.get('status') == 'ok'}
        if expected != successful:
            raise RuntimeError('Legacy manifest is incomplete; start --refresh')
        verified = [read_verified_source(reference, directory=directory) for reference in manifest_sources(manifest)]
        first = min(source['fetchedAt'] for source in verified)
        last = manifest['finishedAt']
        # Original auxiliary policy fetches were not enumerated in the manifest.
        # Adopt them only if their stored hash verifies and time lies in the
        # already verified source collection interval; otherwise leave them out.
        supporting = []
        for slug in campus.supporting_slugs:
            url = campus.base_url + '/' + slug
            if cache_path(url, directory).exists():
                auxiliary = read_verified_source({'url': url}, directory=directory)
                if first <= auxiliary['fetchedAt'] <= last:
                    verified.append(auxiliary)
                    supporting.append({key: auxiliary[key] for key in ['url', 'contentHash', 'fetchedAt']})
        active = {'generationId': uuid.uuid4().hex, 'startedAt': manifest['startedAt'],
                  'status': 'complete', 'migratedFromVerifiedManifest': True}
        for source in verified:
            source['generationId'] = active['generationId']
            write_json(cache_path(source['url'], directory), source)
        manifest['generationId'] = active['generationId']
        manifest['supportingSources'] = supporting
        write_json(manifest_path, manifest)
        write_json(active_path, active)
        return active
    if offline:
        raise RuntimeError('No active collection exists for offline use')
    active = {'generationId': uuid.uuid4().hex, 'startedAt': now(), 'status': 'collecting'}
    write_json(active_path, active)
    return active
