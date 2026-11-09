/** Работа с HTML-контентом: проверка внешних ссылок и инжект window.signage. */

const EXTERNAL_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /<script\b[^>]*\bsrc\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>]+)/gi, what: 'скрипт' },
  { re: /<link\b[^>]*\bhref\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>]+)/gi, what: 'стиль/шрифт' },
  { re: /@import\s+(?:url\()?\s*["']?\s*((?:https?:)?\/\/[^"')\s;]+)/gi, what: 'CSS @import' },
  { re: /url\(\s*["']?\s*((?:https?:)?\/\/[^"')\s]+)/gi, what: 'ресурс в CSS' },
  { re: /<(?:img|iframe|video|audio|source)\b[^>]*\bsrc\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>]+)/gi, what: 'ресурс' },
];

/** Находит ссылки на внешние ресурсы (CDN недоступны с экранов). */
export function findExternalRefs(html: string): string[] {
  const found = new Map<string, string>();
  for (const { re, what } of EXTERNAL_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(html); m; m = re.exec(html)) {
      const url = m[1]!;
      // XML-неймспейсы вроде http://www.w3.org/2000/svg — не загрузки.
      if (/^(?:https?:)?\/\/www\.w3\.org\//i.test(url)) continue;
      if (!found.has(url)) found.set(url, what);
    }
  }
  return [...found].map(([url, what]) => `Внешний ${what}: ${url}`);
}

export function externalRefWarnings(html: string): string[] {
  const refs = findExternalRefs(html);
  if (refs.length === 0) return [];
  const head = 'Найдены внешние ссылки — с экранов интернет недоступен, положите эти файлы внутрь zip:';
  return [head, ...refs.slice(0, 20), ...(refs.length > 20 ? [`…и ещё ${refs.length - 20}`] : [])];
}

/** Скрипт, который получает каждая HTML-страница контента. */
export const SIGNAGE_SCRIPT = `<script>/* signage */(function(){var P='/api/proxy?url=';window.signage={proxyUrl:function(u){return P+encodeURIComponent(u)},fetch:function(u,o){o=o||{};return fetch(P+encodeURIComponent(u),{credentials:'same-origin',headers:o.headers,signal:o.signal})},json:function(u){return this.fetch(u).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})}};})();</script>`;

/** Вставляет SIGNAGE_SCRIPT как можно раньше: после <head>, иначе после <html>, иначе в начало. */
export function injectSignage(html: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + SIGNAGE_SCRIPT + html.slice(head.index + head[0].length);
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + SIGNAGE_SCRIPT + html.slice(root.index + root[0].length);
  const doctype = /<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype.index + doctype[0].length) + SIGNAGE_SCRIPT + html.slice(doctype.index + doctype[0].length);
  return SIGNAGE_SCRIPT + html;
}
