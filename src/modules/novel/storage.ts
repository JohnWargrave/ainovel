import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

// S3-compatible object storage for covers and raw import files: Cloudflare R2 in production,
// SeaweedFS from docker-compose.yml in development.
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
}

class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    private readonly publicBaseUrl: string,
  ) {
    this.client = new S3Client({
      region: env.S3_REGION ?? 'auto',
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            },
          }
        : {}),
      // SDK 3.729+ adds a CRC32 checksum to every put (sent as an aws-chunked trailer) and asks for
      // one on every get. Cloudflare R2 rejects the chunked-signed trailer, and AWS documents
      // WHEN_REQUIRED as the opt-out for S3-compatible stores; checksums still go out where an
      // operation needs one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Keys are content-addressed by a fresh uuid, so objects never change once written.
      CacheControl: 'public, max-age=31536000, immutable',
    });
    try {
      await this.client.send(command);
    } catch (err) {
      // A fresh self-hosted store (SeaweedFS in docker-compose) starts without the bucket. Managed
      // buckets (S3/R2) already exist, so this path never runs there.
      if (!(err instanceof Error) || err.name !== 'NoSuchBucket') throw err;
      await this.client
        .send(new CreateBucketCommand({ Bucket: this.bucket }))
        .catch((createErr: unknown) => {
          if (!(createErr instanceof Error) || createErr.name !== 'BucketAlreadyOwnedByYou') {
            throw createErr;
          }
        });
      await this.client.send(command);
    }
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new AppError('STORAGE_OBJECT_MISSING', 'Stored object is empty', 500);
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  publicUrl(key: string): string {
    return `${this.publicBaseUrl.replace(/\/+$/u, '')}/${key}`;
  }
}

// In-process store for tests and local experiments without a bucket.
export class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) {
      return Promise.reject(new AppError('STORAGE_OBJECT_MISSING', 'Stored object not found', 404));
    }
    return Promise.resolve(object.body);
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  publicUrl(key: string): string {
    return `https://storage.invalid/${key}`;
  }
}

let override: ObjectStorage | null = null;
let configured: ObjectStorage | null = null;

export function setObjectStorage(storage: ObjectStorage | null): void {
  override = storage;
}

export function getObjectStorage(): ObjectStorage {
  if (override) return override;
  if (configured) return configured;
  if (!env.S3_BUCKET || !env.S3_PUBLIC_BASE_URL) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Object storage is not configured (S3_BUCKET, S3_PUBLIC_BASE_URL)',
      503,
    );
  }
  configured = new S3ObjectStorage(env.S3_BUCKET, env.S3_PUBLIC_BASE_URL);
  return configured;
}

// Sniffs the real type from magic bytes: the multipart Content-Type is client-supplied.
export function detectImageType(data: Buffer): { contentType: string; ext: string } | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { contentType: 'image/jpeg', ext: 'jpg' };
  }
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { contentType: 'image/png', ext: 'png' };
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { contentType: 'image/webp', ext: 'webp' };
  }
  return null;
}
