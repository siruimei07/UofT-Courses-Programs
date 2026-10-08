// Panel body motion (design-spec 17): the content fades in over 120 ms when the panel expands from
// the rail, never on a tab switch (no slide), and not at all under prefers-reduced-motion.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(process.cwd(), 'src', 'ui', 'panels', 'panels.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Text inside the block opened by `head` (braces matched), or null. */
function block(source: string, head: string): string | null {
  const at = source.indexOf(head)
  if (at < 0) return null
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i)
  }
  return null
}

const REDUCED = '@media (prefers-reduced-motion: reduce)'
const reduced = block(css, REDUCED) ?? ''
const outside = css.replace(`${REDUCED} {${reduced}}`, '')
/** Innermost rules as [selector, declarations]. */
const rules = (source: string) => [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => [match[1].trim(), match[2]] as const)
const ENTER = ".rp-card[data-motion='enter'] > .rp-card-inner"

describe('panel expand fade', () => {
  it('fades the card content in over 120 ms, only under the expand marker', () => {
    const animated = rules(outside).filter(([, body]) => /\banimation\s*:/.test(body))
    expect(animated.map(([selector]) => selector)).toEqual([ENTER])
    expect(animated[0][1]).toMatch(/animation:\s*rp-enter\s+120ms\b/)
    const keyframes = block(css, '@keyframes rp-enter') ?? ''
    expect(keyframes).toMatch(/from\s*\{\s*opacity:\s*0;?\s*\}/)
    expect(keyframes).toMatch(/to\s*\{\s*opacity:\s*1;?\s*\}/)
  })

  it('never animates a tab switch: no animation, transition or transform on the tabs and bodies', () => {
    const tabRules = rules(outside).filter(([selector]) => /\.rp-(body|tab|tabs|tablist)\b/.test(selector))
    expect(tabRules.length).toBeGreaterThan(0)
    for (const [selector, body] of tabRules) expect(body, selector).not.toMatch(/\b(animation|transition|transform)\s*:/)
  })

  it('turns the fade and every other panel transition off under prefers-reduced-motion', () => {
    expect(reduced).not.toBe('')
    const off = new Map(rules(reduced))
    expect(off.get(ENTER)).toMatch(/animation:\s*none/)
    for (const [selector, body] of rules(outside)) {
      if (/\btransition\s*:/.test(body)) expect(off.get(selector), selector).toMatch(/transition:\s*none/)
    }
  })
})
