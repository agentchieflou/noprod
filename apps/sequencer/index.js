import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer';

const wss = new WebSocketServer({ port: 8081 });
console.log('Sequencer WebSocket Server listening on port 8081');

let browser;
let page;

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
          window.strudelInit = new Promise((resolve) => {
            window.addEventListener('load', () => {
              // Assuming strudel is available globally
              strudel.init(); // Initialize strudel if needed
              resolve();
            });
          });
        </script>
      </body>
    </html>
  `;
  await page.setContent(html);
  
  // Wait for the script to load
  await page.waitForFunction('typeof strudel !== "undefined"');
  console.log('Headless Strudel Engine Ready!');
}

initPuppeteer().catch(console.error);

wss.on('connection', (ws) => {
  console.log('Client connected to Sequencer');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'EVAL') {
        console.log(`Evaluating Strudel code: ${data.code}`);
        
        if (!page) {
          throw new Error('Puppeteer engine not ready yet.');
        }

        // Evaluate the code in the headless browser context
        const haps = await page.evaluate(async (code) => {
          try {
            // Check if strudel is available globally
            if (typeof strudel === 'undefined') {
                return { error: 'Strudel not loaded in headless engine.' };
            }
            
            // Wait for evaluation. We use the global repl function or core eval.
            // Depending on the version of @strudel/web, `evalStrudel` or `evaluate` is exposed.
            // For now, we mock the extracted events until the API is fully mapped.
            console.log("Evaluating inside Puppeteer: " + code);
            
            // Example of what we aim to do:
            // let pat = strudel.evaluate(code);
            // let events = pat.queryArc(0, 1);
            // return events.map(e => ({ time: e.time, value: e.value }));
            
            return [{ time: 0, note: 'C4', duration: 1, sourceCode: code, engine: 'puppeteer-strudel' }];
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
