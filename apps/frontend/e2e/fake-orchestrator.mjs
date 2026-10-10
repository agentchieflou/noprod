// A stand-in orchestrator for the dictation suite: the real Sequencer, no
// Gemini. A DICTATION's text is used as the Strudel code itself.
import { WebSocketServer, WebSocket } from 'ws';
const wss = new WebSocketServer({ port: 8080 });
const frontends = new Set();
let seq;
(function connect() {
  seq = new WebSocket('ws://localhost:8081');
  seq.on('message', (d) => { const m = d.toString(); console.log('seq:', m.slice(0, 160)); for (const c of frontends) c.send(m); });
  seq.on('close', () => setTimeout(connect, 1000));
  seq.on('error', () => {});
})();
wss.on('connection', (ws) => {
  frontends.add(ws);
  ws.send(JSON.stringify({ type: 'AUDIO_CORE_STATUS', connected: false }));
  ws.on('message', (raw) => {
    const data = JSON.parse(raw);
    if (data.type !== 'DICTATION') return;
    ws.send(JSON.stringify({ type: 'GENERATED', code: data.text }));
    seq.send(JSON.stringify({ type: 'EVAL', code: data.text }));
  });
  ws.on('close', () => frontends.delete(ws));
});
console.log('fake orchestrator on 8080');
