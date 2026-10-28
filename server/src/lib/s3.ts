import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { errorMessage } from './errors.js';

/**
 * A minimal S3-compatible client (Yandex Object Storage, Selectel, Cloudflare R2, MinIO, AWS): put (a large file in
 * parts), list and delete objects with path-style addressing and AWS Signature Version 4 — all the off-site backups
 * need, without the SDK.
 */

export interface S3Config {
  /** `https://storage.yandexcloud.net` (no bucket in it). */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SignInput {
  method: string;
  /** The URL as requested (path-style: `/<bucket>/<key>`). */
  url: URL;
  /** Headers to sign besides host / x-amz-date / x-amz-content-sha256. */
  headers?: Record<string, string>;
  payloadHash: string;
  /** `YYYYMMDDTHHMMSSZ` */
  amzDate: string;
}

export const sha256Hex = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it (unreserved characters kept). */
const encode = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export const amzDateOf = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** The `Authorization` header and the headers it covers for one request. */
export function signRequest(config: Pick<S3Config, 'region' | 'accessKeyId' | 'secretAccessKey'>, input: SignInput) {
  const headers: Record<string, string> = {
    host: input.url.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': input.amzDate,
    ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalPath = input.url.pathname
    .split('/')
    .map((segment) => encode(decodeURIComponent(segment)))
    .join('/');
  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [input.method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, day), config.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export class S3Error extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: Buffer }) => Promise<Response>;

const errorCode = (xml: string): string | undefined => /<Code>([^<]+)<\/Code>/.exec(xml)?.[1];

async function send(config: S3Config, method: string, url: URL, body: Buffer | undefined, fetchImpl: Fetch, now: number) {
  const payloadHash = sha256Hex(body ?? '');
  const { headers, authorization } = signRequest(config, { method, url, payloadHash, amzDate: amzDateOf(now) });
  const { host: _host, ...sent } = headers;
  const res = await fetchImpl(url.toString(), { method, headers: { ...sent, authorization }, ...(body ? { body } : {}) });
  if (!res.ok) {
    const code = errorCode(await res.text().catch(() => ''));
    throw new S3Error(`S3 ${method} ${url.pathname}: HTTP ${res.status}${code ? ` ${code}` : ''}`, res.status);
  }
  return res;
}

const objectUrl = (config: S3Config, key: string): URL =>
  new URL(`${config.endpoint.replace(/\/+$/, '')}/${encode(config.bucket)}/${key.split('/').map(encode).join('/')}`);

export async function putObject(config: S3Config, key: string, body: Buffer, fetchImpl: Fetch = fetch, now = Date.now()) {
  await send(config, 'PUT', objectUrl(config, key), body, fetchImpl, now);
}

export async function deleteObject(config: S3Config, key: string, fetchImpl: Fetch = fetch, now = Date.now()) {
  await send(config, 'DELETE', objectUrl(config, key), undefined, fetchImpl, now);
}

/** Keys under `prefix` (one page of up to 1000 is plenty for daily backups kept 30 days). */
export async function listKeys(config: S3Config, prefix: string, fetchImpl: Fetch = fetch, now = Date.now()): Promise<string[]> {
  const url = new URL(`${config.endpoint.replace(/\/+$/, '')}/${encode(config.bucket)}`);
  url.searchParams.set('list-type', '2');
  url.searchParams.set('prefix', prefix);
  const res = await send(config, 'GET', url, undefined, fetchImpl, now);
  const xml = await res.text();
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
}

// ---------- a large file: multipart upload ----------

/** Part size of a multipart upload (S3 wants 5 MB … 5 GB per part, the last one may be smaller). */
export const PART_BYTES = 16 * 1024 * 1024;

export interface PutFileOptions {
  fetchImpl?: Fetch;
  /** The signing time of each request: a long upload signs every part when it is sent (SigV4 allows 15 minutes). */
  clock?: () => number;
  partBytes?: number;
}

/** `?uploads`, `?uploadId=…`: the object URL with a query (a bare `uploads` has no value). */
function withQuery(config: S3Config, key: string, query: string): URL {
  const url = objectUrl(config, key);
  url.search = query;
  return url;
}

const xmlText = (xml: string, tag: string): string | undefined => new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml)?.[1];

/**
 * Uploads a file: one PUT up to `partBytes`, else a multipart upload reading one part at a time (memory stays at one
 * part), aborted when anything fails so the storage keeps no orphan parts.
 */
export async function putFile(config: S3Config, key: string, file: string, opts: PutFileOptions = {}): Promise<{ parts: number }> {
  const { fetchImpl = fetch, clock = Date.now, partBytes = PART_BYTES } = opts;
  const size = (await fs.stat(file)).size;
  if (size <= partBytes) {
    await putObject(config, key, await fs.readFile(file), fetchImpl, clock());
    return { parts: 1 };
  }
  const started = await (await send(config, 'POST', withQuery(config, key, 'uploads'), undefined, fetchImpl, clock())).text();
  const uploadId = xmlText(started, 'UploadId');
  if (!uploadId) throw new S3Error(`S3 POST ${objectUrl(config, key).pathname}: no UploadId`, 200);
  const query = `uploadId=${encode(uploadId)}`;
  try {
    const etags = await putParts(config, key, file, size, { fetchImpl, clock, partBytes, uploadId });
    const body = Buffer.from(
      `<CompleteMultipartUpload>${etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`,
    );
    const done = await (await send(config, 'POST', withQuery(config, key, query), body, fetchImpl, clock())).text();
    // S3 may answer 200 and put the error in the body.
    const code = done.includes('<Error>') ? errorCode(done) : undefined;
    if (code) throw new S3Error(`S3 POST ${objectUrl(config, key).pathname}: ${code}`, 200);
    return { parts: etags.length };
  } catch (err) {
    const abortFailure = await send(config, 'DELETE', withQuery(config, key, query), undefined, fetchImpl, clock()).then(
      () => null,
      (abortErr: unknown) => abortErr,
    );
    if (!abortFailure) throw err;
    // The uploaded parts stay in the bucket (until its lifecycle rule removes them): say so with the cause.
    throw new S3Error(`${errorMessage(err)}; отменить загрузку частей не удалось: ${errorMessage(abortFailure)}`, err instanceof S3Error ? err.status : 0);
  }
}

/** Sends the parts in order; returns their ETags. */
async function putParts(
  config: S3Config,
  key: string,
  file: string,
  size: number,
  opts: Required<PutFileOptions> & { uploadId: string },
): Promise<string[]> {
  const etags: string[] = [];
  const handle = await fs.open(file, 'r');
  try {
    for (let offset = 0; offset < size; offset += opts.partBytes) {
      const part = Buffer.alloc(Math.min(opts.partBytes, size - offset));
      const number = etags.length + 1;
      const { bytesRead } = await handle.read(part, 0, part.length, offset);
      if (bytesRead !== part.length) throw new Error(`Файл ${file} изменился во время выгрузки (часть ${number})`);
      const url = withQuery(config, key, `partNumber=${number}&uploadId=${encode(opts.uploadId)}`);
      const res = await send(config, 'PUT', url, part, opts.fetchImpl, opts.clock());
      const etag = res.headers.get('etag');
      if (!etag) throw new S3Error(`S3 PUT ${url.pathname}: part ${number} without ETag`, res.status);
      etags.push(etag);
    }
  } finally {
    await handle.close();
  }
  return etags;
}
