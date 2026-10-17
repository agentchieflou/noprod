import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { dictationSystemPrompt, generateDictation } from '@noprod/pattern';

// Load environment variables
dotenv.config();

// The Orchestrator acts as the brain.
// It exposes a WebSocket server for the frontend to connect to (port 8080).
// It connects to the Audio Core (port 8082 - Ghost DAW C++).
// Dictation: Gemini writes pattern code, which is checked with our own
// pattern engine (@noprod/pattern, #133) and returned to the frontend, which
// plays it itself. Nothing is evaluated as JavaScript anywhere.

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

// Initialize Gemini Client
// Requires GEMINI_API_KEY to be set in environment or .env
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// The names the sound library plays for Strudel patterns
// (packages/sound/src/library/strudel.ts; a test there keeps these in step)
const DRUM_NAMES = ['bd', 'sd', 'rim', 'cp', 'hh', 'oh', 'lt', 'mt', 'ht', 'cr', 'rd', 'cb', 'sh', 'tb', 'perc'];
const SYNTH_NAMES = ['sawtooth', 'square', 'triangle', 'sine', 'supersaw', 'piano', 'epiano', 'organ', 'clav', 'harpsichord', 'bass', 'sub', 'acid', 'reese', 'strings', 'violin', 'viola', 'cello', 'contrabass', 'pizzicato', 'brass', 'trumpet', 'trombone', 'horn', 'flute', 'recorder', 'clarinet', 'choir', 'pad', 'marimba', 'vibraphone', 'glockenspiel', 'kalimba', 'steeldrum', 'musicbox', 'bell', 'harp', 'koto', 'guitar', 'banjo', 'dulcimer', 'pluck', 'chip'];

// The prompt and the check-and-retry live in @noprod/pattern, so a browser
// calling Gemini with the user's own key (#157) uses the same ones
const SYSTEM_PROMPT = dictationSystemPrompt({ drums: DRUM_NAMES, synths: SYNTH_NAMES });

// Asks Gemini; the turns are the conversation so far (the retry carries the
// model's first answer and the parse error)
const askGemini = async (turns) => (await ai.models.generateContent({
  model: 'gemini-flash-latest',
  contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
  config: { systemInstruction: SYSTEM_PROMPT, temperature: 0.7 }
})).text;

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
      
      // Handle user dictation ("make a beat like...")
      if (data.type === 'DICTATION') {
        console.log(`Received dictation: ${data.text}`);
        
        try {
           const { code, error, attempts } = await generateDictation(data.text, askGemini);
           if (error) {
             console.log(`Generated code fails to parse after ${attempts} attempts: ${error}`);
             ws.send(JSON.stringify({ type: 'ERROR', message: `The generated code doesn't parse: ${error}`, code }));
             return;
           }
           console.log(`Generated code: ${code}`);
           // The frontend plays the code with its own pattern engine
           ws.send(JSON.stringify({ type: 'GENERATED', code }));
        } catch (genErr) {
            console.error('Error generating content from Gemini', genErr);
            ws.send(JSON.stringify({ type: 'ERROR', message: genErr.message }));
        }
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
