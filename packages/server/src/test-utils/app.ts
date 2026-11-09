import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { configSchema, type Config } from '../config/index.js';

export const TEST_PASSWORD = 'test-password-1';
const HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

export interface TestApp {
  app: FastifyInstance;
  dir: string;
  config: Config;
  close(): Promise<void>;
  login(login?: string): Promise<string>;
}

export async function createTestApp(patch?: (c: Config) => void): Promise<TestApp> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'signage-test-'));
  const config = configSchema.parse({
    server: { publicUrl: 'http://127.0.0.1:8080', sessionSecret: 'test-secret-test-secret', timezone: 'Europe/Moscow' },
    users: [
      { login: 'admin', role: 'admin', passwordHash: HASH },
      { login: 'operator', role: 'operator', passwordHash: HASH },
    ],
    storage: {
      mediaPath: path.join(dir, 'media'),
      dbPath: path.join(dir, 'db', 'test.sqlite'),
      backupPath: path.join(dir, 'media', '_backup'),
      localFallbackPath: path.join(dir, 'local'),
      localMinFreeMb: 0,
    },
    proxy: { allowlist: ['api.example.com'], cacheTtlSec: 60 },
  });
  rmSync(config.storage.mediaPath, { recursive: true, force: true });
  (await import('node:fs')).mkdirSync(config.storage.mediaPath, { recursive: true });
  patch?.(config);
  const app = await buildApp(config, { background: false, logger: false });
  await app.ready();
  return {
    app,
    dir,
    config,
    async close() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
    async login(login = 'admin') {
      const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password: TEST_PASSWORD } });
      if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
      const cookie = res.cookies.find((c) => c.name === 'signage_sid');
      return `signage_sid=${cookie!.value}`;
    },
  };
}
