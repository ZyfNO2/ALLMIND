import {useEffect,useState} from 'react'
type Theme='auto'|'light'|'dark'
const labels={auto:'跟随系统',light:'浅色',dark:'深色'}
function readTheme():Theme{const saved=localStorage.getItem('aiki-theme');return saved==='light'||saved==='dark'?saved:'auto'}
// Applied by the app root as well as the settings control, so refresh on Home respects the preference.
export function useAppTheme(){
 const [theme,setTheme]=useState<Theme>(readTheme)
 useEffect(()=>{
  const media=matchMedia('(prefers-color-scheme: dark)')
  const apply=()=>{const next=readTheme();setTheme(next);document.documentElement.dataset.theme=next==='auto'?media.matches?'dark':'light':next}
  apply();media.addEventListener('change',apply);window.addEventListener('allmind-theme-change',apply);window.addEventListener('storage',apply)
  return()=>{media.removeEventListener('change',apply);window.removeEventListener('allmind-theme-change',apply);window.removeEventListener('storage',apply)}
 },[])
 return theme
}
export default function ThemeToggle(){
 const theme=useAppTheme()
 function cycle(){const next=theme==='auto'?'light':theme==='light'?'dark':'auto';if(next==='auto')localStorage.removeItem('aiki-theme');else localStorage.setItem('aiki-theme',next);window.dispatchEvent(new Event('allmind-theme-change'))}
 return <button type="button" className="mb-theme-toggle" onClick={cycle}>外观：{labels[theme]}</button>
}
