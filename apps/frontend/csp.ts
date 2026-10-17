// The Content-Security-Policy of the built app (#157): the page can hold a
// user's API key, so it runs only its own scripts and talks only to its own
// host, the dictation provider, and GhostDAW on this computer. It goes into
// the built index.html only: Vite's dev server injects an inline script
// (React Refresh) that script-src 'self' would block.

export const PROVIDER_HOST = 'https://generativelanguage.googleapis.com';

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // React sets style attributes
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${PROVIDER_HOST} ws://localhost:* ws://127.0.0.1:*`,
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ');

export const cspPlugin = () => ({
  name: 'noprod-csp',
  apply: 'build' as const,
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' as const }
  ]
});
