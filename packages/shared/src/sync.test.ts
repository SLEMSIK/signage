import { describe, expect, it } from 'vitest';
import { syncPosition } from './sync.js';
import { playerToServerSchema, serverToPlayerSchema } from './protocol.js';

describe('syncPosition', () => {
  it('returns null for empty playlist', () => {
    expect(syncPosition([], 0, 1000)).toBeNull();
  });

  it('computes index and offsets inside the cycle', () => {
    // 10 + 5 + 15 = 30 с
    expect(syncPosition([10, 5, 15], 0, 0)).toEqual({ index: 0, offsetMs: 0, remainingMs: 10_000 });
    expect(syncPosition([10, 5, 15], 0, 12_000)).toEqual({ index: 1, offsetMs: 2_000, remainingMs: 3_000 });
    expect(syncPosition([10, 5, 15], 0, 29_999)).toEqual({ index: 2, offsetMs: 14_999, remainingMs: 1 });
  });

  it('wraps around and is the same for two clocks reading the same time', () => {
    const a = syncPosition([10, 5, 15], 1_000, 1_000 + 30_000 * 7 + 11_000);
    expect(a).toEqual({ index: 1, offsetMs: 1_000, remainingMs: 4_000 });
  });

  it('handles now before epoch', () => {
    expect(syncPosition([10, 20], 30_000, 25_000)).toEqual({ index: 1, offsetMs: 15_000, remainingMs: 5_000 });
  });
});

describe('protocol schemas', () => {
  it('parses hello and heartbeat', () => {
    expect(playerToServerSchema.parse({ type: 'hello' }).type).toBe('hello');
    const hb = playerToServerSchema.parse({
      type: 'heartbeat',
      currentItemId: 3,
      playlistId: 1,
      cacheStatus: { sw: true, cached: 2, total: 3 },
      viewport: { w: 1920, h: 1080 },
      uptime: 12,
    });
    expect(hb.type).toBe('heartbeat');
  });

  it('rejects unknown messages and bad pairing codes', () => {
    expect(() => playerToServerSchema.parse({ type: 'nope' })).toThrow();
    expect(() => serverToPlayerSchema.parse({ type: 'pairing', code: '12ab56' })).toThrow();
  });
});
