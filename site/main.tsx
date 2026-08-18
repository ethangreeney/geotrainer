import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
/* site.css imports styles/theme.css, which carries the faces. */
import './site.css'
import App from './App'
import { captureTokenFromUrl } from './api'

captureTokenFromUrl()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
