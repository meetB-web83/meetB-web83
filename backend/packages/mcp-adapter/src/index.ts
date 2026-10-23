import { loadAdapterConfig } from './config.js';
import { runStdioAdapter } from './autostart.js';
import { startHttpServer } from './http-server.js';

const config = loadAdapterConfig();

if (config.transport === 'http') {
  await startHttpServer(config);
} else {
  await runStdioAdapter(config);
}
