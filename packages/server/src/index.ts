import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config/index.js';
import { buildApp } from './app.js';

/**
 * Где искать конфиг, если CONFIG_PATH не задан: текущий каталог, каталог, из
 * которого вызвали npm (INIT_CWD), и корень репозитория. npm запускает скрипты
 * воркспейса из packages/server, поэтому одного cwd недостаточно.
 */
function resolveConfigPath(): string {
  if (process.env.CONFIG_PATH) return path.resolve(process.env.CONFIG_PATH);
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url)); // src|dist → packages/server → корень
  const candidates = [process.cwd(), process.env.INIT_CWD, repoRoot]
    .filter((d): d is string => !!d)
    .map((d) => path.resolve(d, 'config/config.yaml'));
  const unique = [...new Set(candidates)];
  const found = unique.find((p) => existsSync(p));
  if (found) return found;
  console.error(
    `Не найден config/config.yaml. Искал:\n${unique.map((p) => `  - ${p}`).join('\n')}\n` +
      'Скопируйте config/config.example.yaml в config/config.yaml или укажите путь в переменной CONFIG_PATH.',
  );
  process.exit(2);
}

const configPath = resolveConfigPath();

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
