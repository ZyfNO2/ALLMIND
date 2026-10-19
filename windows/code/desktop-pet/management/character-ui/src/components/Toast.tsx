import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { CheckCircle2 } from 'lucide-react'

interface ToastItem {
  id: number
  text: string
}

const ToastContext = createContext<(text: string) => void>(() => {})

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const push = useCallback((text: string) => {
    const id = Date.now() + Math.random()
    setItems((prev) => [...prev, { id, text }])
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id))
    }, 2400)
  }, [])

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-6 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className="animate-fade-in flex items-center gap-2 rounded-2xl bg-ink-900/90 px-5 py-3 text-sm text-white shadow-soft backdrop-blur"
          >
            <CheckCircle2 size={16} className="text-emerald-300" />
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
