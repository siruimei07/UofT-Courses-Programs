"""Campus adapter record: every campus-specific constant of the collector and the parser."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import re
from types import MappingProxyType
from typing import Mapping

ROOT = Path(__file__).resolve().parents[2]

# Last character of an official course code -> owning campus. Universal across UofT.
CAMPUS_DIGITS = MappingProxyType({'5': 'UTM', '1': 'UTSG', '0': 'UTSG', '3': 'UTSC'})


def frozen_map(**values) -> Mapping[str, str]:
    return MappingProxyType(dict(values))


@dataclass(frozen=True, eq=False)
class Campus:
    """One campus calendar. ``status='planned'`` adapters are unverified stubs."""

    id: str
    name: str
    status: str
    data_dir: str
    campus_digit: str
    base_url: str
    course_search_path: str
    program_search_path: str
    course_page_template: str
    program_page_template: str
    cache_dir: Path
    supplementary_dir: Path
    # Discovery (directory pages)
    directory_header_selector: str
    directory_course_re: str
    program_link_selector: str
    pager_selector: str
    page_title_marker: str
    year_heading_re: str
    supporting_slugs: tuple[str, ...]
    # Detail pages
    title_selector: str
    course_article_selector: str
    program_article_selector: str
    title_separators: str
    post_code_re: str
    course_fields: Mapping[str, str] = field(default_factory=frozen_map)
    program_fields: Mapping[str, str] = field(default_factory=frozen_map)
    # Program requirement prose
    route_cue_re: str = ''
    cohort_cue_re: str = ''
    # Supporting official rule pages (collect_supporting_sources)
    seed_slugs: tuple[str, ...] = ()
    nav_rule_words_re: str = ''
    # Published backend datasets live in <data_root>/<data_dir>/ (tests point this elsewhere).
    data_root: Path = ROOT / 'data'

    @property
    def host(self):
        return self.base_url.split('://', 1)[1].split('/', 1)[0]

    @property
    def calendar_url(self):
        return self.base_url + '/'

    @property
    def course_search_url(self):
        return self.base_url + self.course_search_path

    @property
    def program_search_url(self):
        return self.base_url + self.program_search_path

    @property
    def catalog_sources(self):
        return [self.course_search_url, self.program_search_url]

    @property
    def out_dir(self):
        return self.data_root / self.data_dir

    def search_url(self, kind):
        return self.course_search_url if kind == 'course' else self.program_search_url

    def course_url(self, code):
        return self.course_page_template.format(slug=code.lower())

    def program_url(self, code):
        return self.program_page_template.format(slug=code.lower())

    def course_level(self, code):
        return int(code[3]) * 100

    def course_credits(self, code):
        return .5 if code[-2] == 'H' else 1

    def course_id(self, code):
        return self.id + ':' + code

    def owns(self, course_id):
        return course_id.startswith(self.id + ':')

    def academic_year(self, heading):
        """'2026-2027' from the homepage heading, or None when it cannot be established."""
        match = re.search(self.year_heading_re, heading)
        if not match:
            return None
        end = match[2] if len(match[2]) == 4 else match[1][:2] + match[2]
        return match[1] + '-' + end

    def require_supported(self, allow_planned=False):
        if self.status != 'available' and not allow_planned:
            raise NotImplementedError(
                f'The {self.id} adapter is {self.status} and its selectors are unverified; '
                'pass --allow-planned to run it experimentally (nothing is published without review).')
