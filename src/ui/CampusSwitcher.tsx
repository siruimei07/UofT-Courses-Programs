// Campus segmented control (design-spec 6.2 item 2). Segments come from the campus registry;
// planned campuses render disabled with a "Soon" badge and a tooltip.
import { selectCampus } from '../app/useCampusData'
import type { CampusId, CampusRegistry } from '../data/schema'
import { format, useStrings } from '../i18n'
import { Segmented, type SegmentOption } from './Segmented'
import { campusNames, headerStrings } from './strings'

export function CampusSwitcher({ registry, current }: { registry: CampusRegistry | null; current: CampusId }) {
  const t = useStrings(headerStrings)
  const names = useStrings(campusNames)
  const campuses = registry?.campuses ?? []
  if (!campuses.length) return null

  const options: SegmentOption<CampusId>[] = campuses.map(entry => {
    const planned = entry.status !== 'available'
    return {
      value: entry.id,
      disabled: planned,
      title: planned ? format(t.campusPlanned, { name: names[entry.id] ?? entry.shortName }) : entry.name,
      label: planned
        ? <><span lang="en">{entry.shortName}</span><span className="soon">{t.soon}</span></>
        : <span lang="en">{entry.shortName}</span>,
    }
  })

  const onChange = (id: CampusId) => {
    const entry = campuses.find(campus => campus.id === id)
    if (entry) selectCampus(entry)
  }

  return <Segmented className="seg-campus" label={t.campus} value={current} options={options} onChange={onChange} />
}
