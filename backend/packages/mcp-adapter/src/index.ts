import { loadAdapterConfig } from './config.js';
import { startStdioServer } from './stdio.js';
import { startHttpServer } from './http-server.js';

const config = loadAdapterConfig();

if (config.transport === 'http') {
  await startHttpServer(config);
} else {
  await startStdioServer(config.coreUrl);
}
