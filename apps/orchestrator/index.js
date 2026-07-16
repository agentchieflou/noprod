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

  sequencerWs.on('message', (message) => {
    console.log(`Received from Sequencer: ${message}`);
    // Broadcast haps to frontend or audio core
    if (audioCoreWs && audioCoreWs.readyState === WebSocket.OPEN) {
        audioCoreWs.send(message);
    }
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
  });

  audioCoreWs.on('message', (message) => {
    console.log(`Received from Audio Core: ${message}`);
  });

  audioCoreWs.on('close', () => {
    console.log('Disconnected from Audio Core, retrying in 3s...');
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

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      // Handle user dictation ("make a beat like...")
      if (data.type === 'DICTATION') {
        console.log(`Received dictation: ${data.text}`);
        
        try {
           const response = await ai.models.generateContent({
              model: 'gemini-2.5-flash',
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
  });
});
