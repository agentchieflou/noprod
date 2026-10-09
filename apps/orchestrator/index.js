import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// The Orchestrator acts as the brain.
// It exposes a WebSocket server for the frontend to connect to (port 8080).
// It also connects to the Sequencer (port 8081).
// It connects to the Audio Core (port 8082 - Ghost DAW C++).

const wss = new WebSocketServer({ port: 8080 });
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
  'SET_PLUGIN_BYPASS', 'SET_PLUGIN_PARAMETER', 'SET_VST_PARAMETER'
]);
const audioCoreConnected = () => !!audioCoreWs && audioCoreWs.readyState === WebSocket.OPEN;

// Initialize Gemini Client
// Requires GEMINI_API_KEY to be set in environment or .env
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_PROMPT = `
You are the dictation engine for the NoProd DAW. Your job is to translate user natural language requests into Strudel patterns.
You MUST output ONLY valid Strudel javascript code. 
Do not include markdown blocks, explanations, or any other text.
If the user asks for a techno beat, you might output: s("bd(3,8) sd(1,4)").cpm(120)
If the user asks for a melody, you might output: note("c3 e3 g3 c4").s("sawtooth")
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
    if (isBinary) return; // binary frames (plugin editor video, later) don't go through here
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
