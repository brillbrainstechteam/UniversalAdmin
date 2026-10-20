import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ApiKey, CreateApiKeyRequest } from '@uc/contracts';
import { apiKeys, sha256, users, writeAudit, type Tx } from '@uc/db';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';

export const API_KEY_PREFIX = 'uc_key_';
type Row = typeof apiKeys.$inferSelect;
const LAST_USED_WRITE_MS = 60_000;

/**
 * Read-only tenant API keys (Phase 11, ADR-026). The full key is shown once; only its SHA-256 is stored. A key acts
 * for its creator: effective permissions = the creator's current permissions ∩ the key's scopes, GET requests only.
 */
@Injectable()
export class ApiKeysService {
  constructor(private readonly db: DbService) {}

  private async view(tx: Tx, rows: Row[]): Promise<ApiKey[]> {
    const people = await tx.select({ id: users.id, name: users.displayName }).from(users);
    return rows.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes as ApiKey['scopes'],
      createdBy: { id: k.createdBy, name: people.find((p) => p.id === k.createdBy)?.name ?? 'Unknown' },
      expiresAt: k.expiresAt ? iso(k.expiresAt) : null,
      lastUsedAt: k.lastUsedAt ? iso(k.lastUsedAt) : null,
      revokedAt: k.revokedAt ? iso(k.revokedAt) : null,
      createdAt: iso(k.createdAt),
    }));
  }

  async list(ctx: TenantState) {
    return this.db.tenant(ctx.tenantId, async (tx) => ({
      items: await this.view(
        tx,
        await tx
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.tenantId, ctx.tenantId))
          .orderBy(desc(apiKeys.createdAt)),
      ),
    }));
  }

  async create(auth: AuthState, ctx: TenantState, input: CreateApiKeyRequest, meta: RequestMeta) {
    // A key can never carry a permission its creator does not have.
    const missing = input.scopes.filter((s) => !ctx.permissions.has(s));
    if (missing.length)
      throw Errors.validation([{ path: 'scopes', message: `You do not have ${missing.join(', ')}` }]);
    const key = `${API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(apiKeys)
        .values({
          tenantId: ctx.tenantId,
          name: input.name,
          prefix: key.slice(0, API_KEY_PREFIX.length + 6),
          keyHash: sha256(key),
          scopes: [...new Set(input.scopes)],
          createdBy: auth.userId,
          expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
        })
        .returning();
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'api_keys.created',
        entityType: 'api_key',
        entityId: row!.id,
        newValues: { name: row!.name, scopes: row!.scopes, expiresAt: row!.expiresAt?.toISOString() ?? null },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return { apiKey: (await this.view(tx, [row!]))[0]!, key };
    });
  }

  async revoke(auth: AuthState, ctx: TenantState, id: string, meta: RequestMeta) {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date(), revokedBy: auth.userId })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, ctx.tenantId), isNull(apiKeys.revokedAt)))
        .returning();
      if (!row) throw Errors.notFound('Active API key');
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'api_keys.revoked',
        entityType: 'api_key',
        entityId: row.id,
        newValues: { name: row.name },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return (await this.view(tx, [row]))[0]!;
    });
  }

  /** Active key for a bearer token, or null. Updates last-used at most once a minute. */
  async resolve(token: string): Promise<Row | null> {
    if (!token.startsWith(API_KEY_PREFIX) || token.length > 100) return null;
    const now = new Date();
    const [row] = await this.db.system((tx) =>
      tx
        .select()
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.keyHash, sha256(token)),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
          ),
        ),
    );
    if (!row) return null;
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_WRITE_MS)
      await this.db.system((tx) => tx.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id)));
    return row;
  }
}
