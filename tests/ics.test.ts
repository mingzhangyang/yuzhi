import { describe, expect, it } from 'vitest';
import { parseIcs } from '../src/ics';
import { normalizeIcsUrl, handleIcsRequest, isPrivateHost } from '../shared/icsProxy';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
X-WR-CALNAME:工作
BEGIN:VTIMEZONE
TZID:Asia/Shanghai
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+0800
TZOFFSETTO:+0800
TZNAME:CST
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:weekly-1
DTSTART;TZID=Asia/Shanghai:20260907T100000
DTEND;TZID=Asia/Shanghai:20260907T110000
RRULE:FREQ=WEEKLY;COUNT=5
EXDATE;TZID=Asia/Shanghai:20260914T100000
SUMMARY:团队周会
END:VEVENT
BEGIN:VEVENT
UID:weekly-1
RECURRENCE-ID;TZID=Asia/Shanghai:20260921T100000
DTSTART;TZID=Asia/Shanghai:20260921T150000
DTEND;TZID=Asia/Shanghai:20260921T160000
SUMMARY:团队周会（改到下午）
END:VEVENT
BEGIN:VEVENT
UID:single-1
DTSTART:20260910T013000Z
DTEND:20260910T023000Z
SUMMARY:牙医
END:VEVENT
BEGIN:VEVENT
UID:allday-1
DTSTART;VALUE=DATE:20260915
DTEND;VALUE=DATE:20260916
SUMMARY:中秋
END:VEVENT
BEGIN:VEVENT
UID:nyc-1
DTSTART;TZID=America/New_York:20260911T090000
DTEND;TZID=America/New_York:20260911T100000
SUMMARY:跨时区会议
END:VEVENT
BEGIN:VEVENT
UID:cancel-1
DTSTART:20260912T013000Z
DTEND:20260912T023000Z
STATUS:CANCELLED
SUMMARY:取消了
END:VEVENT
END:VCALENDAR`;

describe('ics 解析', () => {
  const r = parseIcs(ICS, 'src', new Date('2026-09-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'));
  it('展开重复事件，处理例外和排除日期', () => {
    const weekly = r.events.filter((e) => e.uid === 'weekly-1');
    expect(weekly.map((e) => e.start)).toEqual([
      '2026-09-07T02:00:00.000Z',
      '2026-09-21T07:00:00.000Z',
      '2026-09-28T02:00:00.000Z',
      '2026-10-05T02:00:00.000Z',
    ]);
    expect(weekly[1].title).toBe('团队周会（改到下午）');
    expect(new Set(weekly.map((e) => e.id)).size).toBe(4);
    expect(weekly[0].id).toBe('src|weekly-1|2026-09-07T02:00:00.000Z');
  });
  it('UTC、全天、缺少 VTIMEZONE 的时区、取消的事件', () => {
    expect(r.calendarName).toBe('工作');
    expect(r.events.find((e) => e.uid === 'single-1')!.start).toBe('2026-09-10T01:30:00.000Z');
    expect(r.events.find((e) => e.uid === 'allday-1')!.allDay).toBe(true);
    expect(r.events.find((e) => e.uid === 'nyc-1')!.start).toBe('2026-09-11T13:00:00.000Z');
    expect(r.events.find((e) => e.uid === 'cancel-1')).toBeUndefined();
  });
});

describe('ics 代理', () => {
  it('webcal 转 https，拒绝内网地址', () => {
    expect(normalizeIcsUrl('webcal://example.com/a.ics').toString()).toBe('https://example.com/a.ics');
    expect(() => normalizeIcsUrl('http://127.0.0.1/a.ics')).toThrow();
    expect(() => normalizeIcsUrl('file:///etc/passwd')).toThrow();
    expect(() => normalizeIcsUrl(null)).toThrow();
  });
  it('只转发日历内容', async () => {
    const ok = (async () => new Response('BEGIN:VCALENDAR\nEND:VCALENDAR')) as unknown as typeof fetch;
    const bad = (async () => new Response('<html>')) as unknown as typeof fetch;
    const r1 = await handleIcsRequest('https://x/api/ics?url=https%3A%2F%2Fexample.com%2Fa.ics', ok);
    expect(r1.status).toBe(200);
    const r2 = await handleIcsRequest('https://x/api/ics?url=https%3A%2F%2Fexample.com%2Fa.ics', bad);
    expect(r2.status).toBe(422);
  });

  it('按规范解析地址，拒绝各种写法的内网地址', () => {
    const bad = [
      'http://[::ffff:127.0.0.1]/a.ics',
      'http://[::ffff:7f00:1]/a.ics',
      'http://[::ffff:10.0.0.1]/a.ics',
      'http://[::127.0.0.1]/a.ics',
      'http://[64:ff9b::a9fe:a9fe]/a.ics',
      'http://[2002:7f00:1::]/a.ics',
      'http://[::1]/a.ics',
      'http://[::]/a.ics',
      'http://[fd12::1]/a.ics',
      'http://[fe80::1]/a.ics',
      'http://2130706433/a.ics',
      'http://0x7f.1/a.ics',
      'http://017700000001/a.ics',
      'http://169.254.169.254/latest',
      'http://100.64.0.1/a.ics',
      'http://0.0.0.0/a.ics',
      'http://foo.localhost/a.ics',
      'http://printer.local/a.ics',
    ];
    for (const u of bad) expect(() => normalizeIcsUrl(u), u).toThrow('内网');
    for (const u of ['https://calendar.google.com/x.ics', 'https://[2606:4700::1111]/x.ics', 'https://8.8.8.8/x.ics', 'https://[::ffff:8.8.8.8]/x.ics']) expect(() => normalizeIcsUrl(u), u).not.toThrow();
    expect(isPrivateHost('LOCALHOST.')).toBe(true);
  });
  it('重定向的每一跳都重新校验，不跟到内网', async () => {
    const calls: string[] = [];
    const redirecting = (async (u: string) => {
      calls.push(u);
      if (u.includes('example.com')) return new Response(null, { status: 302, headers: { location: 'http://[::ffff:127.0.0.1]/secret' } });
      return new Response('BEGIN:VCALENDAR\nEND:VCALENDAR');
    }) as unknown as typeof fetch;
    const r = await handleIcsRequest('https://x/api/ics?url=https%3A%2F%2Fexample.com%2Fa.ics', redirecting);
    expect(r.status).toBe(400);
    expect(calls).toEqual(['https://example.com/a.ics']);
    const ok = (async (u: string) => (u.endsWith('/a.ics') ? new Response(null, { status: 301, headers: { location: '/b.ics' } }) : new Response('BEGIN:VCALENDAR\nEND:VCALENDAR'))) as unknown as typeof fetch;
    expect((await handleIcsRequest('https://x/api/ics?url=https%3A%2F%2Fexample.com%2Fa.ics', ok)).status).toBe(200);
  });
  it('没有 content-length 的超大响应也会被截断', async () => {
    const big = (async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); } }))) as unknown as typeof fetch;
    const r = await handleIcsRequest('https://x/api/ics?url=https%3A%2F%2Fexample.com%2Fa.ics', big);
    expect(r.status).toBe(413);
  });
});
