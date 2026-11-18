// Desktop edition entry: window.mdv comes from the preload; start the shared app.
import { startApp } from '../../packages/core/src/ui/app.js';

startApp({ selftest: () => import('./selftest.js') });
