import { loadConfig, validateProductionSecrets } from './config.js';
import { buildApp } from './server.js';

const config = loadConfig();
const { app, database, scanner } = await buildApp(config);

for (const warning of validateProductionSecrets(config)) app.log.warn(warning);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'Graceful shutdown started');
  await scanner.stop();
  await app.close();
  database.close();
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: config.port, host: config.host });
  scanner.startSchedules();
  if (config.scanOnStartup) void scanner.scan('startup').catch((error) => app.log.error({ error }, 'Startup scan failed'));
} catch (error) {
  app.log.fatal({ error }, 'Server failed to start');
  database.close();
  process.exitCode = 1;
}
