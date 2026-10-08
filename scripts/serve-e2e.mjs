import { build, preview } from 'vite'

// Serve the production build under the same subpath GitHub Pages uses.
process.env.BASE_PATH = '/UofT-Courses-Programs/'
await build()
await preview({ preview: { host: '127.0.0.1', port: 4173, strictPort: true } })
