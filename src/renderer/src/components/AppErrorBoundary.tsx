import { Component, type ReactNode } from 'react'

interface AppErrorBoundaryProps {
  children: ReactNode
}

interface AppErrorBoundaryState {
  failed: boolean
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true }
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="loading-screen loading-error" role="alert">
        <div className="brand-mark large" aria-hidden="true">
          <span />
          <span />
        </div>
        <h1>Ground hit a display error</h1>
        <p>
          The workspace interface hit an unexpected error. Your saved local tasks
          and workspace files were not deleted.
        </p>
        <button
          type="button"
          onClick={() => this.setState({ failed: false })}
        >
          Try again
        </button>
      </div>
    )
  }
}
