import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { desktopBridge } from './lib/desktop'
import './styles.css'

function DesktopBridgeUnavailable(): React.JSX.Element {
  return (
    <main
      className="loading-screen loading-error"
      role="alert"
      aria-live="assertive"
      aria-labelledby="bridge-unavailable-title"
      aria-describedby="bridge-unavailable-detail"
    >
      <div className="brand-mark large" aria-hidden="true">
        <span />
        <span />
      </div>
      <h1 id="bridge-unavailable-title">Desktop connection unavailable</h1>
      <p id="bridge-unavailable-detail">
        Ground could not connect to its secure desktop bridge, so the workspace
        was not opened. Close and reopen the desktop app. If this continues,
        reinstall Ground from a trusted build.
      </p>
    </main>
  )
}

const application =
  desktopBridge.status === 'ready' ? (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  ) : (
    <DesktopBridgeUnavailable />
  )

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {application}
  </StrictMode>
)
