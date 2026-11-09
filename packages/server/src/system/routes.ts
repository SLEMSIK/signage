import type { FastifyInstance } from 'fastify';
import type { SystemStatus } from '@signage/shared';
import type { AppContext } from '../app.js';
import { ffmpegAvailable } from '../media/ffmpeg.js';

export async function systemStatus(ctx: AppContext): Promise<SystemStatus> {
  const { config, storage, version } = ctx;
  return {
    version,
    storageAvailable: storage.available,
    storageError: storage.error,
    serverTime: Date.now(),
    timezone: config.server.timezone,
    ffmpeg: await ffmpegAvailable(),
    maxUploadMb: config.storage.maxUploadMb,
  };
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/status', async () => systemStatus(app.ctx));
}
