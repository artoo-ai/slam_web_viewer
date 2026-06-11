import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './lib/transport/connection' // boot the WebSocket singleton once
import { bootTts } from './lib/tts/ttsManager'
import App from './app/App'

bootTts()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
