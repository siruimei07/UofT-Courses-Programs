// Keeps <html lang> in step with the UI language (design-spec 12): 'en' or 'zh-CN'. tokens.css
// switches the font stacks on :root[lang="zh-CN"].
import { appStore, type Lang } from './store'

export function htmlLang(lang: Lang): 'en' | 'zh-CN' {
  return lang === 'zh' ? 'zh-CN' : 'en'
}

export function startLangSync(): () => void {
  const apply = () => {
    const lang = htmlLang(appStore.get().lang)
    if (document.documentElement.lang !== lang) document.documentElement.lang = lang
  }
  apply()
  return appStore.subscribe(apply)
}
