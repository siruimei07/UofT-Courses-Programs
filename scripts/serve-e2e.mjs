import { build, preview } from 'vite'

process.env.BASE_PATH = '/utm-atlas-test/'
await build()
await preview({ preview: { host: '127.0.0.1', port: 4173, strictPort: true } })
