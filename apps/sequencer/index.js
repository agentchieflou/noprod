import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer';

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

const wss = new WebSocketServer({ port: 8081, verifyClient });
console.log('Sequencer WebSocket Server listening on port 8081');

const ENGINE_INIT_TIMEOUT_MS = 20000;

let browser;
let page;
let engineReady = false;

async function initPuppeteer() {
  console.log('Initializing Headless Strudel Engine...');
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  page = await browser.newPage();

  // Create a minimal HTML environment to load Strudel
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <script src="https://unpkg.com/@strudel/web@latest"></script>
      </head>
      <body>
        <script>
          window.strudelReady = new Promise((resolve, reject) => {
            window.addEventListener('load', async () => {
              try {
                await initStrudel();
                resolve();
              } catch (e) {
                reject(e);
              }
            });
          });
        </script>
      </body>
    </html>
  `;
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: ENGINE_INIT_TIMEOUT_MS });
  await page.waitForFunction('typeof initStrudel !== "undefined"', { timeout: ENGINE_INIT_TIMEOUT_MS });
  await page.evaluate(() => window.strudelReady);

  engineReady = true;
  console.log('Headless Strudel Engine Ready!');
}

initPuppeteer().catch((err) => {
  console.error('Headless Strudel Engine failed to initialize:', err.message);
});

wss.on('connection', (ws) => {
  console.log('Client connected to Sequencer');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'EVAL') {
        console.log(`Evaluating Strudel code: ${data.code}`);

        if (!engineReady) {
          throw new Error('Headless Strudel engine not ready yet.');
        }

        // Evaluate the code for real in the headless browser context and
        // extract one cycle's worth of haps from the resulting pattern.
        const haps = await page.evaluate(async (code) => {
          try {
            const pattern = await evaluate(code);
            const result = pattern.queryArc(0, 1).map((hap) => ({
              time: hap.whole ? hap.whole.begin.valueOf() : 0,
              note: hap.value?.note ?? hap.value?.s ?? JSON.stringify(hap.value),
              duration: hap.whole ? hap.whole.end.valueOf() - hap.whole.begin.valueOf() : 0,
              sourceCode: code,
              engine: 'strudel-web',
              // Strudel's .orbit(n) picks the Audio Core track (and its
              // inserts) the hap plays on; orbit 1 is Strudel's default
              trackIndex: Number.isFinite(hap.value?.orbit) ? hap.value.orbit : 1
            }));
            // evaluate() starts the real-time scheduler (cyclist); stop it
            // since we only want this cycle's data, not live playback.
            hush();
            return result;
          } catch (e) {
            return { error: e.message };
          }
        }, data.code);

        if (haps.error) {
           ws.send(JSON.stringify({ type: 'ERROR', message: haps.error }));
        } else {
           ws.send(JSON.stringify({ type: 'HAP_STREAM', haps: haps }));
        }
      }
    } catch (error) {
      console.error('Error processing message', error);
      ws.send(JSON.stringify({ type: 'ERROR', message: error.message }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected from Sequencer');
  });
});

process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit();
});
