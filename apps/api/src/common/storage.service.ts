import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { APP_CONFIG, type AppConfig } from '../config/config';

/**
 * S3-compatible object storage (SeaweedFS in dev, any S3 API in production — ADR-012).
 * Keys are always prefixed `tenants/{tenantId}/` so storage is partitioned per tenant.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly client: S3Client;
  private bucketReady: Promise<void> | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
    });
  }

  static keyFor(tenantId: string, mediaId: string): string {
    return `tenants/${tenantId}/media/${mediaId}`;
  }

  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      const Bucket = this.config.S3_BUCKET;
      try {
        await this.client.send(new HeadBucketCommand({ Bucket }));
      } catch (error) {
        if (!this.config.S3_AUTO_CREATE_BUCKET) throw error;
        await this.client.send(new CreateBucketCommand({ Bucket }));
      }
    })().catch((error: unknown) => {
      this.bucketReady = null; // retry on next call
      throw error;
    });
    return this.bucketReady;
  }

  async put(key: string, body: Buffer, contentType: string, sha256: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        Metadata: { sha256 },
      }),
    );
  }

  async get(key: string): Promise<Readable> {
    await this.ensureBucket();
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
    return out.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
  }

  async ping(): Promise<void> {
    await this.ensureBucket();
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
