import { createTransport } from './transport.mjs';
window.piRemoteTransport = createTransport();
await import('./diagnostics.mjs');
await import('./app.js');
