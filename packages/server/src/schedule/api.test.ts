import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { GroupDto, MediaDto, OverrideDto, PlaylistDto, ScreenDto } from '@signage/shared';
import { createTestApp, type TestApp } from '../test-utils/app.js';
import type { FakePlayer} from '../test-utils/fakePlayer.js';
import { listenAndPair } from '../test-utils/fakePlayer.js';

describe('schedules, overrides and group sync', () => {
  let t: TestApp;
  let admin: string;
  let operator: string;
  let p1: FakePlayer;
  let p2: FakePlayer;
  let s1: number;
  let s2: number;
  let group: GroupDto;
  let playlist: PlaylistDto;

  const inject = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, cookie = admin) =>
    t.app.inject({ method, url: `/api/admin${url}`, payload: payload as object, headers: { cookie } });

  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin');
    operator = await t.login('operator');
    ({ player: p1, screenId: s1 } = await listenAndPair(t, admin, 'Холл 1'));
    ({ player: p2, screenId: s2 } = await listenAndPair(t, admin, 'Холл 2'));

    const png = await sharp({ create: { width: 16, height: 9, channels: 3, background: '#123' } }).png().toBuffer();
    const boundary = '----x';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const media = (
      await t.app.inject({ method: 'POST', url: '/api/admin/media', payload, headers: { cookie: admin, 'content-type': `multipart/form-data; boundary=${boundary}` } })
    ).json<MediaDto>();
    playlist = (await inject('POST', '/playlists', { name: 'Холл', items: [{ mediaId: media.id, durationSec: 5, fit: null, transition: 'none' }] })).json();
    group = (await inject('POST', '/groups', { name: 'Холл', syncPlayback: true })).json();
    await inject('PATCH', `/screens/${s1}`, { groupId: group.id });
    await inject('PATCH', `/screens/${s2}`, { groupId: group.id });
  });
  afterAll(async () => {
    p1.close();
    p2.close();
    await t.close();
  });

  it('validates schedule input', async () => {
    const bad = await inject('POST', '/schedules', {
      targetType: 'group',
      targetId: group.id,
      playlistId: playlist.id,
      days: 127,
      startTime: '25:00',
      endTime: '18:00',
      priority: 0,
      enabled: true,
    });
    expect(bad.statusCode).toBe(400);
    const noTarget = await inject('POST', '/schedules', {
      targetType: 'screen',
      targetId: 999,
      playlistId: playlist.id,
      days: 127,
      startTime: '09:00',
      endTime: '18:00',
      priority: 0,
      enabled: true,
    });
    expect(noTarget.statusCode).toBe(400);
  });

  it('group schedule reaches both screens with the same sync epoch', async () => {
    const res = await inject(
      'POST',
      '/schedules',
      { targetType: 'group', targetId: group.id, playlistId: playlist.id, days: 127, startTime: '00:00', endTime: '00:00', priority: 0, enabled: true },
      operator,
    );
    expect(res.statusCode).toBe(200);
    // Сначала могут прийти state от смены группы — ждём тот, где есть плейлист.
    const waitPlaylist = async (p: FakePlayer) => {
      for (;;) {
        const st = await p.next('state');
        if (st.playlist) return st;
      }
    };
    const [a, b] = await Promise.all([waitPlaylist(p1), waitPlaylist(p2)]);
    expect(a.playlist?.id).toBe(playlist.id);
    expect(a.syncEpoch).toBeTypeOf('number');
    expect(a.syncEpoch).toBe(b.syncEpoch);

    const sched = (await inject('GET', `/schedules?targetType=screen&targetId=${s1}`)).json<{ own: unknown[]; inherited: unknown[] }>();
    expect(sched.own).toHaveLength(0);
    expect(sched.inherited).toHaveLength(1);
  });

  it('screen override (black screen for 1 h) affects only that screen, restore brings schedule back', async () => {
    const res = await inject('POST', '/overrides', { targets: [{ type: 'screen', id: s1 }], playlistId: null, mode: 'hours', hours: 1 }, operator);
    expect(res.statusCode).toBe(200);
    const st = await p1.next('state');
    expect(st.playlist).toBeNull();

    const list = (await inject('GET', '/overrides')).json<OverrideDto[]>();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ targetName: 'Холл 1', playlistId: null, createdBy: 'operator' });
    expect(list[0]!.until! - Date.now()).toBeGreaterThan(3500_000);

    const screens = (await inject('GET', '/screens')).json<ScreenDto[]>();
    const sc = screens.find((s) => s.id === s1)!;
    expect(sc.resolved).toMatchObject({ source: 'override-screen', playlistId: null });

    expect((await inject('DELETE', `/overrides/${list[0]!.id}`, undefined, operator)).statusCode).toBe(200);
    const back = await p1.next('state');
    expect(back.playlist?.id).toBe(playlist.id);
    expect(p2.messages.filter((m) => m.type === 'state')).toHaveLength(0);
  });

  it('"until next change" uses the next schedule boundary', async () => {
    const res = await inject('POST', '/overrides', { targets: [{ type: 'group', id: group.id }], playlistId: null, mode: 'next' });
    const { created } = res.json<{ created: { until: number | null }[] }>();
    // Круглосуточное правило группы: следующая смена — ближайшая полночь по Москве.
    const until = created[0]!.until!;
    expect(until).toBeGreaterThan(Date.now());
    expect(new Date(until).getUTCHours()).toBe(21);
    expect(new Date(until).getUTCMinutes()).toBe(0);
    await Promise.all([p1.next('state'), p2.next('state')]);
  });

  it('a new override replaces the previous one for the same target', async () => {
    await inject('POST', '/overrides', { targets: [{ type: 'group', id: group.id }], playlistId: playlist.id, mode: 'forever' });
    const list = (await inject('GET', '/overrides')).json<OverrideDto[]>();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ until: null, playlistId: playlist.id });
  });
});
