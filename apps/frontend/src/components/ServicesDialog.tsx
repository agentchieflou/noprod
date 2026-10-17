import { useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { getServices, subscribeServices, setService, isWebSocketUrl, setServicesDialogOpen, type ServiceName } from '../native/services';
import { getOrchestratorStatus, subscribeOrchestrator, type ConnectionStatus } from '../native/orchestrator';
import { getAudioCore, subscribeAudioCore } from '../native/audioCore';

const STATUS_TEXT: Record<ConnectionStatus, string> = { off: '○ off', trying: '◌ trying to connect…', connected: '● connected' };

function ServiceRow({ name, title, blurb, addressLabel, status }: {
  name: ServiceName; title: string; blurb: string; addressLabel: string; status: ConnectionStatus;
}) {
  const setting = useSyncExternalStore(subscribeServices, getServices)[name];
  const [invalid, setInvalid] = useState(false);

  return (
    <div className="service-row" data-service={name}>
      <label className="service-head">
        <input type="checkbox" checked={setting.enabled} onChange={(e) => setService(name, { enabled: e.target.checked })} />
        <b>{title}</b>
        <span className={`native-status ${status === 'connected' ? 'online' : ''}`} data-status={status}>{STATUS_TEXT[status]}</span>
      </label>
      <p className="native-hint">{blurb}</p>
      <label className="service-address">
        {addressLabel}
        <input
          key={setting.url} className="vst-path-input" defaultValue={setting.url} spellCheck={false}
          style={invalid ? { borderColor: 'var(--accent-red)' } : undefined}
          onChange={(e) => setInvalid(!isWebSocketUrl(e.target.value.trim()))}
          onBlur={(e) => {
            if (isWebSocketUrl(e.target.value.trim())) setService(name, { url: e.target.value });
            else e.target.value = setting.url;
            setInvalid(false);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </label>
    </div>
  );
}

// Local services are opt-in: nothing connects until it is turned on here
export default function ServicesDialog() {
  const services = useSyncExternalStore(subscribeServices, getServices);
  const orchestrator = useSyncExternalStore(subscribeOrchestrator, getOrchestratorStatus);
  const audioCore = useSyncExternalStore(subscribeAudioCore, getAudioCore);
  const ghostdaw: ConnectionStatus = !services.ghostdaw.enabled ? 'off' : audioCore.connected ? 'connected' : 'trying';

  return (
    <div className="midi-map-dialog services-dialog" role="dialog" aria-label="Services">
      <div className="midi-map-head">
        <b>Services</b>
        <button className="btn-icon" title="Close" onClick={() => setServicesDialogOpen(false)}><X size={12} /></button>
      </div>
      <p className="native-hint">Programs running on this computer that noprod can use. They're off until you turn them on, and the choice is kept in this browser.</p>
      <ServiceRow
        name="ghostdaw" title="GhostDAW" status={ghostdaw} addressLabel="Audio stream address"
        blurb="A companion app that runs VST3 and other native plug-ins for noprod. Its plug-in panel also connects through the AI dictation address below."
      />
      <ServiceRow
        name="dictation" title="AI dictation" status={orchestrator === 'off' || !services.dictation.enabled ? 'off' : orchestrator} addressLabel="Orchestrator address"
        blurb="Describe a beat or melody in words and get tracks. Needs the orchestrator and sequencer running."
      />
    </div>
  );
}
