import { useEffect, useState } from 'react'

type Theme = 'auto' | 'light' | 'dark'
const labels = { auto: '跟随系统', light: '浅色', dark: '深色' }
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('aiki-theme')
    return saved === 'light' || saved === 'dark' ? saved : 'auto'
  })
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { document.documentElement.dataset.theme = theme === 'auto' ? media.matches ? 'dark' : 'light' : theme }
    apply(); media.addEventListener('change', apply)
    if (theme === 'auto') localStorage.removeItem('aiki-theme'); else localStorage.setItem('aiki-theme', theme)
    return () => media.removeEventListener('change', apply)
  }, [theme])
  return <button type="button" className="mb-theme-toggle tac-btn w-full justify-between text-xs" onClick={() => setTheme(theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto')}>外观：{labels[theme]}</button>
}
