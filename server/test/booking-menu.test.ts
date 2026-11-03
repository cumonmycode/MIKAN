import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';

describe('the bot menu button follows the online booking switch', () => {
  let t: TestApp;
  const refresh = vi.fn(async () => undefined);

  beforeEach(async () => {
    t = await createTestApp();
    refresh.mockClear();
    t.gateway.refreshBookingMenu = refresh;
  });
  afterEach(() => t.close());

  it('refreshes the menu when online booking is turned off or on', async () => {
    expect((await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: false } })).statusCode).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((await t.api('PUT', '/api/settings/studio', { onlineBooking: { enabled: true } })).statusCode).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('leaves the menu alone when other settings change', async () => {
    expect((await t.api('PUT', '/api/settings/studio', { name: 'MIKAN', onlineBooking: { holdMinutes: 20 } })).statusCode).toBe(200);
    expect(refresh).not.toHaveBeenCalled();
  });
});
