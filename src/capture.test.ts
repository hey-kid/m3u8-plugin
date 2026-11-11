import { describe, expect, it } from 'vitest';
import { createCapture, detectPlaylist, isPlaylistUrl, observeCapture } from './capture';
import type { CaptureObservation } from './capture';

const observation = (overrides: Partial<CaptureObservation> = {}): CaptureObservation => ({
  url: 'https://cdn.example.com/movie.m3u8?token=a%2Bb&expires=123',
  time: 100,
  method: 'GET',
  detectedBy: ['url'],
  countRequest: true,
  ...overrides,
});

describe('playlist detection', () => {
  it.each([
    'https://cdn.example.com/a.m3u8',
    'https://cdn.example.com/A.M3U8?token=abc#fragment',
    'http://localhost/a%2Em3u8?name=movie',
    'https://cdn.example.com/bad%escape/a.m3u8',
  ])('recognizes an HTTP playlist path: %s', (url) => {
    expect(isPlaylistUrl(url)).toBe(true);
  });

  it.each([
    'https://example.com/page?video=a.m3u8',
    'https://example.com/a.m3u8.js',
    'https://example.com/a.m3u8/segment.ts',
    'https://example.com/ordinary.mp4',
    'file:///tmp/a.m3u8',
    'blob:https://example.com/a.m3u8',
    'not a URL',
  ])('does not classify unrelated URLs: %s', (url) => {
    expect(detectPlaylist(url)).toEqual([]);
  });

  it.each([
    'application/vnd.apple.mpegurl',
    'application/x-mpegurl',
    'audio/mpegurl',
    'audio/x-mpegurl',
    'Application/Vnd.Apple.Mpegurl ; charset=utf-8',
  ])('recognizes extensionless endpoints by MIME: %s', (value) => {
    expect(detectPlaylist('https://example.com/play?id=3', [
      { name: 'Content-TYPE', value },
    ])).toEqual(['content-type']);
  });

  it('combines independent evidence without examining response bodies', () => {
    expect(detectPlaylist('https://example.com/list.m3u8', [
      { name: 'content-type', value: 'application/vnd.apple.mpegurl' },
      { name: 'x-description', value: 'application/vnd.apple.mpegurl' },
    ])).toEqual(['url', 'content-type']);
    expect(detectPlaylist('https://example.com/play', [
      { name: 'content-type', value: 'video/mp4' },
      { name: 'content-type' },
    ])).toEqual([]);
  });
});

describe('capture aggregation', () => {
  it('preserves a signed URL byte for byte and treats distinct signatures separately', () => {
    const first = observation();
    const second = observation({ url: first.url.replace('a%2Bb', 'a%2bc') });
    const capture = observeCapture(observeCapture(createCapture(3), first), second);
    expect(capture.items.map((item) => item.url)).toEqual([first.url, second.url]);
    expect(capture.items[0].hostname).toBe('cdn.example.com');
  });

  it('counts requests once while merging later response evidence', () => {
    const capture = createCapture(3);
    const before = observeCapture(capture, observation());
    const headers = observeCapture(before, observation({
      time: 110, detectedBy: ['url', 'content-type'], countRequest: false, statusCode: 200,
    }));
    const completed = observeCapture(headers, observation({
      time: 120, detectedBy: [], countRequest: false, statusCode: 200,
    }));
    const repeated = observeCapture(completed, observation({ time: 200 }));
    expect(repeated.items).toHaveLength(1);
    expect(repeated.items[0]).toMatchObject({
      requestCount: 2, firstSeen: 100, lastSeen: 200, detectedBy: ['url', 'content-type'],
    });
    expect(repeated.items[0].statusCode).toBeUndefined();
    expect(capture.items).toEqual([]);
    expect(before.items[0].requestCount).toBe(1);
  });

  it('captures URL requests even when they fail and clears an old error on retry', () => {
    const failed = observeCapture(
      observeCapture(createCapture(3), observation()),
      observation({ time: 101, error: 'net::ERR_FAILED', countRequest: false, detectedBy: [] }),
    );
    expect(failed.items[0].error).toBe('net::ERR_FAILED');
    const retry = observeCapture(failed, observation({ time: 200 }));
    expect(retry.items[0].error).toBeUndefined();
    expect(retry.items[0].requestCount).toBe(2);
  });

  it('does not invent candidates from completion events', () => {
    const capture = createCapture(3);
    expect(observeCapture(capture, observation({ detectedBy: [], countRequest: false })))
      .toBe(capture);
  });

  it('clears an overlapping request error when a later HTTP result arrives', () => {
    let capture = observeCapture(createCapture(3), observation());
    capture = observeCapture(capture, observation({ time: 101 }));
    capture = observeCapture(capture, observation({
      time: 102, countRequest: false, detectedBy: [], error: 'net::ERR_ABORTED',
    }));
    expect(capture.items[0].error).toBe('net::ERR_ABORTED');
    capture = observeCapture(capture, observation({
      time: 103, countRequest: false, statusCode: 200,
    }));
    capture = observeCapture(capture, observation({
      time: 104, countRequest: false, detectedBy: [], statusCode: 200,
    }));
    expect(capture.items[0]).toMatchObject({ requestCount: 2, lastSeen: 104, statusCode: 200 });
    expect(capture.items[0].error).toBeUndefined();
  });

  it('preserves a network error reported with or after HTTP 200', () => {
    const headers = observeCapture(createCapture(3), observation({ statusCode: 200 }));
    for (const statusCode of [undefined, 200]) {
      const failed = observeCapture(headers, observation({
        time: 101, countRequest: false, detectedBy: [], statusCode, error: 'net::ERR_CONNECTION_RESET',
      }));
      expect(failed.items[0]).toMatchObject({ statusCode: 200, error: 'net::ERR_CONNECTION_RESET' });
      const staleSuccess = observeCapture(failed, observation({
        time: 100, countRequest: false, detectedBy: [], statusCode: 200,
      }));
      expect(staleSuccess.items[0]).toMatchObject({ statusCode: 200, error: 'net::ERR_CONNECTION_RESET' });
    }
  });

  it('limits unique URLs without dropping existing entries or stopping their updates', () => {
    let capture = createCapture(3);
    for (let i = 0; i < 301; i += 1) {
      capture = observeCapture(capture, observation({
        url: `https://example.com/${i}.m3u8`, time: i,
      }));
    }
    expect(capture.items).toHaveLength(300);
    expect(capture.limitReached).toBe(true);
    capture = observeCapture(capture, observation({ url: 'https://example.com/0.m3u8', time: 400 }));
    expect(capture.items[0].requestCount).toBe(2);
    expect(capture.items[299].url).toBe('https://example.com/299.m3u8');
  });

  it('does not move timestamps or response state backwards for an older observation', () => {
    const capture = observeCapture(
      observeCapture(createCapture(3, '', 0), observation({ time: 200, statusCode: 200 })),
      observation({ time: 100, countRequest: false, statusCode: 404 }),
    );
    expect(capture.items[0]).toMatchObject({ lastSeen: 200, statusCode: 200 });
    expect(capture.updatedAt).toBe(200);
  });
});
