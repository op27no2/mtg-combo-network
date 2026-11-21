import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths, so the built site works at a domain root and under a sub-path
  // alike (GitHub Pages serves it from /<repo-name>/)
  base: './',
})
