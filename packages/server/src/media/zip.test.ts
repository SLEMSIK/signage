import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { detectRoot, extractZip, sanitizeEntryName, ZipError } from './zip.js';
import { externalRefWarnings, findExternalRefs, injectSignage } from './html.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'signage-zip-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
async function makeZip(entries: { name: string; data?: string | Buffer; symlink?: boolean }[]): Promise<string> {
  const file = path.join(tmp, `t${n++}.zip`);
  const zip = new yazl.ZipFile();
  for (const e of entries) {
    const mode = e.symlink ? 0o120777 : 0o100644;
    zip.addBuffer(Buffer.from(e.data ?? 'x'), e.name, { mode, compress: true });
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.pipe(createWriteStream(file)).on('close', resolve).on('error', reject);
  });
  // yazl не даёт записать «..» в имя — подменяем плейсхолдер той же длины прямо в байтах.
  const buf = readFileSync(file);
  writeFileSync(file, Buffer.from(buf.toString('latin1').replaceAll('@@', '..'), 'latin1'));
  return file;
}

const limits = { maxTotalBytes: 1024 * 1024, maxEntries: 100 };

describe('sanitizeEntryName', () => {
  it('normalizes and rejects traversal', () => {
    expect(sanitizeEntryName('a/./b.txt')).toBe('a/b.txt');
    expect(sanitizeEntryName('a\\b.txt')).toBe('a/b.txt');
    expect(sanitizeEntryName('__MACOSX/a')).toBeNull();
    expect(() => sanitizeEntryName('../evil')).toThrow(ZipError);
    expect(() => sanitizeEntryName('a/../../evil')).toThrow(ZipError);
    expect(() => sanitizeEntryName('/etc/passwd')).toThrow(ZipError);
    expect(() => sanitizeEntryName('C:/win.ini')).toThrow(ZipError);
    expect(() => sanitizeEntryName('..\\evil')).toThrow(ZipError);
  });
});

describe('detectRoot', () => {
  it('finds index.html in root or a single top folder', () => {
    expect(detectRoot(['index.html', 'a.js'])).toBe('');
    expect(detectRoot(['site/index.html', 'site/a.js'])).toBe('site/');
    expect(() => detectRoot(['a/index.html', 'b/x.js'])).toThrow(ZipError);
    expect(() => detectRoot(['main.html'])).toThrow(ZipError);
  });
});

describe('extractZip', () => {
  it('extracts a normal package', async () => {
    const z = await makeZip([
      { name: 'index.html', data: '<html></html>' },
      { name: 'css/app.css', data: 'body{}' },
    ]);
    const dest = path.join(tmp, 'ok');
    const r = await extractZip(z, dest, limits);
    expect(r.files).toEqual(['css/app.css', 'index.html']);
    expect(readFileSync(path.join(dest, 'css/app.css'), 'utf8')).toBe('body{}');
  });

  it('strips a single top-level folder', async () => {
    const z = await makeZip([
      { name: 'widget/index.html', data: 'hi' },
      { name: 'widget/img/a.png', data: 'png' },
      { name: '__MACOSX/widget/._index.html', data: 'junk' },
    ]);
    const dest = path.join(tmp, 'strip');
    const r = await extractZip(z, dest, limits);
    expect(r.files).toEqual(['img/a.png', 'index.html']);
    expect(existsSync(path.join(dest, 'index.html'))).toBe(true);
  });

  it('rejects zip-slip', async () => {
    const z = await makeZip([
      { name: 'index.html' },
      { name: 'a/@@/@@/evil.txt', data: 'pwned' },
    ]);
    await expect(extractZip(z, path.join(tmp, 'slip'), limits)).rejects.toThrow(ZipError);
    expect(existsSync(path.join(tmp, 'evil.txt'))).toBe(false);
  });

  it('rejects symlinks', async () => {
    const z = await makeZip([{ name: 'index.html' }, { name: 'link', data: '/etc/passwd', symlink: true }]);
    await expect(extractZip(z, path.join(tmp, 'sym'), limits)).rejects.toThrow(/Символические/);
  });

  it('enforces the unzipped size limit', async () => {
    const z = await makeZip([{ name: 'index.html' }, { name: 'big.bin', data: Buffer.alloc(2 * 1024 * 1024) }]);
    await expect(extractZip(z, path.join(tmp, 'big'), limits)).rejects.toThrow(/МБ/);
  });

  it('requires index.html', async () => {
    const z = await makeZip([{ name: 'readme.txt' }]);
    await expect(extractZip(z, path.join(tmp, 'noindex'), limits)).rejects.toThrow(/index\.html/);
  });

  it('rejects garbage', async () => {
    const f = path.join(tmp, 'garbage.zip');
    writeFileSync(f, 'not a zip');
    await expect(extractZip(f, path.join(tmp, 'garbage'), limits)).rejects.toThrow(ZipError);
  });
});

describe('html helpers', () => {
  it('finds external scripts, styles and fonts', () => {
    const html = `<html><head>
      <script src="https://cdn.example.com/lib.js"></script>
      <script src="js/local.js"></script>
      <link rel="stylesheet" href="//fonts.googleapis.com/css?family=Roboto">
      <style>@import url("https://x.com/a.css"); .a{background:url(img/a.png)}</style>
      <svg xmlns="http://www.w3.org/2000/svg"></svg>
    </head></html>`;
    const refs = findExternalRefs(html);
    expect(refs).toHaveLength(3);
    expect(refs.join('\n')).toContain('cdn.example.com');
    expect(refs.join('\n')).not.toContain('local.js');
    expect(externalRefWarnings('<p>ok</p>')).toEqual([]);
  });

  it('injects signage script right after <head>', () => {
    expect(injectSignage('<html><head><title>x</title></head></html>')).toMatch(/^<html><head><script>\/\* signage/);
    expect(injectSignage('<p>x</p>')).toMatch(/^<script>/);
    expect(injectSignage('<!DOCTYPE html><p>x</p>')).toMatch(/^<!DOCTYPE html><script>/);
  });
});
