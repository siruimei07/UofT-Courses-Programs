"""Isolated entry point: ``python -I pipeline [--campus utm] [--parse-only] ...``.

``python -I -m pipeline.<module>`` cannot work: -I implies -P (safe path), so the working
directory is never put on sys.path. Running the folder does put *this* folder first on
sys.path, where pipeline/http.py would shadow the standard library, so swap it for the
repository root before anything imports ``http``. ``python -I pipeline supporting ...`` runs
the supporting-sources collector instead of the calendar collector.
"""
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path[:] = [entry for entry in sys.path if Path(entry or '.').resolve() != HERE]
sys.path.insert(0, str(HERE.parent))

if len(sys.argv) > 1 and sys.argv[1] == 'supporting':
    from pipeline.collect_supporting_sources import main as supporting_main
    raise SystemExit(supporting_main(sys.argv[2:]))

from pipeline.collect_calendar import main  # noqa: E402

main()
