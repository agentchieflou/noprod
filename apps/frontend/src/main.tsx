import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initEngine } from './audio/engine'
import { initTransport } from './audio/transport'
import { initSession } from './audio/session'
import { initLiveMidi } from './audio/inputs'
import { useDAWStore } from './store/useDAWStore'

// The audio engine registers its worklets before the first render so device
// chains are fully built by the time the UI can touch them.
initTransport(useDAWStore)
initSession(useDAWStore)
initLiveMidi(useDAWStore)
initEngine(useDAWStore).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
