import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export class ZipError extends Error {}

export interface ExtractLimits {
  maxTotalBytes: number;
  maxEntries: number;
}

export interface ExtractResult {
  /** Файлы пакета относительно корня (после снятия единственной папки верхнего уровня). */
  files: string[];
  totalBytes: number;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * Нормализует имя записи zip и проверяет, что оно не выходит за пределы
 * каталога (zip-slip). Возвращает null для служебного мусора (__MACOSX, .DS_Store).
 */
export function sanitizeEntryName(raw: string): string | null {
  if (raw.includes('\0')) throw new ZipError(`Недопустимое имя файла в архиве: ${raw}`);
  const name = raw.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new ZipError(`Абсолютный путь в архиве: ${raw}`);
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new ZipError(`Путь выходит за пределы архива: ${raw}`);
  if (parts.length === 0) return null;
  if (parts[0] === '__MACOSX' || parts[parts.length - 1] === '.DS_Store' || parts[parts.length - 1] === 'Thumbs.db') return null;
  return parts.join('/');
}

/**
 * Определяет корень пакета: index.html в корне архива или в единственной
 * папке верхнего уровня. Возвращает префикс, который нужно срезать ('' или 'folder/').
 */
export function detectRoot(fileNames: string[]): string {
  if (fileNames.some((f) => f.toLowerCase() === 'index.html')) return '';
  const tops = new Set(fileNames.map((f) => f.split('/')[0]!));
  if (tops.size === 1) {
    const top = [...tops][0]!;
    if (fileNames.some((f) => f.toLowerCase() === `${top.toLowerCase()}/index.html`)) return `${top}/`;
  }
  throw new ZipError('В архиве нет index.html (в корне или в единственной папке верхнего уровня)');
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, strictFileNames: false, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) reject(new ZipError(`Не удалось открыть архив: ${err?.message ?? 'неизвестная ошибка'}`));
      else resolve(zip);
    });
  });
}

function listEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    zip.on('entry', (e: yauzl.Entry) => {
      entries.push(e);
      zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.on('error', (e: Error) => reject(new ZipError(`Архив повреждён: ${e.message}`)));
    zip.readEntry();
  });
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(new ZipError(`Не удалось прочитать ${entry.fileName}: ${err?.message}`));
      else resolve(stream);
    });
  });
}

/** Счётчик реально распакованных байт — защита от zip-бомб с ложными заголовками. */
class ByteLimiter extends Transform {
  constructor(
    private readonly budget: { left: number },
    private readonly limitMb: number,
  ) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.budget.left -= chunk.length;
    if (this.budget.left < 0) cb(new ZipError(`Пакет больше ${this.limitMb} МБ после распаковки`));
    else cb(null, chunk);
  }
}

/** Безопасно распаковывает zip в destDir (каталог создаётся). */
export async function extractZip(zipFile: string, destDir: string, limits: ExtractLimits): Promise<ExtractResult> {
  const zip = await openZip(zipFile);
  try {
    const all = await listEntries(zip);
    if (all.length > limits.maxEntries) throw new ZipError(`Слишком много файлов в архиве (${all.length})`);

    const files: { entry: yauzl.Entry; name: string }[] = [];
    let declared = 0;
    for (const entry of all) {
      const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
      if (mode === S_IFLNK) throw new ZipError(`Символические ссылки в архиве не поддерживаются: ${entry.fileName}`);
      const name = sanitizeEntryName(entry.fileName);
      if (name === null || entry.fileName.endsWith('/')) continue;
      if (entry.generalPurposeBitFlag & 0x1) throw new ZipError('Зашифрованные архивы не поддерживаются');
      declared += entry.uncompressedSize;
      files.push({ entry, name });
    }
    const limitMb = Math.round(limits.maxTotalBytes / 1024 / 1024);
    if (declared > limits.maxTotalBytes) throw new ZipError(`Пакет больше ${limitMb} МБ после распаковки`);

    const prefix = detectRoot(files.map((f) => f.name));
    const root = path.resolve(destDir);
    await fs.mkdir(root, { recursive: true });

    const budget = { left: limits.maxTotalBytes };
    const out: string[] = [];
    const seen = new Set<string>();
    for (const { entry, name } of files) {
      if (!name.startsWith(prefix)) continue;
      const rel = name.slice(prefix.length);
      if (!rel || seen.has(rel.toLowerCase())) continue;
      seen.add(rel.toLowerCase());
      const target = path.resolve(root, rel);
      if (!target.startsWith(root + path.sep)) throw new ZipError(`Путь выходит за пределы архива: ${entry.fileName}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const stream = await openEntry(zip, entry);
      await pipeline(stream, new ByteLimiter(budget, limitMb), createWriteStream(target, { flags: 'wx' }));
      out.push(rel);
    }
    return { files: out.sort(), totalBytes: limits.maxTotalBytes - budget.left };
  } finally {
    zip.close();
  }
}
