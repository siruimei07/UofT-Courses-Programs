// Footer disclaimer (design-spec 6.8) with the official calendar link from the campus registry.
import { academicYearLabel, formatFetchDate } from '../app/format'
import { useApp } from '../app/store'
import type { CampusEntry, GraphDataset } from '../data/schema'
import { format, useStrings } from '../i18n'
import { commonStrings, footerStrings } from './strings'

export function Footer({ campus, dataset }: { campus: CampusEntry | null; dataset: GraphDataset | null }) {
  const t = useStrings(footerStrings)
  const common = useStrings(commonStrings)
  const lang = useApp(state => state.lang)
  const name = campus?.shortName ?? 'UTM'
  const year = academicYearLabel(campus?.academicYear ?? dataset?.academicYear ?? '')
  return (
    <footer className="footer">
      <p>
        {t.before}
        <a href={campus?.calendarUrl ?? dataset?.sources.calendar ?? '#'} target="_blank" rel="noopener">
          {format(t.link, { campus: name })} ↗<span className="sr-only"> {common.opensNewTab}</span>
        </a>
        {dataset && year ? format(t.after, { year, date: formatFetchDate(dataset.fetchedAt, lang) }) : t.afterShort}
      </p>
    </footer>
  )
}
