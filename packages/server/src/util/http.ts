import type { FastifyReply } from 'fastify';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Не найдено') => new HttpError(404, what);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const forbidden = (msg = 'Недостаточно прав') => new HttpError(403, msg);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, details);

/** Валидирует данные zod-схемой, бросая 400 с понятным текстом. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'запрос'}: ${i.message}`).join('; ');
    throw badRequest(msg, r.error.issues);
  }
  return r.data;
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

export function sendError(reply: FastifyReply, err: HttpError): FastifyReply {
  return reply.code(err.statusCode).send({ error: err.message, details: err.details });
}
