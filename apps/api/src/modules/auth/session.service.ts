import { Inject, Injectable } from '@nestjs/common';
import type { Audience } from '@uc/contracts';
import { generateToken, sessions, sha256, supportGrants, users } from '@uc/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { CookieOptions, Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { DbService } from '../../db/db.service';
import type { AuthState } from '../../common/request';

export const SESSION_COOKIES: Record<Audience, string> = {
  merchant: 'uc_m_sess',
  platform: 'uc_p_sess',
  buyer: 'uc_b_sess',
};
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

/** Opaque, server-side revocable sessions; only the SHA-256 of the token is stored (ADR-003). */
@Injectable()
export class SessionService {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private ttl(audience: Audience): number {
    return audience === 'platform' ? this.config.session.platformTtlMs : this.config.session.merchantTtlMs;
  }

  async create(
    userId: string,
    audience: Audience,
    meta: { ip: string | null; userAgent: string | null },
    /** Phase 12: a support session ends with its grant, never later than the normal session lifetime. */
    support?: { grantId: string; expiresAt: Date },
  ): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
    const token = generateToken();
    const normal = Date.now() + this.ttl(audience);
    const expiresAt = new Date(support ? Math.min(normal, support.expiresAt.getTime()) : normal);
    const [row] = await this.db.system((tx) =>
      tx
        .insert(sessions)
        .values({
          tokenHash: sha256(token),
          userId,
          audience,
          expiresAt,
          ip: meta.ip,
          userAgent: meta.userAgent,
          supportGrantId: support?.grantId ?? null,
        })
        .returning({ id: sessions.id }),
    );
    if (!row) throw new Error('session insert failed');
    return { token, sessionId: row.id, expiresAt };
  }

  tokenFrom(req: Request, audience: Audience): string | undefined {
    const value = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIES[audience]];
    return typeof value === 'string' && value.length >= 20 && value.length <= 100 ? value : undefined;
  }

  /** Resolves an active, unexpired, non-idle session for an active user, or null. */
  async resolve(token: string | undefined, audience: Audience): Promise<AuthState | null> {
    if (!token) return null;
    const now = new Date();
    const [row] = await this.db.system((tx) =>
      tx
        .select({
          sessionId: sessions.id,
          lastSeenAt: sessions.lastSeenAt,
          expiresAt: sessions.expiresAt,
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          userStatus: users.status,
          supportGrantId: sessions.supportGrantId,
          grantTenantId: supportGrants.tenantId,
          grantStatus: supportGrants.status,
          grantExpiresAt: supportGrants.expiresAt,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .leftJoin(supportGrants, eq(supportGrants.id, sessions.supportGrantId))
        .where(
          and(
            eq(sessions.tokenHash, sha256(token)),
            eq(sessions.audience, audience),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, now),
          ),
        ),
    );
    if (!row || row.userStatus !== 'active') return null;
    // A support session lives only while its grant is approved and unexpired (revoke/expiry end it at once).
    let support: AuthState['support'];
    if (row.supportGrantId) {
      if (
        row.grantStatus !== 'approved' ||
        !row.grantExpiresAt ||
        row.grantExpiresAt <= now ||
        !row.grantTenantId
      )
        return null;
      support = { grantId: row.supportGrantId, tenantId: row.grantTenantId, expiresAt: row.grantExpiresAt };
    }
    if (now.getTime() - row.lastSeenAt.getTime() > this.config.session.idleTimeoutMs) {
      await this.revoke(row.sessionId);
      return null;
    }
    if (now.getTime() - row.lastSeenAt.getTime() > LAST_SEEN_WRITE_INTERVAL_MS) {
      await this.db.system((tx) =>
        tx.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId)),
      );
    }
    return {
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      sessionId: row.sessionId,
      audience,
      sessionExpiresAt: row.expiresAt,
      ...(support ? { support } : {}),
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.system((tx) =>
      tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt))),
    );
  }

  /** Ends every session opened under a support grant (on revoke). */
  async revokeForGrant(grantId: string): Promise<number> {
    const rows = await this.db.system((tx) =>
      tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.supportGrantId, grantId), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id }),
    );
    return rows.length;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const rows = await this.db.system((tx) =>
      tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id }),
    );
    return rows.length;
  }

  private cookieOptions(audience: Audience): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.COOKIE_SECURE,
      path: '/',
      maxAge: this.ttl(audience),
    };
  }

  setCookie(res: Response, audience: Audience, token: string): void {
    res.cookie(SESSION_COOKIES[audience], token, this.cookieOptions(audience));
  }

  clearCookie(res: Response, audience: Audience): void {
    const { maxAge: _maxAge, ...options } = this.cookieOptions(audience);
    res.clearCookie(SESSION_COOKIES[audience], options);
  }
}
