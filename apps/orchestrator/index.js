import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// The Orchestrator acts as the brain.
// It exposes a WebSocket server for the frontend to connect to (port 8080).
// It also connects to the Sequencer (port 8081).
// It connects to the Audio Core (port 8082 - Ghost DAW C++).

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

const SYSTEM_PROMPT = `
You are the dictation engine for the NoProd DAW. Your job is to translate user natural language requests into Strudel patterns.
You MUST output ONLY valid Strudel javascript code.
Do not include markdown blocks, explanations, or any other text.

One cycle is one bar. Set the tempo with setcpm(BPM/4), e.g. setcpm(120/4) for 120 BPM.
Put several parts together with stack(...), one part per line.
Drums: s("...") using only these names: ${DRUM_NAMES.join(', ')}.
Choose a drum machine with .bank("RolandTR808") or .bank("RolandTR909").
Melodies, chords and bass lines: note("c3 e3 g3") with .s(name), name being one of: ${SYNTH_NAMES.join(', ')}.
Use .gain(0 to 1) for dynamics.

If the user asks for a techno beat, you might output:
setcpm(128/4)
s("bd*4, ~ cp ~ cp, hh*8").bank("RolandTR909")

If the user asks for a melody over a beat, you might output:
setcpm(100/4)
stack(
  s("bd ~ sd ~, hh*8").bank("RolandTR808"),
  note("c3 eb3 g3 bb3").s("epiano"),
  note("c2 ~ ~ g1").s("bass")
)
`;

// Connect to Sequencer
let sequencerWs = null;
function connectToSequencer() {
  sequencerWs = new WebSocket('ws://localhost:8081');
  
  sequencerWs.on('open', () => {
    console.log('Connected to Sequencer');
  });

  sequencerWs.on('message', (data) => {
    // ws hands text frames over as Buffers; forward them as text (a Buffer
    // would go out as a binary frame, which the Audio Core skips)
    const message = data.toString();
    console.log(`Received from Sequencer: ${message}`);
    // Broadcast haps to frontend and audio core
    if (audioCoreWs && audioCoreWs.readyState === WebSocket.OPEN) {
        audioCoreWs.send(message);
    }
    broadcastToFrontends(message);
  });

  sequencerWs.on('close', () => {
    console.log('Disconnected from Sequencer, retrying in 3s...');
    setTimeout(connectToSequencer, 3000);
  });
  
  sequencerWs.on('error', (err) => {
    console.error('Sequencer WS error:', err.message);
  });
}
connectToSequencer();

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
           const response = await ai.models.generateContent({
              model: 'gemini-flash-latest',
              contents: data.text,
              config: {
                systemInstruction: SYSTEM_PROMPT,
                temperature: 0.7,
              }
           });
           
           let strudelCode = response.text.trim();
           // Strip markdown code blocks if the model mistakenly included them
           strudelCode = strudelCode.replace(/^\`\`\`javascript\n?/, '').replace(/^\`\`\`\n?/, '').replace(/\n?\`\`\`$/, '');
           
           console.log(`Generated Strudel code: ${strudelCode}`);

           // Let the requesting frontend client see the generated code immediately,
           // ahead of (or independent of) the Sequencer's evaluated haps.
           ws.send(JSON.stringify({ type: 'GENERATED', code: strudelCode }));

           // Pass generated Strudel code to Sequencer
           if (sequencerWs && sequencerWs.readyState === WebSocket.OPEN) {
             sequencerWs.send(JSON.stringify({
               type: 'EVAL',
               code: strudelCode
             }));
           } else {
             ws.send(JSON.stringify({ type: 'ERROR', message: 'Sequencer offline' }));
           }
           
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
