import { createPrivateKey, type KeyObject } from 'node:crypto';

/** Staff push notifications through APNs with token auth (docs/API.md «Push notifications»). */
export interface ApnsConfig {
  /** Key ID of the `.p8` key (Apple Developer → Keys), 10 characters. */
  keyId: string;
  /** Developer team id, 10 characters. */
  teamId: string;
  /** The iOS app's bundle id: the `apns-topic` of every push. */
  bundleId: string;
  /** The `.p8` signing key (EC P-256, signs ES256 provider tokens). */
  privateKey: KeyObject;
}

export const APNS_ENV_KEYS = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_PRIVATE_KEY', 'APNS_BUNDLE_ID'] as const;
export type ApnsEnv = Partial<Record<(typeof APNS_ENV_KEYS)[number], string>>;

const APPLE_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** The `.p8` file is a PEM PKCS#8 EC P-256 key; the env holds it in base64. Null when it is anything else. */
function p8KeyOf(base64: string): KeyObject | null {
  const pem = Buffer.from(base64, 'base64').toString('utf8');
  if (!pem.includes('-----BEGIN PRIVATE KEY-----')) return null;
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null;
  } catch {
    return null;
  }
}

/**
 * Pushes need all four settings; none of them → off, quietly. A partial or invalid set is reported (logged once at
 * start), never half-used.
 */
export function apnsConfigOf(env: ApnsEnv): { config: ApnsConfig | null; problem: string | null } {
  const missing = APNS_ENV_KEYS.filter((k) => !env[k]);
  if (missing.length === APNS_ENV_KEYS.length) return { config: null, problem: null };
  if (missing.length > 0) return { config: null, problem: `не заданы ${missing.join(', ')}` };
  const fail = (problem: string) => ({ config: null, problem });
  const { APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_BUNDLE_ID: bundleId } = env as Required<ApnsEnv>;
  if (!APPLE_ID.test(keyId)) return fail('APNS_KEY_ID — 10 латинских букв и цифр (Key ID ключа в Apple Developer → Keys)');
  if (!APPLE_ID.test(teamId)) return fail('APNS_TEAM_ID — 10 латинских букв и цифр (Team ID в Apple Developer → Membership)');
  if (!BUNDLE_ID.test(bundleId)) return fail('APNS_BUNDLE_ID — идентификатор приложения, например com.mikanstudio.crm');
  const privateKey = p8KeyOf(env.APNS_PRIVATE_KEY!);
  if (!privateKey) {
    return fail("APNS_PRIVATE_KEY — содержимое файла AuthKey_<KEY_ID>.p8 в base64 одной строкой (base64 -i AuthKey_<KEY_ID>.p8 | tr -d '\\n')");
  }
  return { config: { keyId, teamId, bundleId, privateKey }, problem: null };
}
