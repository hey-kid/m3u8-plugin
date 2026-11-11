import { describe, expect, it } from 'vitest';
import { classifyCapture, countCaptureStatuses } from './status';

describe('capture response classification', () => {
  it('accepts every integer HTTP 2xx as normal, including responses with no error text', () => {
    for (let statusCode = 200; statusCode < 300; statusCode += 1) {
      expect(classifyCapture({ statusCode })).toBe('normal');
      expect(classifyCapture({ statusCode, error: '' })).toBe('normal');
      expect(classifyCapture({ statusCode, error: '  ' })).toBe('normal');
    }
  });

  it.each([100, 199, 300, 301, 302, 304, 403, 404, 429, 500, 599])(
    'classifies non-2xx HTTP %s as abnormal',
    (statusCode) => { expect(classifyCapture({ statusCode })).toBe('abnormal'); },
  );

  it('prioritizes network errors even when response headers previously reported 2xx', () => {
    expect(classifyCapture({ error: 'net::ERR_CONNECTION_RESET' })).toBe('abnormal');
    expect(classifyCapture({ statusCode: 200, error: 'net::ERR_ABORTED' })).toBe('abnormal');
    expect(classifyCapture({ statusCode: 206, error: 'net::ERR_CONNECTION_RESET' })).toBe('abnormal');
    expect(classifyCapture({ statusCode: 299, error: 'net::ERR_FAILED' })).toBe('abnormal');
    expect(classifyCapture({ statusCode: 0, error: 'net::ERR_FAILED' })).toBe('abnormal');
  });

  it('keeps requests and legacy records without a response pending', () => {
    expect(classifyCapture({})).toBe('pending');
    expect(classifyCapture({ error: '' })).toBe('pending');
  });

  it.each([0, -1, 99, 600, 200.5, 206.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'treats invalid response code %s as pending',
    (statusCode) => { expect(classifyCapture({ statusCode })).toBe('pending'); },
  );

  it('counts mixed request states without mutating records', () => {
    const records = Object.freeze([
      Object.freeze({ statusCode: 200 }),
      Object.freeze({ statusCode: 404 }),
      Object.freeze({ statusCode: 206 }),
      Object.freeze({ statusCode: 200, error: 'net::ERR_ABORTED' }),
      Object.freeze({}),
    ]);
    expect(countCaptureStatuses(records)).toEqual({ all: 5, normal: 2, abnormal: 2, pending: 1 });
    expect(countCaptureStatuses([])).toEqual({ all: 0, normal: 0, abnormal: 0, pending: 0 });
  });
});
