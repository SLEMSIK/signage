import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import yazl from 'yazl';
import type { MediaDto, SystemStatus } from '@signage/shared';
import { createTestApp, type TestApp } from '../test-utils/app.js';

function multipart(filename: string, data: Buffer) {
  const boundary = '----signage' + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  return { payload: Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`)]), ct: `multipart/form-data; boundary=${boundary}` };
}

async function zipBuffer(entries: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of Object.entries(entries)) zip.addBuffer(Buffer.from(data), name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** «Отключает» SMB: проверка хранилища будет падать, пока не вернём root обратно. */
function setPrimaryDown(t: TestApp, down: boolean) {
  t.app.ctx.storage.available = !down;
  t.app.ctx.storage.error = down ? 'тест: SMB отключён' : null;
}

describe('local fallback storage', () => {
  let t: TestApp;
  let cookie: string;
  const upload = async (filename: string, data: Buffer) => {
    const mp = multipart(filename, data);
    return t.app.inject({ method: 'POST', url: '/api/admin/media', payload: mp.payload, headers: { 'content-type': mp.ct, cookie } });
  };

  beforeAll(async () => {
    t = await createTestApp();
    cookie = await t.login('operator');
  });
  afterAll(async () => t.close());

  let img: MediaDto;
  let pkg: MediaDto;

  it('saves uploads to the VM disk while SMB is down and serves them', async () => {
    setPrimaryDown(t, true);
    const png = await sharp({ create: { width: 32, height: 18, channels: 3, background: '#0a0' } }).png().toBuffer();
    const res = await upload('green.png', png);
    expect(res.statusCode).toBe(200);
    img = res.json<MediaDto>();
    expect(img.location).toBe('local');
    expect(img.warnings[0]).toContain('диск сервера');

    const zres = await upload('w.zip', await zipBuffer({ 'index.html': '<html><head></head></html>', 'a.css': 'b{}' }));
    pkg = zres.json<MediaDto>();
    expect(pkg.location).toBe('local');

    expect(existsSync(path.join(t.config.storage.localFallbackPath!, '_tmp'))).toBe(true);
    const file = await t.app.inject({ url: img.url });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(png)).toBe(true);
    expect((await t.app.inject({ url: img.thumbUrl! })).statusCode).toBe(200);
    expect((await t.app.inject({ url: `/content/${pkg.id}/a.css` })).body).toBe('b{}');

    const status = (await t.app.inject({ url: '/api/admin/status', headers: { cookie } })).json<SystemStatus>();
    expect(status).toMatchObject({ storageAvailable: false, uploadTarget: 'local', localPending: 2, localFallback: true });
  });

  it('moves files to SMB when it comes back, keeping URLs', async () => {
    setPrimaryDown(t, false);
    const moved = await t.app.ctx.mediaSync.run();
    expect(moved).toBe(2);
    const list = (await t.app.inject({ url: '/api/admin/media', headers: { cookie } })).json<MediaDto[]>();
    expect(list.every((m) => m.location === 'primary')).toBe(true);
    const row = t.app.ctx.media.get(img.id);
    expect(existsSync(t.app.ctx.storage.absIn('primary', row.relPath))).toBe(true);
    expect(existsSync(t.app.ctx.storage.absIn('local', row.relPath))).toBe(false);
    expect(existsSync(t.app.ctx.storage.absIn('primary', row.thumbPath!))).toBe(true);
    const pkgRow = t.app.ctx.media.get(pkg.id);
    expect(existsSync(t.app.ctx.storage.absIn('primary', `${pkgRow.relPath}/index.html`))).toBe(true);

    expect((await t.app.inject({ url: img.url })).statusCode).toBe(200);
    expect(list.find((m) => m.id === img.id)!.url).toBe(img.url);
    expect(t.app.ctx.mediaSync.pendingCount()).toBe(0);
    expect((await t.app.ctx.mediaSync.run())).toBe(0);
  });

  it('health check of a reachable SMB triggers the move automatically', async () => {
    setPrimaryDown(t, true);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
    expect((await upload('auto.png', png)).json<MediaDto>().location).toBe('local');
    // /health перепроверяет SMB (каталог на месте) → onCheck → перенос.
    const health = await t.app.inject({ url: '/health' });
    expect(health.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(t.app.ctx.mediaSync.pendingCount()).toBe(0);
  });

  it('deletes a locally stored file from the VM disk', async () => {
    setPrimaryDown(t, true);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer();
    const dto = (await upload('tmp.png', png)).json<MediaDto>();
    const row = t.app.ctx.media.get(dto.id);
    const abs = t.app.ctx.storage.absIn('local', row.relPath);
    expect(existsSync(abs)).toBe(true);
    await t.app.inject({ method: 'DELETE', url: `/api/admin/media/${dto.id}`, headers: { cookie } });
    expect(existsSync(abs)).toBe(false);
    setPrimaryDown(t, false);
  });
});

describe('without local fallback', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp((c) => {
      c.storage.localFallbackPath = null;
    });
  });
  afterAll(async () => t.close());

  it('blocks uploads when SMB is down', async () => {
    const cookie = await t.login('admin');
    setPrimaryDown(t, true);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00f' } }).png().toBuffer();
    const mp = multipart('x.png', png);
    const res = await t.app.inject({ method: 'POST', url: '/api/admin/media', payload: mp.payload, headers: { 'content-type': mp.ct, cookie } });
    expect(res.statusCode).toBe(503);
    const status = (await t.app.inject({ url: '/api/admin/status', headers: { cookie } })).json<SystemStatus>();
    expect(status.uploadTarget).toBeNull();
    expect(status.uploadBlockedReason).toContain('недоступно');
  });
});
