// A stand-in orchestrator for the dictation suite: no Gemini. A DICTATION's
// text is returned as the code itself; the frontend plays it with
// @noprod/pattern, as it does the real orchestrator's code.
import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({ port: 8080 });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'AUDIO_CORE_STATUS', connected: false }));
  ws.on('message', (raw) => {
    const data = JSON.parse(raw);
    if (data.type !== 'DICTATION') return;
    ws.send(JSON.stringify({ type: 'GENERATED', code: data.text }));
  });
});
console.log('fake orchestrator on 8080');
