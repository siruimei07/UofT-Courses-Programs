import { AxeBuilder } from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('desktop graph and profile have no detected WCAG A/AA violations', async ({ page }) => {
  await page.goto('./')
  await expect(page.locator('.react-flow__node-course').first()).toBeVisible()
  const graph = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(graph.violations).toEqual([])
  await page.getByRole('button', { name: '我的档案', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '我的修读档案' })).toBeVisible()
  const profile = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(profile.violations).toEqual([])
})

test('mobile list and course detail have no detected WCAG A/AA violations', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('./')
  await expect(page.locator('.course-list-row').first()).toBeVisible()
  const list = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(list.violations).toEqual([])
  await page.locator('.course-list-row').first().click()
  await expect(page.getByRole('complementary', { name: '课程详情' })).toBeVisible()
  const detail = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(detail.violations).toEqual([])
})
