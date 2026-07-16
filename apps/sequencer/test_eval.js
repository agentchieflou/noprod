import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8081');

ws.on('open', () => {
  console.log('Connected to Sequencer. Sending EVAL command...');
  ws.send(JSON.stringify({
    type: 'EVAL',
    code: 's("bd sd")'
  }));
});

ws.on('message', (data) => {
  console.log('Received response from Sequencer:');
  console.log(data.toString());
  ws.close();
});

ws.on('error', (err) => {
  console.error('WebSocket Error:', err);
});
