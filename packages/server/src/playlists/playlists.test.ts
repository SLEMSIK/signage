import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { MediaDto, PlaylistDto, PlaylistSummaryDto } from '@signage/shared';
import { schedules } from '../db/schema.js';
import { createTestApp, type TestApp } from '../test-utils/app.js';
import { listenAndPair, type FakePlayer } from '../test-utils/fakePlayer.js';

function multipart(filename: string, data: Buffer) {
  const boundary = '----signage' + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n\r\n`);
  return { payload: Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`)]), ct: `multipart/form-data; boundary=${boundary}` };
}

describe('playlists', () => {
  let t: TestApp;
  let admin: string;
  let player: FakePlayer;
  let screenId: number;
  let imgA: MediaDto;
  let imgB: MediaDto;
  let html: MediaDto;

  const up = async (name: string, data: Buffer) => {
    const mp = multipart(name, data);
    return (await t.app.inject({ method: 'POST', url: '/api/admin/media', payload: mp.payload, headers: { 'content-type': mp.ct, cookie: admin } })).json<MediaDto>();
  };

  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.login('admin');
    const png = (c: string) => sharp({ create: { width: 16, height: 9, channels: 3, background: c } }).png().toBuffer();
    imgA = await up('a.png', await png('#f00'));
    imgB = await up('b.png', await png('#0f0'));
    html = await up('w.html', Buffer.from('<p>hi</p>'));
    ({ player, screenId } = await listenAndPair(t, admin, 'Холл'));
  });
  afterAll(async () => {
    player.close();
    await t.close();
  });

  let pl: PlaylistDto;

  it('creates a playlist with computed durations', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/admin/playlists',
      headers: { cookie: admin },
      payload: {
        name: 'Утро',
        items: [
          { mediaId: imgA.id, durationSec: null, fit: null, transition: 'fade' },
          { mediaId: imgB.id, durationSec: 5, fit: 'cover', transition: 'none' },
          { mediaId: html.id, durationSec: null, fit: null, transition: 'none' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    pl = res.json<PlaylistDto>();
    expect(pl.items.map((i) => i.position)).toEqual([0, 1, 2]);
    expect(pl.totalDurationSec).toBe(10 + 5 + 30);
    const list = (await t.app.inject({ url: '/api/admin/playlists', headers: { cookie: admin } })).json<PlaylistSummaryDto[]>();
    expect(list[0]).toMatchObject({ name: 'Утро', itemCount: 3 });
  });

  it('rejects unknown media', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/admin/playlists',
      headers: { cookie: admin },
      payload: { name: 'x', items: [{ mediaId: 9999, durationSec: null, fit: null, transition: 'none' }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('pushes state to the screen when scheduled, and again when the playlist changes', async () => {
    t.app.ctx.db.orm
      .insert(schedules)
      .values({ targetType: 'screen', targetId: screenId, playlistId: pl.id, days: 127, startTime: '00:00', endTime: '00:00', priority: 0, enabled: true })
      .run();
    t.app.ctx.events.changed('schedules');
    const st = await player.next('state');
    expect(st.playlist?.id).toBe(pl.id);
    expect(st.playlist?.items.map((i) => [i.type, i.durationSec, i.fit, i.transition])).toEqual([
      ['image', 10, 'contain', 'fade'],
      ['image', 5, 'cover', 'none'],
      ['html', 30, 'contain', 'none'],
    ]);
    expect(st.playlist?.items[2]!.url).toMatch(/^\/content\/\d+\/index\.html/);

    const upd = await t.app.inject({
      method: 'PUT',
      url: `/api/admin/playlists/${pl.id}`,
      headers: { cookie: admin },
      payload: { name: 'Утро', items: [{ mediaId: imgB.id, durationSec: 7, fit: 'stretch', transition: 'none' }] },
    });
    expect(upd.statusCode).toBe(200);
    const st2 = await player.next('state');
    expect(st2.version).not.toBe(st.version);
    expect(st2.playlist?.items).toHaveLength(1);
  });

  it('removing used media updates the playlist and the screen', async () => {
    const del = await t.app.inject({ method: 'DELETE', url: `/api/admin/media/${imgB.id}`, headers: { cookie: admin } });
    expect(del.statusCode).toBe(409);
    expect(del.json()).toMatchObject({ details: { playlists: [{ name: 'Утро' }] } });
    await t.app.inject({ method: 'DELETE', url: `/api/admin/media/${imgB.id}?force=1`, headers: { cookie: admin } });
    const st = await player.next('state');
    // Пустой плейлист = чёрный экран.
    expect(st.playlist).toBeNull();
  });

  it('warns before deleting a scheduled playlist, then cascades', async () => {
    const del = await t.app.inject({ method: 'DELETE', url: `/api/admin/playlists/${pl.id}`, headers: { cookie: admin } });
    expect(del.statusCode).toBe(409);
    const forced = await t.app.inject({ method: 'DELETE', url: `/api/admin/playlists/${pl.id}?force=1`, headers: { cookie: admin } });
    expect(forced.statusCode).toBe(200);
    expect(t.app.ctx.db.orm.select().from(schedules).all()).toHaveLength(0);
  });
});
