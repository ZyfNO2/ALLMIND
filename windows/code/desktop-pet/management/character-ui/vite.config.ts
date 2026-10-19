import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  base: '/',
  // LUI-07: the compiled SPA no longer lives inside the retired `management/ui/` directory. It is the
  // only management shell, so it gets its own root that survives the legacy deletion.
  build: { outDir: '../character-app', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5217 },
})
