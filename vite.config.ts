import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Relative base so the build works from any folder (including the claude.ai preview).
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
})
