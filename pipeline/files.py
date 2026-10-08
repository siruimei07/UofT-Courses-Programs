"""Small file helpers shared by the collectors and the parser.

Every text file is written as UTF-8 with LF line endings, so a Windows run produces the same
bytes as CI and the committed snapshot.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def sha256(value):
    if isinstance(value, str):
        value = value.encode('utf-8')
    return hashlib.sha256(value).hexdigest()


def write_text(path: Path, text: str):
    """Atomic UTF-8 write with LF newlines (no platform newline translation)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    with temp.open('w', encoding='utf-8', newline='\n') as handle:
        handle.write(text)
    temp.replace(path)


def write_json(path: Path, value, trailing_newline=False):
    write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + ('\n' if trailing_newline else ''))


def read_json(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))
