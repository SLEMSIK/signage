import path from 'node:path';
import { ConfigError, loadConfig } from './config/index.js';
import { buildApp } from './app.js';

const configPath = process.env.CONFIG_PATH ?? path.resolve(process.cwd(), 'config/config.yaml');

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  const app = await buildApp(config);
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.server.port, host: config.server.host });
  app.log.info({ publicUrl: config.server.publicUrl, timezone: config.server.timezone }, 'signage server started');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
