import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import yazl from 'yazl';
import type { MediaDto } from '@signage/shared';
import { createTestApp, type TestApp } from '../test-utils/app.js';

function multipart(filename: string, data: Buffer, contentType = 'application/octet-stream') {
  const boundary = '----signage' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, data, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function zipBuffer(entries: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of Object.entries(entries)) zip.addBuffer(Buffer.from(data), name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

describe('media library', () => {
  let t: TestApp;
  let cookie: string;
  beforeAll(async () => {
    t = await createTestApp();
    cookie = await t.login('operator');
  });
  afterAll(async () => t.close());

  const upload = (filename: string, data: Buffer) => {
    const mp = multipart(filename, data);
    return t.app.inject({ method: 'POST', url: '/api/admin/media', payload: mp.payload, headers: { ...mp.headers, cookie } });
  };

  it('requires auth for upload', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/admin/media', ...multipart('a.png', Buffer.from('x')) });
    expect(res.statusCode).toBe(401);
  });

  let image: MediaDto;
  it('uploads an image, makes a thumbnail and serves it with ETag', async () => {
    const png = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#f00' } }).png().toBuffer();
    const mp = multipart('Красный слайд.png', png);
    const res = await t.app.inject({ method: 'POST', url: '/api/admin/media', payload: mp.payload, headers: { ...mp.headers, cookie } });
    expect(res.statusCode).toBe(200);
    image = res.json<MediaDto>();
    expect(image).toMatchObject({ type: 'image', title: 'Красный слайд', size: png.length });
    expect(image.thumbUrl).toBeTruthy();
    expect(image.url).toMatch(/^\/media\/\d+\?v=[0-9a-f]{8}$/);

    const file = await t.app.inject({ url: image.url });
    expect(file.statusCode).toBe(200);
    expect(file.headers['cache-control']).toContain('immutable');
    expect(file.headers.etag).toBe(`"${image.sha256}"`);
    expect(file.rawPayload.equals(png)).toBe(true);

    const again = await t.app.inject({ url: image.url, headers: { 'if-none-match': `"${image.sha256}"` } });
    expect(again.statusCode).toBe(304);

    const range = await t.app.inject({ url: image.url, headers: { range: 'bytes=0-9' } });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload.length).toBe(10);

    expect((await t.app.inject({ url: image.thumbUrl! })).statusCode).toBe(200);
  });

  it('rejects unsupported and broken files', async () => {
    expect((await upload('virus.exe', Buffer.from('MZ'))).statusCode).toBe(400);
    expect((await upload('fake.png', Buffer.from('not an image'))).statusCode).toBe(400);
  });

  it('uploads single-file HTML, warns about CDN links and injects window.signage', async () => {
    const html = '<!doctype html><html><head><script src="https://cdn.example.com/x.js"></script></head><body>Hi</body></html>';
    const res = await upload('widget.html', Buffer.from(html));
    expect(res.statusCode).toBe(200);
    const dto = res.json<MediaDto>();
    expect(dto.type).toBe('html');
    expect(dto.warnings.join('\n')).toContain('cdn.example.com');
    expect(dto.url).toMatch(/^\/content\/\d+\/index\.html\?v=/);
    const page = await t.app.inject({ url: dto.url });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('window.signage=');
    expect(page.body).toContain('Hi');
  });

  it('uploads a zip package with nested folder and serves assets', async () => {
    const zip = await zipBuffer({
      'pkg/index.html': '<html><head></head><body><img src="img/a.svg"></body></html>',
      'pkg/img/a.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
    const res = await upload('Пакет.zip', zip);
    expect(res.statusCode).toBe(200);
    const dto = res.json<MediaDto>();
    expect(dto.type).toBe('html_zip');
    expect(dto.warnings).toEqual([]);
    const asset = await t.app.inject({ url: `/content/${dto.id}/img/a.svg` });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('<svg');
    expect((await t.app.inject({ url: `/content/${dto.id}/../../../etc/passwd` })).statusCode).toBe(404);
    expect((await t.app.inject({ url: `/content/${dto.id}/%2e%2e/%2e%2e/db/test.sqlite` })).statusCode).toBe(404);
  });

  it('rejects zip without index.html', async () => {
    const res = await upload('bad.zip', await zipBuffer({ 'readme.txt': 'x' }));
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('index.html');
  });

  it('lists, renames and deletes media', async () => {
    const list = await t.app.inject({ url: '/api/admin/media', headers: { cookie } });
    expect(list.json<MediaDto[]>().length).toBeGreaterThanOrEqual(3);
    const ren = await t.app.inject({ method: 'PATCH', url: `/api/admin/media/${image.id}`, payload: { title: 'Новое имя' }, headers: { cookie } });
    expect(ren.json<MediaDto>().title).toBe('Новое имя');
    const del = await t.app.inject({ method: 'DELETE', url: `/api/admin/media/${image.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    expect((await t.app.inject({ url: image.url })).statusCode).toBe(404);
  });
});
