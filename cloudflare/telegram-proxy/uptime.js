// External uptime check for the MIKAN server, run by the worker's cron trigger.
// The server's own staff alerts can't report that the server or its network is down, so the worker
// polls HEALTH_URL from outside and writes to the staff chat straight through api.telegram.org.
// State lives in the UPTIME KV namespace; the decision logic is pure so it can be tested without Workers.

export const DOWN_MESSAGE = "⚠️ Сервер MIKAN не отвечает: приложение и бот недоступны";
export const RECOVERED_MESSAGE = "✅ Сервер MIKAN снова работает";

export const FAILURES_BEFORE_ALERT = 2;
export const REPEAT_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const HEALTH_TIMEOUT_MS = 10_000;
export const TELEGRAM_TIMEOUT_MS = 10_000;
export const STATE_KEY = "uptime-state";

const TELEGRAM_ORIGIN = "https://api.telegram.org";

export const INITIAL_STATE = Object.freeze({ failures: 0, down: false, lastAlertAt: null });

/** Reads the KV value back into a state, falling back to INITIAL_STATE on anything malformed. */
export function parseState(raw) {
  if (raw == null) return INITIAL_STATE;
  try {
    const value = JSON.parse(raw);
    const failures = Number.isInteger(value?.failures) && value.failures >= 0 ? value.failures : 0;
    const down = value?.down === true;
    const lastAlertAt = Number.isFinite(value?.lastAlertAt) ? value.lastAlertAt : null;
    return { failures, down, lastAlertAt };
  } catch {
    return INITIAL_STATE;
  }
}

export function sameState(a, b) {
  return a.failures === b.failures && a.down === b.down && a.lastAlertAt === b.lastAlertAt;
}

/**
 * Decides the next state after one health check and which message, if any, to send.
 * Down is declared after FAILURES_BEFORE_ALERT failed checks in a row; while down the alert repeats
 * at most once per REPEAT_INTERVAL_MS; the first healthy check after that sends one recovery message.
 */
export function nextUptimeState(prev, healthy, now) {
  if (healthy) {
    return { state: INITIAL_STATE, message: prev.down ? RECOVERED_MESSAGE : null };
  }

  // Capped so a long outage leaves the stored state unchanged between alerts (no KV write every run).
  const failures = Math.min(prev.failures + 1, FAILURES_BEFORE_ALERT);
  if (failures < FAILURES_BEFORE_ALERT) {
    return { state: { ...prev, failures }, message: null };
  }

  const repeatDue = prev.lastAlertAt === null || now - prev.lastAlertAt >= REPEAT_INTERVAL_MS;
  if (!prev.down || repeatDue) {
    return { state: { failures, down: true, lastAlertAt: now }, message: DOWN_MESSAGE };
  }
  return { state: { ...prev, failures }, message: null };
}

/** The state to keep when the message couldn't be delivered: the alert stays pending for the next run. */
export function withAlertPending(prev, next) {
  return { ...next, down: prev.down, lastAlertAt: prev.lastAlertAt };
}

export async function isHealthy(url, fetchImpl, timeoutMs = HEALTH_TIMEOUT_MS) {
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": "mikan-uptime-check" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export async function sendTelegramMessage(token, chatId, text, fetchImpl) {
  try {
    const response = await fetchImpl(`${TELEGRAM_ORIGIN}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (response.ok) {
      await response.body?.cancel();
      return true;
    }
    // Telegram's error description never contains the token; the URL does, so it isn't logged.
    console.error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
    return false;
  } catch (error) {
    console.error(`Telegram sendMessage failed: ${error?.name ?? "Error"}`);
    return false;
  }
}

function requireConfig(env) {
  const missing = ["HEALTH_URL", "TELEGRAM_BOT_TOKEN", "ALERT_CHAT_ID"].filter((name) => !env[name]);
  if (!env.UPTIME) missing.push("UPTIME (KV binding)");
  if (missing.length > 0) {
    throw new Error(`Uptime check is not configured: missing ${missing.join(", ")}`);
  }
}

/** One cron run: check the server, send an alert if the state calls for it, persist the state. */
export async function runUptimeCheck(env, now = Date.now(), fetchImpl = (...args) => fetch(...args)) {
  requireConfig(env);

  const prev = parseState(await env.UPTIME.get(STATE_KEY));
  const healthy = await isHealthy(env.HEALTH_URL, fetchImpl);
  const decision = nextUptimeState(prev, healthy, now);

  let state = decision.state;
  if (decision.message) {
    const sent = await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, env.ALERT_CHAT_ID, decision.message, fetchImpl);
    if (!sent) state = withAlertPending(prev, state);
  }

  // Skip the write while nothing changes (the usual healthy run) to stay well inside the KV write quota.
  if (!sameState(prev, state)) {
    await env.UPTIME.put(STATE_KEY, JSON.stringify(state));
  }
  return { healthy, message: decision.message, state };
}
