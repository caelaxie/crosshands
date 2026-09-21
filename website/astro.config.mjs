import { defineConfig } from 'astro/config'

export default defineConfig({
  output: 'static',
  vite: {
    // pnpm does not hoist cookie; the prerender entry would otherwise load $HOME/node_modules/cookie.
    resolve: {
      noExternal: true
    }
  }
})
