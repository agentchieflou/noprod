// A stand-in for the orchestrator's GhostDAW relay, for the services suite:
// it accepts connections and reports GhostDAW as not running.
import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({ port: 8080 });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'AUDIO_CORE_STATUS', connected: false }));
});
console.log('fake orchestrator on 8080');
