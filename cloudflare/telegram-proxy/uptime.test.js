import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import worker from "./worker.js";
import {
  DOWN_MESSAGE,
  INITIAL_STATE,
  RECOVERED_MESSAGE,
  REPEAT_INTERVAL_MS,
  STATE_KEY,
  isHealthy,
  nextUptimeState,
  parseState,
  runUptimeCheck,
  withAlertPending,
} from "./uptime.js";

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const FIVE_MIN = 5 * 60 * 1000;
const HEALTH_URL = "https://mikan.test/api/health";

function fakeKv(initial = {}) {
  const data = new Map(Object.entries(initial));
  const puts = [];
  return {
    data,
    puts,
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value) {
      puts.push([key, value]);
      data.set(key, value);
    },
  };
}

/** Fake fetch: the health URL answers per `serverUp()`, Telegram answers per `telegramOk()`. */
function fakeFetch({ serverUp, telegramOk = () => true }) {
  const sent = [];
  const impl = async (url, init = {}) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return telegramOk()
        ? new Response('{"ok":true}', { status: 200 })
        : new Response('{"ok":false,"description":"Bad Request: chat not found"}', { status: 400 });
    }
    if (!serverUp()) throw new TypeError("fetch failed");
    return new Response('{"ok":true}', { status: 200 });
  };
  return { impl, sent };
}

function env(kv) {
  return { HEALTH_URL, TELEGRAM_BOT_TOKEN: "123:secret", ALERT_CHAT_ID: "-1001", UPTIME: kv };
}

describe("nextUptimeState", () => {
  test("stays quiet after a single failed check", () => {
    const { state, message } = nextUptimeState(INITIAL_STATE, false, T0);
    assert.equal(message, null);
    assert.deepEqual(state, { failures: 1, down: false, lastAlertAt: null });
  });

  test("alerts on the second failed check in a row", () => {
    const { state, message } = nextUptimeState({ failures: 1, down: false, lastAlertAt: null }, false, T0);
    assert.equal(message, DOWN_MESSAGE);
    assert.deepEqual(state, { failures: 2, down: true, lastAlertAt: T0 });
  });

  test("does not repeat the alert within 6 hours", () => {
    const prev = { failures: 2, down: true, lastAlertAt: T0 };
    const { state, message } = nextUptimeState(prev, false, T0 + REPEAT_INTERVAL_MS - 1);
    assert.equal(message, null);
    assert.deepEqual(state, prev, "unchanged, so nothing is written to KV");
  });

  test("repeats the alert once 6 hours have passed", () => {
    const prev = { failures: 2, down: true, lastAlertAt: T0 };
    const now = T0 + REPEAT_INTERVAL_MS;
    const { state, message } = nextUptimeState(prev, false, now);
    assert.equal(message, DOWN_MESSAGE);
    assert.deepEqual(state, { failures: 2, down: true, lastAlertAt: now });
  });

  test("announces recovery once and resets", () => {
    const { state, message } = nextUptimeState({ failures: 5, down: true, lastAlertAt: T0 }, true, T0);
    assert.equal(message, RECOVERED_MESSAGE);
    assert.deepEqual(state, INITIAL_STATE);
  });

  test("a healthy check after a single failure resets silently", () => {
    const { state, message } = nextUptimeState({ failures: 1, down: false, lastAlertAt: null }, true, T0);
    assert.equal(message, null);
    assert.deepEqual(state, INITIAL_STATE);
  });

  test("does not mutate the previous state", () => {
    const prev = Object.freeze({ failures: 1, down: false, lastAlertAt: null });
    assert.doesNotThrow(() => nextUptimeState(prev, false, T0));
  });
});

describe("parseState", () => {
  test("falls back to the initial state for missing or malformed values", () => {
    assert.deepEqual(parseState(null), INITIAL_STATE);
    assert.deepEqual(parseState("not json"), INITIAL_STATE);
    assert.deepEqual(parseState('{"failures":-3,"down":"yes","lastAlertAt":"x"}'), INITIAL_STATE);
  });

  test("reads a stored state", () => {
    const stored = { failures: 4, down: true, lastAlertAt: T0 };
    assert.deepEqual(parseState(JSON.stringify(stored)), stored);
  });
});

describe("withAlertPending", () => {
  test("keeps the previous alert bookkeeping so the next run retries", () => {
    const prev = { failures: 1, down: false, lastAlertAt: null };
    const next = { failures: 2, down: true, lastAlertAt: T0 };
    assert.deepEqual(withAlertPending(prev, next), { failures: 2, down: false, lastAlertAt: null });
  });
});

describe("isHealthy", () => {
  test("is false on a non-2xx answer", async () => {
    const ok = await isHealthy(HEALTH_URL, async () => new Response("Bad Gateway", { status: 502 }));
    assert.equal(ok, false);
  });

  test("is false when the server does not answer in time", async () => {
    const hanging = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    assert.equal(await isHealthy(HEALTH_URL, hanging, 20), false);
  });
});

describe("runUptimeCheck", () => {
  test("a healthy server with no history writes nothing and sends nothing", async () => {
    const kv = fakeKv();
    const fetch = fakeFetch({ serverUp: () => true });
    const result = await runUptimeCheck(env(kv), T0, fetch.impl);
    assert.equal(result.healthy, true);
    assert.equal(kv.puts.length, 0);
    assert.equal(fetch.sent.length, 0);
  });

  test("full outage: one alert, a repeat after 6 hours, one recovery message", async () => {
    const kv = fakeKv();
    let up = false;
    const fetch = fakeFetch({ serverUp: () => up });
    const run = (now) => runUptimeCheck(env(kv), now, fetch.impl);

    await run(T0);
    assert.equal(fetch.sent.length, 0, "no alert after the first failure");

    await run(T0 + FIVE_MIN);
    assert.equal(fetch.sent.length, 1);
    assert.equal(fetch.sent[0].url, "https://api.telegram.org/bot123:secret/sendMessage");
    assert.deepEqual(fetch.sent[0].body, { chat_id: "-1001", text: DOWN_MESSAGE });

    const putsWhenDown = kv.puts.length;
    for (let i = 2; i < 72; i += 1) await run(T0 + i * FIVE_MIN);
    assert.equal(fetch.sent.length, 1, "no repeats inside 6 hours");
    assert.equal(kv.puts.length, putsWhenDown, "no KV writes while nothing changes");

    await run(T0 + FIVE_MIN + REPEAT_INTERVAL_MS);
    assert.equal(fetch.sent.length, 2);
    assert.equal(fetch.sent[1].body.text, DOWN_MESSAGE);

    up = true;
    await run(T0 + 2 * FIVE_MIN + REPEAT_INTERVAL_MS);
    await run(T0 + 3 * FIVE_MIN + REPEAT_INTERVAL_MS);
    assert.equal(fetch.sent.length, 3);
    assert.equal(fetch.sent[2].body.text, RECOVERED_MESSAGE);
    assert.deepEqual(JSON.parse(kv.data.get(STATE_KEY)), INITIAL_STATE);
  });

  test("an undelivered alert is retried on the next run", async () => {
    const kv = fakeKv({ [STATE_KEY]: JSON.stringify({ failures: 1, down: false, lastAlertAt: null }) });
    let telegramUp = false;
    const fetch = fakeFetch({ serverUp: () => false, telegramOk: () => telegramUp });
    const originalError = console.error;
    console.error = () => {};
    try {
      await runUptimeCheck(env(kv), T0, fetch.impl);
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(JSON.parse(kv.data.get(STATE_KEY)), { failures: 2, down: false, lastAlertAt: null });

    telegramUp = true;
    await runUptimeCheck(env(kv), T0 + FIVE_MIN, fetch.impl);
    assert.equal(fetch.sent.length, 2);
    assert.deepEqual(JSON.parse(kv.data.get(STATE_KEY)), { failures: 2, down: true, lastAlertAt: T0 + FIVE_MIN });
  });

  test("refuses to run without its configuration", async () => {
    const fetch = fakeFetch({ serverUp: () => true });
    await assert.rejects(
      runUptimeCheck({ HEALTH_URL, UPTIME: fakeKv() }, T0, fetch.impl),
      /missing TELEGRAM_BOT_TOKEN, ALERT_CHAT_ID/,
    );
  });
});

describe("worker", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("proxy still forwards only the allowed bot, path and query untouched", async () => {
    const forwarded = [];
    globalThis.fetch = async (request) => {
      forwarded.push(request.url);
      return new Response("{}");
    };
    const proxyEnv = { ALLOWED_BOT_IDS: "8960400388" };

    const allowed = await worker.fetch(
      new Request("https://proxy.test/bot8960400388:AAH_x-y/getUpdates?offset=5"),
      proxyEnv,
    );
    const file = await worker.fetch(new Request("https://proxy.test/file/bot8960400388:AAH/photos/a.jpg"), proxyEnv);
    const other = await worker.fetch(new Request("https://proxy.test/bot111:AAH/getMe"), proxyEnv);

    assert.equal(allowed.status, 200);
    assert.equal(file.status, 200);
    assert.equal(other.status, 404);
    assert.deepEqual(forwarded, [
      "https://api.telegram.org/bot8960400388:AAH_x-y/getUpdates?offset=5",
      "https://api.telegram.org/file/bot8960400388:AAH/photos/a.jpg",
    ]);
  });

  test("scheduled handler runs the uptime check", async () => {
    const fetch = fakeFetch({ serverUp: () => false });
    globalThis.fetch = fetch.impl;
    const kv = fakeKv();
    await worker.scheduled({ scheduledTime: T0, cron: "*/5 * * * *" }, env(kv));
    assert.deepEqual(JSON.parse(kv.data.get(STATE_KEY)), { failures: 1, down: false, lastAlertAt: null });
  });
});
