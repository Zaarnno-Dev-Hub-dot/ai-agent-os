import { Component, useEffect, type ReactNode } from 'react';
import { useStore } from './store/gatewayStore';
import { useVoiceStore } from './store/voiceStore';
import { useGatewayConnection } from './store/useGatewayConnection';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { DockView } from './components/DockView';
import { InspectPanel } from './components/InspectPanel';
import { FilesRail } from './components/FilesRail';
import { MemoryRail } from './components/MemoryRail';
import { PollsRail } from './components/PollsRail';

/** Toast for gateway `error` events (e.g. rejected room mutations) — rejections must be visible. */
function ErrorToast() {
  const errorToast = useStore((s) => s.errorToast);
  const dismissErrorToast = useStore((s) => s.dismissErrorToast);

  useEffect(() => {
    if (!errorToast) return;
    const timer = setTimeout(dismissErrorToast, 6000);
    return () => clearTimeout(timer);
  }, [errorToast, dismissErrorToast]);

  if (!errorToast) return null;
  return (
    <div className="error-toast" role="alert">
      <b>{errorToast.code}</b> {errorToast.message}
      <button type="button" className="error-toast-x" onClick={dismissErrorToast} title="Dismiss">
        ✕
      </button>
    </div>
  );
}

/**
 * A crash in any panel must degrade to a visible error card, never a blank
 * page (live incident 2026-07-06: an InspectPanel hooks bug unmounted the
 * entire app). Each major panel gets its own boundary so the rest of the
 * dashboard keeps working.
 */
class PanelBoundary extends Component<
  { name: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`[ui] ${this.props.name} crashed:`, error);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="panel-crash" role="alert">
          <b>{this.props.name} crashed</b>
          <div className="panel-crash-msg">{String(this.state.error)}</div>
          <button type="button" className="cbtn" onClick={() => this.setState({ error: null })}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  useGatewayConnection();
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const activeDockAppId = useStore((s) => s.activeDockAppId);
  const hydrateVoice = useVoiceStore((s) => s.hydrate);
  const setVoiceTabVisible = useVoiceStore((s) => s.setTabVisible);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === '\\') {
        e.preventDefault();
        toggleSidebar();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar]);

  // Voice v1 (docs/DESIGN-voice-v1.md): pull persisted auto-read rooms +
  // voice/rate settings once at mount (the store starts with hardcoded-safe
  // defaults so it's import-safe in any environment — see voiceStore.ts),
  // then keep tabVisible live for auto-read's visibility gate.
  useEffect(() => {
    hydrateVoice();
  }, [hydrateVoice]);

  useEffect(() => {
    function onVisibilityChange() {
      setVoiceTabVisible(!document.hidden);
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [setVoiceTabVisible]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <TopBar />
      <ErrorToast />
      <div className="main">
        <PanelBoundary name="Sidebar">
          <Sidebar />
        </PanelBoundary>
        <PanelBoundary name={activeDockAppId ? 'Studio Dock' : 'Chat'}>
          {activeDockAppId ? <DockView appId={activeDockAppId} /> : <ChatView />}
        </PanelBoundary>
        <PanelBoundary name="Inspect panel">
          <InspectPanel />
        </PanelBoundary>
        <PanelBoundary name="Files rail">
          <FilesRail />
        </PanelBoundary>
        <PanelBoundary name="Memory rail">
          <MemoryRail />
        </PanelBoundary>
        <PanelBoundary name="Polls rail">
          <PollsRail />
        </PanelBoundary>
      </div>
    </div>
  );
}

export default App;
