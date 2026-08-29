import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
/* site.css imports styles/theme.css, which carries Archivo and IBM Plex Mono —
   the only two faces on the site. The landing page used to load Fraunces on top
   of them for its headline; it now sets that headline in Archivo at the top of
   the weight axis, so there is no third font to fetch. */
import './site.css'
import App from './App'
import { captureTokenFromUrl } from './api'

captureTokenFromUrl()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
