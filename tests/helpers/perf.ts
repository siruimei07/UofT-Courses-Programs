// Timing budgets (design-spec 16.1) are tuned on the Windows development machine. Shared CI
// runners are slower and noisier, so budgets scale by PERF_SLACK (default 4 on CI, 1 locally).
export const PERF_SLACK = Number(process.env.PERF_SLACK ?? (process.env.CI ? 4 : 1))

export function budget(ms: number): number {
  return ms * PERF_SLACK
}
