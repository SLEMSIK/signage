import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditDto, BackupDto, GroupDto } from '@signage/shared';
import { createTestApp, type TestApp } from '../test-utils/app.js';

describe('backups and audit', () => {
  let t: TestApp;
  let admin: string;
  let operator: string;
  const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, cookie = admin) =>
    t.app.inject({ method, url: `/api/admin${url}`, payload: payload as object, headers: { cookie } });

  beforeAll(async () => {
    t = await createTestApp((c) => {
      c.storage.backupKeep = 3;
    });
    admin = await t.login('admin');
    operator = await t.login('operator');
  });
  afterAll(async () => t.close());

  it('backups are admin-only', async () => {
    expect((await api('GET', '/backups', undefined, operator)).statusCode).toBe(403);
    expect((await api('POST', '/backups', undefined, operator)).statusCode).toBe(403);
  });

  it('creates a backup on SMB and restores it', async () => {
    await api('POST', '/groups', { name: 'До бэкапа' });
    const res = await api('POST', '/backups');
    expect(res.statusCode).toBe(200);
    const b = res.json<BackupDto>();
    expect(b).toMatchObject({ location: 'primary' });
    expect(b.name).toMatch(/^signage-\d{8}-\d{6}-manual\.sqlite$/);
    expect(existsSync(path.join(t.config.storage.backupPath, b.name))).toBe(true);

    await api('POST', '/groups', { name: 'После бэкапа' });
    expect((await api('GET', '/groups')).json<GroupDto[]>()).toHaveLength(2);

    const r = await api('POST', `/backups/${b.name}/restore`);
    expect(r.statusCode).toBe(200);
    const groups = (await api('GET', '/groups')).json<GroupDto[]>();
    expect(groups.map((g) => g.name)).toEqual(['До бэкапа']);
    // Страховочная копия перед восстановлением.
    const list = (await api('GET', '/backups')).json<BackupDto[]>();
    expect(list.some((x) => x.name.endsWith('-pre-restore.sqlite'))).toBe(true);

    const dl = await api('GET', `/backups/${b.name}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.subarray(0, 15).toString()).toBe('SQLite format 3');
  });

  it('rejects path traversal in backup names', async () => {
    expect((await api('POST', '/backups/..%2F..%2Fetc%2Fpasswd/restore')).statusCode).toBe(400);
  });

  it('keeps only backupKeep copies', async () => {
    for (let i = 0; i < 4; i++) {
      await t.app.ctx.backups.create(`r${'abcd'[i]}`);
      await new Promise((r) => setTimeout(r, 1100)); // имена по секундам
    }
    const files = readdirSync(t.config.storage.backupPath).filter((f) => f.endsWith('.sqlite'));
    expect(files.length).toBe(3);
  }, 15_000);

  it('writes backups to the VM disk while SMB is down and moves them later', async () => {
    t.app.ctx.storage.available = false;
    const b = await t.app.ctx.backups.create('offline');
    expect(b?.location).toBe('local');
    const localDir = path.join(t.config.storage.localFallbackPath!, '_backup');
    expect(existsSync(path.join(localDir, b!.name))).toBe(true);
    t.app.ctx.storage.available = true;
    await t.app.ctx.backups.moveLocalToPrimary();
    expect(existsSync(path.join(localDir, b!.name))).toBe(false);
    expect(existsSync(path.join(t.config.storage.backupPath, b!.name))).toBe(true);
  });

  it('audit log records actions and supports filters; operator can read', async () => {
    const all = (await api('GET', '/audit?limit=100', undefined, operator)).json<{ items: AuditDto[]; total: number }>();
    expect(all.total).toBeGreaterThan(3);
    const actions = all.items.map((i) => `${i.user}:${i.action}:${i.entity}`);
    expect(actions).toContain('admin:create:group');
    expect(actions).toContain('admin:restore:backup');
    const onlyGroups = (await api('GET', '/audit?entity=group', undefined, operator)).json<{ items: AuditDto[] }>();
    expect(onlyGroups.items.every((i) => i.entity === 'group')).toBe(true);
    const search = (await api('GET', `/audit?q=${encodeURIComponent('До бэкапа')}`)).json<{ items: AuditDto[] }>();
    expect(search.items.length).toBeGreaterThan(0);
    const filters = (await api('GET', '/audit/filters')).json<{ users: string[] }>();
    expect(filters.users).toContain('admin');
  });
});
