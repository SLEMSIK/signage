import type { FastifyInstance } from 'fastify';
import type { SystemStatus } from '@signage/shared';
import { ffmpegAvailable } from '../media/ffmpeg.js';

export async function systemStatus(app: FastifyInstance): Promise<SystemStatus> {
  const { config, storage, version } = app.ctx;
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
  app.get('/status', async () => systemStatus(app));
}
