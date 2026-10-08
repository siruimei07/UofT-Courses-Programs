import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { startLangSync } from './app/lang'
import { startPersistence } from './app/persist'
import { startThemeSync } from './app/theme'
import './ui/tokens.css'
import './ui/app.css'

// Stored preferences and the record load before the first render; theme and language follow the
// store from then on. URL sync starts once the campus data has loaded (App).
startPersistence()
startThemeSync()
startLangSync()

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
