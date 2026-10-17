// Root handlers: an error or rejection nothing caught is logged and shown as a
// notice that doesn't block, instead of vanishing (or blanking the page).
import { errorMessage, notify } from './notify';

const report = (what: string, err: unknown) => {
  console.error(what, err);
  notify(`Something went wrong: ${errorMessage(err)}`, 'error');
};

export function installRootHandlers() {
  window.addEventListener('error', (e) => {
    // a failed <img>/<script> load has no error object; the browser console has it
    if (e.error) report('Uncaught error', e.error);
  });
  window.addEventListener('unhandledrejection', (e) => report('Unhandled rejection', e.reason));
}

// For createRoot: render errors no boundary caught
export const rootErrorHandlers = {
  onUncaughtError: (err: unknown) => report('Uncaught render error', err),
};
