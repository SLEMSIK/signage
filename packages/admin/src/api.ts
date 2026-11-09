export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const UNAUTHORIZED_EVENT = 'signage:unauthorized';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Запрос к /api/admin. Тело сериализуется в JSON. */
export async function api<T>(path: string, method: Method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/login' && path !== '/me') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const err = data as { error?: string; details?: unknown } | null;
    throw new ApiError(res.status, err?.error ?? `Ошибка ${res.status}`, err?.details);
  }
  return data as T;
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

/** Загрузка файла через XHR — ради прогресс-бара. */
export function upload<T>(path: string, file: File, onProgress: (p: UploadProgress) => void): { promise: Promise<T>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open('POST', `/api/admin${path}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => onProgress({ loaded: e.loaded, total: e.total });
    xhr.onload = () => {
      let data: unknown;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else {
        const err = data as { error?: string } | null;
        reject(new ApiError(xhr.status, err?.error ?? `Ошибка ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'Сеть недоступна'));
    xhr.onabort = () => reject(new ApiError(0, 'Загрузка отменена'));
    const fd = new FormData();
    fd.append('file', file, file.name);
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}
