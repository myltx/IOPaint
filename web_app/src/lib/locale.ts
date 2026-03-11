export type AppLocale = "zh-CN" | "en-US"

const LOCALE_STORAGE_KEY = "iopaint.locale"

export function normalizeLocale(raw: string | null | undefined): AppLocale {
  if (!raw) {
    return "zh-CN"
  }
  const value = raw.toLowerCase()
  if (value.startsWith("zh")) {
    return "zh-CN"
  }
  return "en-US"
}

export function getPreferredLocale(): AppLocale {
  if (typeof window === "undefined") {
    return "zh-CN"
  }
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
  if (stored) {
    return normalizeLocale(stored)
  }
  return normalizeLocale(window.navigator.language)
}

export function setPreferredLocale(locale: AppLocale) {
  if (typeof window === "undefined") {
    return
  }
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
}

export function t(locale: AppLocale, zhCN: string, enUS: string) {
  return locale === "zh-CN" ? zhCN : enUS
}
