import { useSyncExternalStore } from 'react';
import { subscribeNativeConsent, getPendingNativeLoad, answerNativeLoad } from '../native/consent';

// Opening a project that wants native plug-ins asks before GhostDAW loads them
export default function NativeConsentDialog() {
  const pending = useSyncExternalStore(subscribeNativeConsent, getPendingNativeLoad);
  if (!pending) return null;
  return (
    <div className="midi-map-dialog native-consent" role="dialog" aria-label="Load native plug-ins?" style={{ width: 460 }}>
      <b>Load native plug-ins?</b>
      <p className="native-hint">
        “{pending.project}” wants GhostDAW to load these plug-ins from your computer. Plug-ins are programs, so load them only from projects you trust.
      </p>
      <ul className="native-consent-list">
        {pending.plugins.map((p) => <li key={p.path}><b>{p.name}</b> <span className="native-hint">{p.path}</span></li>)}
      </ul>
      <div className="native-row">
        <button className="btn-add-track" onClick={() => answerNativeLoad(true)}>Load them</button>
        <button className="btn-add-track" onClick={() => answerNativeLoad(false)}>Don't load</button>
      </div>
    </div>
  );
}
