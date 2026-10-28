import { describe, expect, it } from 'vitest';
import { createApi } from '../public/book/lib/api.js';
import {
  counterText,
  indexFromScroll,
  masterPortfolioUrl,
  photoAlt,
  photoDetails,
  servicePortfolioUrl,
  serviceWorksLabel,
  slidesToLoad,
  stepIndex,
  worksAriaLabel,
  worksLabel,
} from '../public/book/lib/portfolio.js';

const work = (extra: Record<string, unknown> = {}) => ({
  imageUrl: '/uploads/a.jpg',
  caption: null,
  service: null,
  master: { id: 3, name: 'Фатима' },
  ...extra,
});

describe('booking page: portfolio helpers', () => {
  it('labels the works of a master and of a service', () => {
    expect(worksLabel(12)).toBe('Работы (12)');
    expect(worksLabel(0)).toBeNull();
    expect(worksLabel(undefined)).toBeNull();
    expect(worksAriaLabel('Фатима', 1)).toBe('Работы мастера Фатима: 1 фото');
    expect(serviceWorksLabel(4)).toBe('Работы мастеров');
    expect(serviceWorksLabel(0)).toBeNull();
    expect(serviceWorksLabel(null)).toBeNull();
  });

  it('builds the public API paths', () => {
    expect(masterPortfolioUrl(3)).toBe('/api/public/booking/masters/3/portfolio');
    expect(servicePortfolioUrl(7)).toBe('/api/public/booking/portfolio?serviceId=7');
  });

  it('moves between photos without wrapping and loads only the neighbours', () => {
    expect(stepIndex(0, -1, 5)).toBe(0);
    expect(stepIndex(0, 1, 5)).toBe(1);
    expect(stepIndex(4, 1, 5)).toBe(4);
    expect(stepIndex(2, 0, 0)).toBe(0);
    expect(slidesToLoad(0, 5)).toEqual([0, 1]);
    expect(slidesToLoad(2, 5)).toEqual([1, 2, 3]);
    expect(slidesToLoad(4, 5)).toEqual([3, 4]);
    expect(slidesToLoad(0, 1)).toEqual([0]);
    expect(slidesToLoad(0, 0)).toEqual([]);
    expect(indexFromScroll(0, 375, 5)).toBe(0);
    expect(indexFromScroll(390, 375, 5)).toBe(1);
    expect(indexFromScroll(5000, 375, 5)).toBe(4);
    expect(indexFromScroll(100, 0, 5)).toBe(0);
    expect(counterText(0, 12)).toBe('1 из 12');
  });

  it('describes each photo for screen readers and under the picture', () => {
    expect(photoAlt(work({ caption: 'Хеликс, титан' }), 0, 3)).toBe('Хеликс, титан');
    expect(photoAlt(work({ service: { id: 1, name: 'Хеликс' } }), 1, 3)).toBe('Работа мастера Фатима: Хеликс, фото 2 из 3');
    expect(photoAlt(work(), 2, 3)).toBe('Работа мастера Фатима, фото 3 из 3');
    expect(photoAlt({ imageUrl: '/uploads/b.jpg', caption: '  ', service: null }, 0, 1)).toBe('Фото работы 1 из 1');

    expect(photoDetails(work({ caption: 'Хеликс, титан', service: { id: 1, name: 'Хеликс' } }), { showMaster: true })).toEqual({
      caption: 'Хеликс, титан',
      meta: 'Хеликс · мастер Фатима',
    });
    expect(photoDetails(work({ service: { id: 1, name: 'Хеликс' } }), { showMaster: false })).toEqual({ caption: null, meta: 'Хеликс' });
    expect(photoDetails(work(), { showMaster: false })).toEqual({ caption: null, meta: null });
  });

  it('the API client asks the portfolio paths', async () => {
    const urls: string[] = [];
    const api = createApi({
      fetch: (async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    await api.masterPortfolio(3);
    await api.servicePortfolio(7);
    expect(urls).toEqual(['/api/public/booking/masters/3/portfolio', '/api/public/booking/portfolio?serviceId=7']);
  });
});
