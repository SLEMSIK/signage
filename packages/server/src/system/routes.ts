import type { FastifyInstance } from 'fastify';
import type { SystemStatus } from '@signage/shared';
import type { AppContext } from '../app.js';
import { ffmpegAvailable } from '../media/ffmpeg.js';

export async function systemStatus(ctx: AppContext): Promise<SystemStatus> {
  const { config, storage, version } = ctx;
  let uploadTarget: SystemStatus['uploadTarget'] = null;
  let uploadBlockedReason: string | null = null;
  try {
    uploadTarget = await storage.uploadTarget();
  } catch (err) {
    uploadBlockedReason = (err as Error).message;
  }
  const free = await storage.localFreeBytes();
  return {
    version,
    storageAvailable: storage.available,
    storageError: storage.error,
    localFallback: storage.localRoot !== null,
    uploadTarget,
    uploadBlockedReason,
    localPending: ctx.mediaSync.pendingCount(),
    localFreeMb: free === null ? null : Math.floor(free / 1024 / 1024),
    mirror: ctx.mediaSync.mirrorStatus(),
    serverTime: Date.now(),
    timezone: config.server.timezone,
    ffmpeg: await ffmpegAvailable(),
    maxUploadMb: config.storage.maxUploadMb,
    defaultImageDurationSec: config.player.defaultImageDurationSec,
    defaultHtmlDurationSec: config.player.defaultHtmlDurationSec,
    mediaPath: config.storage.mediaPath,
    localFallbackPath: config.storage.localFallbackPath,
    backupPath: config.storage.backupPath,
    backupTime: config.storage.backupTime,
    backupKeep: config.storage.backupKeep,
  };
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/status', async () => systemStatus(app.ctx));
}
