import { useStore } from '../store/gatewayStore';
import { MemoryGalaxy } from './MemoryGalaxy';
import { ApprovalsInbox } from './ApprovalsInbox';

/**
 * Main-pane mount for Studio Dock apps.
 * `route` apps render an internal React view keyed by id; `iframe` apps
 * mount a sandboxed iframe pointed at the app's own loopback URL — the
 * gateway never proxies that traffic (browser talks to the app's port
 * directly), so this component's only job for iframe apps is the sandboxed
 * mount itself.
 */
export function DockView({ appId }: { appId: string }) {
  const dockApps = useStore((s) => s.dockApps);
  const setActiveDockAppId = useStore((s) => s.setActiveDockAppId);
  const app = dockApps.find((a) => a.id === appId);

  if (!app) {
    return (
      <div className="dock-view dock-view-unknown">
        <div className="empty-hint">Unknown dock app: {appId}</div>
      </div>
    );
  }

  if (app.kind === 'route') {
    switch (app.id) {
      case 'memory-galaxy':
        return <MemoryGalaxy />;
      case 'approvals-inbox':
        return <ApprovalsInbox />;
      default:
        return (
          <div className="dock-view dock-view-unknown">
            <div className="empty-hint">No view registered for route app: {app.id}</div>
          </div>
        );
    }
  }

  // kind === 'iframe'. url is loopback-validated gateway-side (dockApps.ts);
  // nothing here trusts a URL the gateway itself rejected.
  return (
    <div className="dock-view dock-view-iframe">
      <div className="dock-view-iframe-hdr">
        <span className="dock-view-iframe-label">{app.label}</span>
        <button type="button" className="cbtn" onClick={() => setActiveDockAppId(null)} title="Back to rooms">
          ← Rooms
        </button>
      </div>
      {app.url ? (
        <iframe
          className="dock-view-iframe-frame"
          src={app.url}
          title={app.label}
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      ) : (
        <div className="empty-hint">No URL configured for {app.label}.</div>
      )}
    </div>
  );
}
