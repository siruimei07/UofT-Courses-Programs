// Contract between the app shell and the side panels (src/ui/panels/*). Panels read and write
// selection, program and student record through src/app/store.ts; the shell decides which panel
// is visible from `state.panel` and passes the loaded campus context.
import type { CampusEntry, GraphDataset } from '../../data/schema'
import type { CourseEngine } from '../../domain/engine-types'
import type { Topology } from '../../graph/types'

export interface PanelProps {
  campus: CampusEntry
  dataset: GraphDataset
  topology: Topology
  engine: CourseEngine
  /** Ask the graph to scroll a course into view (does not change the selection). */
  onCenter(courseId: string): void
  /** Close the panel (the shell also clears focus for the course panel). */
  onClose(): void
}

// Components exported by the panels module (one file each):
//   RightPanel(props: PanelProps)    host mounted by the shell: tabs Course / Program / My courses
//                                    (state.panel), collapsible to a 48 px rail
//                                    (state.panelCollapsed); renders the three panels below
//   CoursePanel(props: PanelProps)   details of state.focusId: credits, level, distribution,
//                                    description (lazy details.json), requirement trees with
//                                    met/unmet/unknown for the student record, exclusions,
//                                    recommended preparation, unlocks, official link, record
//                                    controls (not taken / planned / in progress / completed
//                                    + optional grade)
//   ProgramPanel(props: PanelProps)  program picker (search, type filter) when none selected;
//                                    otherwise requirement groups with progress, "take next"
//                                    list, official link, clear
//   RecordPanel(props: PanelProps)   "My courses": record list grouped by status, remove,
//                                    import/export JSON (src/app/persist.ts helpers), clear all
