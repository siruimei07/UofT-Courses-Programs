"""University of Toronto St. George: PLANNED stub (Faculty of Arts & Science host only).

Values come from docs/data/multi-campus.md (sampled 2026-10-08) and were not exercised by a
collection run. Collection and parsing refuse this adapter unless --allow-planned is given.
Known gaps before it can ship: six faculty hosts (only Arts & Science here), program URLs built
from the directory header code (no /program/ link in rows), soft-404 detection
(/course-not-in-calendar), cross-listed courses, breadth lists and official credit fields.
"""
from .base import ROOT, Campus, frozen_map

UTSG = Campus(
    id='UTSG',
    name='University of Toronto St. George',
    status='planned',
    data_dir='utsg',
    campus_digit='1',
    base_url='https://artsci.calendar.utoronto.ca',
    course_search_path='/search-courses',
    program_search_path='/search-programs',
    course_page_template='https://artsci.calendar.utoronto.ca/course/{slug}',
    program_page_template='https://artsci.calendar.utoronto.ca/program/{slug}',
    # Per-campus generation state, so a UTSG --refresh never invalidates the UTM generation.
    cache_dir=ROOT / '.cache' / 'calendar' / 'utsg',
    supplementary_dir=ROOT / '.cache' / 'supplementary' / 'utsg',
    directory_header_selector='h3.js-views-accordion-group-header',
    # Headers read 'CODE - Title'; split on the first separator only. Digit 0 = off-campus.
    directory_course_re=r'([A-Z]{3}\d{3}[HY][01])\s*[-•·]\s*(.*)',
    program_link_selector='a[href*="/program/"]',
    pager_selector='nav.pager a[href]',
    page_title_marker='page-title',
    # Arts & Science writes '2026-27'.
    year_heading_re=r'(20\d{2})\s*[-–]\s*((?:20)?\d{2})\b',
    supporting_slugs=('understanding-courses', 'how-use-calendar'),
    title_selector='h1.page-title',
    course_article_selector='article.node--type-courses',
    program_article_selector='article.node--type-programs',
    title_separators=' :•·-',
    post_code_re=r'AS[A-Z]+\d+[A-Z]?',
    course_fields=frozen_map(
        prerequisites='field-prerequisite',
        corequisites='field-corequisite',
        recommended='field-recommended',
        notes='field-note',
        description='body',
        exclusions='field-exclusion',
        restrictions='field-enrolment-limits',
        distribution='field-breadth-requirements',
        courseExperience='field-course-experience',
    ),
    program_fields=frozen_map(
        code='field-post-code',
        admission='field-enrolment-requirements',
        completion='field-completion-requirements',
        description='body',
        notes='field-program-note',
    ),
    route_cue_re=r'\b(?:co-?op|stream|option|focus)\b',
    cohort_cue_re=r'(?:for students|students who|students entering|admitted|entry|entering).*(?:20\d\d|CMP1)',
    seed_slugs=('understanding-courses', 'how-use-calendar', 'understanding-programs-and-certificates'),
    nav_rule_words_re=r'listing of program|program and policy changes',
)
