// Language and theme preferences (design-spec 3.1, 13, 14): UI strings switch, official text never
// does, and both choices persist in uoft-course-map:prefs:v1.
import { courseStrip, expect, mapRegion, openApp, searchBox, snap, storedPrefs, test, waitForCanvasIdle, waitForMap } from './fixtures'

test('中文 switches UI strings but not course titles, and persists', async ({ page }, testInfo) => {
  await openApp(page, '#/utm?course=CSC148H5')
  await page.getByRole('radiogroup', { name: 'Language' }).getByRole('radio', { name: '中文' }).click()

  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByRole('heading', { name: '先修关系图' })).toBeVisible()
  await expect(searchBox(page)).toHaveAttribute('placeholder', '搜索课程或专业')
  await expect(page.getByRole('tab', { name: '课程', exact: true })).toBeVisible()
  await expect(page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '深色' })).toBeVisible()
  const strip = courseStrip(page)
  await expect(strip).toContainText('直接先修 1 门 · 共 1 门')
  await expect(page.getByRole('contentinfo')).toContainText('非官方规划工具')

  // Official text stays English: course codes, titles and subject names.
  await expect(strip).toContainText('Introduction to Computer Science')
  const tab = page.getByRole('tabpanel', { name: '课程', exact: true })
  await expect(tab.getByRole('heading', { level: 2 })).toHaveText('Introduction to Computer Science')
  await expect(tab.getByRole('heading', { level: 2 })).toHaveAttribute('lang', 'en')
  await expect(mapRegion(page).locator('.gc-lane-name', { hasText: /^Computer Science$/ })).toHaveCount(1)
  await expect(mapRegion(page)).toHaveAccessibleName('先修关系图，共 2,491 门课程。方向键在课程间移动，回车键选择。')

  expect((await storedPrefs(page)).lang).toBe('zh')
  await waitForCanvasIdle(page)
  await snap(page, testInfo, 'zh')

  await page.reload()
  await waitForMap(page)
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByRole('heading', { name: '先修关系图' })).toBeVisible()
  await expect(courseStrip(page)).toContainText('Introduction to Computer Science')

  // And back.
  await page.getByRole('radiogroup', { name: '语言' }).getByRole('radio', { name: 'English' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { name: 'Prerequisite map' })).toBeVisible()
  expect((await storedPrefs(page)).lang).toBe('en')
})

test('the theme control switches to dark and persists', async ({ page }, testInfo) => {
  await openApp(page, '#/utm?course=CSC148H5')
  const theme = page.getByRole('radiogroup', { name: 'Theme' })
  await expect(theme.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)

  await theme.getByRole('radio', { name: 'Dark' }).click()
  await expect(theme.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // The page background fades over 150 ms (app.css), so poll until it has settled dark.
  const luminance = () => page.evaluate(() => {
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g)!.map(Number)
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  })
  await expect.poll(luminance).toBeLessThan(0.15)
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(lightBackground)
  expect((await storedPrefs(page)).theme).toBe('dark')
  await waitForCanvasIdle(page)
  await snap(page, testInfo, 'dark')

  await page.reload()
  await waitForMap(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
})

test('arrow keys move within the segmented controls', async ({ page }) => {
  await openApp(page)
  const theme = page.getByRole('radiogroup', { name: 'Theme' })
  await theme.getByRole('radio', { name: 'System' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(theme.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
  await expect(theme.getByRole('radio', { name: 'Light' })).toBeFocused()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})
