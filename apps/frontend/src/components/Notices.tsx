import { useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { dismissNotice, getNotices, subscribeNotices } from '../notify';

export default function Notices() {
  const notices = useSyncExternalStore(subscribeNotices, getNotices);
  if (!notices.length) return null;
  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`notice notice-${n.kind}`}>
          <span>{n.message}</span>
          <button className="btn-icon" title="Dismiss" onClick={() => dismissNotice(n.id)}><X size={12} /></button>
        </div>
      ))}
    </div>
  );
}
