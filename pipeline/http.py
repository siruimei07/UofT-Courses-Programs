"""The only network access of the pipeline: one User-Agent, one process-wide throttle.

Every request to any calendar host goes through ``get``. ``THROTTLE`` serialises request
starts across all worker threads with at least ``MIN_INTERVAL`` seconds between them (more if
robots.txt asks for a crawl delay), so adding workers never raises the request rate.

HTTP 401/403/429 means the host refused us: ``refuse`` raises ``AccessRefused`` and sets the
collection's stop event, and every later ``get`` with that event raises ``CollectionStopped``
before sending anything. A collector then cancels its queue, saves its manifest and exits.
"""
from __future__ import annotations

import threading
import time
from urllib.robotparser import RobotFileParser

import requests

from .files import now, sha256

USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')
MIN_INTERVAL = 0.5
REFUSED_STATUSES = frozenset({401, 403, 429})


class AccessRefused(PermissionError):
    """The host answered 401/403/429: stop the whole collection (no retry, no bypass)."""


class CollectionStopped(RuntimeError):
    """A request was not sent because the collection already stopped after a refusal."""


def refuse(response, url, stop: threading.Event | None = None):
    """Raise AccessRefused (and stop the collection) when the response is a refusal."""
    if response.status_code in REFUSED_STATUSES:
        if stop is not None:
            stop.set()
        raise AccessRefused(f'Access refused: {url} (HTTP {response.status_code}); collection stopped')


class Throttle:
    """Lock-based global pacing: request starts are at least ``interval`` seconds apart."""

    def __init__(self, interval=MIN_INTERVAL, clock=time.monotonic, sleep=time.sleep):
        self.interval = max(MIN_INTERVAL, float(interval))
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._next = None

    def raise_to(self, seconds):
        with self._lock:
            self.interval = max(self.interval, float(seconds))

    def wait(self):
        with self._lock:
            current = self._clock()
            start = current if self._next is None else max(current, self._next)
            self._next = start + self.interval
        if start > current:
            self._sleep(start - current)


THROTTLE = Throttle()
_local = threading.local()


def session():
    """One keep-alive session per worker thread, all with the same User-Agent."""
    current = getattr(_local, 'session', None)
    if current is None:
        current = requests.Session()
        current.headers['User-Agent'] = USER_AGENT
        _local.session = current
    return current


def get(url, timeout=(15, 60), allow_redirects=True, throttle=None, stop: threading.Event | None = None):
    """One paced GET. With ``stop``: nothing is sent once it is set, even after waiting for a slot."""
    if stop is not None and stop.is_set():
        raise CollectionStopped('Collection stopped after an access refusal: ' + url)
    (throttle or THROTTLE).wait()
    if stop is not None and stop.is_set():
        raise CollectionStopped('Collection stopped after an access refusal: ' + url)
    return session().get(url, timeout=timeout, allow_redirects=allow_redirects)


def load_robots(base_url, throttle=None):
    """Fetch and parse robots.txt; a crawl delay raises the shared throttle interval.

    401/403/429 is a refusal (AccessRefused). A missing robots.txt (404 or 410) allows
    everything, as robots.txt conventions specify; any other error stops the collection.
    """
    throttle = throttle or THROTTLE
    url = base_url.rstrip('/') + '/robots.txt'
    response = get(url, timeout=(15, 40), throttle=throttle)
    refuse(response, url)
    missing = response.status_code in (404, 410)
    if not missing:
        response.raise_for_status()
    text = '' if missing else response.content.decode('utf-8')
    robots = RobotFileParser(url)
    robots.parse(text.splitlines())
    robots.allow_all = missing
    delay = robots.crawl_delay(USER_AGENT) or robots.crawl_delay('*')
    if delay:
        throttle.raise_to(float(delay))
    evidence = {'url': url, 'finalUrl': response.url, 'fetchedAt': now(), 'httpStatus': response.status_code,
                'contentHash': sha256(text), 'text': text}
    return robots, evidence


def allowed(robots, url):
    return robots.can_fetch(USER_AGENT, url)
