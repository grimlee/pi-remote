import { createTransport } from './transport.mjs';
window.piRemoteTransport = createTransport();
await import('./app.js');
