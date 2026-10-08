"""Official calendar collector and requirement parser (backend data pipeline).

Run it as a package from the repository root: ``python -I pipeline --campus utm --parse-only``
(``npm run data:collect``), or ``python -I pipeline supporting ...`` for supporting sources.
``python -I -m pipeline.<module>`` cannot work (see ``__main__.py``); without ``-I``,
``python -m pipeline.collect_calendar ...`` is equivalent.
"""
