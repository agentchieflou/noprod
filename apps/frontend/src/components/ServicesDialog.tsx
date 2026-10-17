import { useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { getServices, subscribeServices, setService, isWebSocketUrl, setServicesDialogOpen, type ServiceName } from '../native/services';
import { getAudioCore, subscribeAudioCore } from '../native/audioCore';

type RowStatus = 'off' | 'trying' | 'connected' | 'unpaired';
const STATUS_TEXT: Record<RowStatus, string> = { off: '○ off', trying: '◌ trying to connect…', connected: '● connected', unpaired: '○ not paired' };

function ServiceRow({ name, title, blurb, addressLabel, status }: {
  name: ServiceName; title: string; blurb: string; addressLabel: string; status: RowStatus;
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
  const audioCore = useSyncExternalStore(subscribeAudioCore, getAudioCore);
  const ghostdaw: RowStatus = !services.ghostdaw.enabled ? 'off' : audioCore.connected ? 'connected' : audioCore.needsPairing ? 'unpaired' : 'trying';

  return (
    <div className="midi-map-dialog services-dialog" role="dialog" aria-label="Services">
      <div className="midi-map-head">
        <b>Services</b>
        <button className="btn-icon" title="Close" onClick={() => setServicesDialogOpen(false)}><X size={12} /></button>
      </div>
      <p className="native-hint">Programs running on this computer that noprod can use. They're off until you turn them on, and the choice is kept in this browser.</p>
      <ServiceRow
        name="ghostdaw" title="GhostDAW" status={ghostdaw} addressLabel="GhostDAW address"
        blurb="A companion app that runs VST3, AU and LPI plug-ins for noprod. Pair this browser with it once, in the VST Folders Scan tab, with the code it prints at launch."
      />
    </div>
  );
}
