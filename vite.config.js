import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves project sites at username.github.io/repo-name/, not at
// the root — without `base` set, all asset links (JS/CSS) would 404 because
// they'd be requested from the root instead of under /30a-surf-report/.
export default defineConfig({
  plugins: [react()],
  base: '/30a-surf-report/',
})
