import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { ToastProvider } from './components/Toast'
import AppLayout from './layouts/AppLayout'
import CharacterSelect from './pages/CharacterSelect'
import Chat from './pages/Chat'
import Config from './pages/Config'
import Memory from './pages/Memory'
import Overview from './pages/Overview'
import Plugins from './pages/Plugins'
import Settings from './pages/Settings'
import Setup from './pages/Setup'
import Timeline from './pages/Timeline'
import TracePage from './pages/TracePage'
import { useAsync } from './hooks/useAsync'
import { runtime } from './services/runtime'
import { Notice } from './components/Connection'
import { Spinner } from './components/ui'
function GlobalTool({ sub }: { sub?: string }) {
  const params = useParams()
  const target = sub || params.sub || 'overview'
  const registry = useAsync(() => runtime.registry(), [], undefined)
  if (registry.error) return <Notice>{registry.error}</Notice>
  if (!registry.data) return <Spinner />
  return <Navigate to={`/characters/${registry.data.selection.effectiveCharacterId}/${target}`} replace />
}

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/characters" replace />} />
        {/* LUI-01/LUI-06: first-run setup. Served by this same SPA in `mode === 'setup'`, so it is a
            top-level route with no AppLayout — there is no character registry to put in a sidebar. */}
        <Route path="/setup" element={<Setup />} />
        <Route path="/characters" element={<CharacterSelect />} />
        <Route path="/current/:sub" element={<GlobalTool />} />

        {/* Character Workspace：固定 Sidebar（RPD §9、§13） */}
        <Route path="/characters/:characterId" element={<AppLayout />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<Overview />} />
          <Route path="timeline" element={<Timeline />} />
          <Route path="memory" element={<Memory />} />
          <Route path="config" element={<Config />} />
          <Route path="chat" element={<Chat />} />
          <Route path="trace" element={<TracePage />} />
          <Route path="plugins" element={<Plugins />} />
        </Route>

        {/* 全局工具页（无角色上下文时回到角色选择） */}
        <Route path="/chat" element={<GlobalTool sub="chat" />} />
        <Route path="/trace" element={<GlobalTool sub="trace" />} />
        <Route path="/plugins" element={<GlobalTool sub="plugins" />} />
        <Route path="/settings" element={<Settings />} />

        <Route path="*" element={<Navigate to="/characters" replace />} />
      </Routes>
    </ToastProvider>
  )
}
