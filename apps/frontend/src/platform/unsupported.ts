// A page for a browser that can't run noprod. Plain DOM: React and the audio
// engine need the APIs that are missing.

export function showUnsupported(reasons: string[]) {
  const root = document.getElementById('root')!;
  root.textContent = '';
  const page = document.createElement('main');
  page.className = 'unsupported';
  const h = document.createElement('h1');
  h.textContent = "noprod can't run in this browser";
  const list = document.createElement('ul');
  reasons.forEach((r) => { const li = document.createElement('li'); li.textContent = r; list.append(li); });
  const help = document.createElement('p');
  help.textContent = 'noprod supports the last two versions of Chrome, Edge, Firefox and Safari. Update your browser, or open this page in one of them.';
  page.append(h, list, help);
  root.append(page);
}
