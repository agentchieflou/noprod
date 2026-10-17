import { WebSocketServer, WebSocket } from 'ws';

// The relay between the frontend and the Audio Core: a WebSocket server for
// the frontend (port 8080) that passes the plug-in commands on to GhostDAW
// (port 8082) and its answers back. It goes away with #134's paired, direct
// connection. (AI dictation is not here: the browser calls its provider with
// the user's own key, #157.)

// Browsers attach an Origin header to WebSocket handshakes, and any web page
// can try ws://localhost. Only accept non-browser clients (no Origin) and
// pages served from this machine, plus any origins listed in
// NOPROD_ALLOWED_ORIGINS (comma-separated).
const extraOrigins = (process.env.NOPROD_ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (extraOrigins.includes(origin)) return true;
  try {
    const { protocol, hostname } = new URL(origin);
    return (protocol === 'http:' || protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}
const verifyClient = ({ origin }) => {
  if (isAllowedOrigin(origin)) return true;
  console.warn(`Rejected WebSocket connection from origin ${origin}`);
  return false;
};

const wss = new WebSocketServer({ port: 8080, verifyClient });
console.log('Orchestrator WebSocket Server listening on port 8080 (Frontend API)');

const frontendClients = new Set();

function broadcastToFrontends(message) {
  for (const client of frontendClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// Frontend messages relayed straight to the Audio Core
const AUDIO_CORE_COMMANDS = new Set([
  'GET_AUDIO_CORE_STATE', 'SCAN_PLUGINS', 'LOAD_PLUGIN', 'REMOVE_PLUGIN', 'MOVE_PLUGIN',
  'SET_PLUGIN_BYPASS', 'SET_PLUGIN_PARAMETER', 'SET_VST_PARAMETER', 'OPEN_EDITOR', 'CLOSE_EDITOR'
]);
const audioCoreConnected = () => !!audioCoreWs && audioCoreWs.readyState === WebSocket.OPEN;

// Connect to Audio Core
let audioCoreWs = null;
function connectToAudioCore() {
  audioCoreWs = new WebSocket('ws://localhost:8082');
  
  audioCoreWs.on('open', () => {
    console.log('Connected to Audio Core');
    broadcastToFrontends(JSON.stringify({ type: 'AUDIO_CORE_STATUS', connected: true }));
    audioCoreWs.send(JSON.stringify({ type: 'GET_AUDIO_CORE_STATE' }));
  });

  // Plugin state, parameter changes and errors go to every frontend
  audioCoreWs.on('message', (data, isBinary) => {
    if (isBinary) return; // nothing binary is expected (plugin editors stream straight from ws://localhost:8085)
    const message = data.toString();
    console.log(`Received from Audio Core: ${message.slice(0, 120)}${message.length > 120 ? '…' : ''}`);
    broadcastToFrontends(message);
  });

  audioCoreWs.on('close', () => {
    console.log('Disconnected from Audio Core, retrying in 3s...');
    broadcastToFrontends(JSON.stringify({ type: 'AUDIO_CORE_STATUS', connected: false }));
    setTimeout(connectToAudioCore, 3000);
  });
  
  audioCoreWs.on('error', (err) => {
    console.error('Audio Core WS error:', err.message);
  });
}
connectToAudioCore();

// Handle Frontend connections
wss.on('connection', (ws) => {
  console.log('Frontend client connected to Orchestrator');
  frontendClients.add(ws);
  ws.send(JSON.stringify({ type: 'AUDIO_CORE_STATUS', connected: audioCoreConnected() }));

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      // Plugin hosting commands are the Audio Core's (apps/audio_core/src/PluginHost.h)
      if (AUDIO_CORE_COMMANDS.has(data.type)) {
        if (audioCoreConnected()) {
          audioCoreWs.send(JSON.stringify(data));
        } else {
          ws.send(JSON.stringify({ type: 'AUDIO_CORE_ERROR', request: data.type, message: 'Audio Core offline' }));
        }
        return;
      }
    } catch (error) {
      console.error('Error processing frontend message', error);
      ws.send(JSON.stringify({ type: 'ERROR', message: error.message }));
    }
  });

  ws.on('close', () => {
    console.log('Frontend client disconnected');
    frontendClients.delete(ws);
  });
});
