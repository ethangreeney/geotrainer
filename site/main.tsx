import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/fraunces/standard.css'
import '@fontsource-variable/fraunces/standard-italic.css'
import '@fontsource-variable/inter'
import './site.css'
import App from './App'
import { captureTokenFromUrl } from './api'

captureTokenFromUrl()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
