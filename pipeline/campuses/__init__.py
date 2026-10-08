"""Campus registry. Keep ids, digits, dataDir and URLs in sync with data/campuses.json
(tests/test_campuses.py checks them)."""
from .base import CAMPUS_DIGITS, ROOT, Campus
from .utm import UTM
from .utsg import UTSG

REGISTRY = {'utm': UTM, 'utsg': UTSG}


def get_campus(key: str) -> Campus:
    try:
        return REGISTRY[key.lower()]
    except KeyError:
        raise ValueError(f'Unknown campus {key!r}; choose one of {", ".join(sorted(REGISTRY))}') from None


def campus_keys():
    return sorted(REGISTRY)


__all__ = ['CAMPUS_DIGITS', 'REGISTRY', 'ROOT', 'Campus', 'UTM', 'UTSG', 'campus_keys', 'get_campus']
