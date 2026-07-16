import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8080');

ws.on('open', () => {
  console.log('Connected to Orchestrator (simulating Frontend). Sending DICTATION command...');
  ws.send(JSON.stringify({
    type: 'DICTATION',
    text: 'make a simple hi-hat rhythm at 120 cpm'
  }));
});

ws.on('message', (data) => {
  console.log('Received response from Orchestrator:');
  console.log(data.toString());
});

ws.on('error', (err) => {
  console.error('WebSocket Error:', err);
});
