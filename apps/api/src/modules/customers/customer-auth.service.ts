import { Inject, Injectable } from '@nestjs/common';
import type { CustomerLoginRequest, RegisterCustomerRequest } from '@uc/contracts';
import {
  consentEvents,
  customerSessions,
  customers,
  enqueueEvent,
  generateToken,
  hashPassword,
  sha256,
  verifyPassword,
  writeAudit,
} from '@uc/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { CookieOptions, Request, Response } from 'express';
import { AppError } from '../../common/errors';
import type { AppRequest, RequestMeta } from '../../common/request';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { DbService } from '../../db/db.service';
import { RedisService } from '../../db/redis.service';
import { loadFeatures } from '../access/access.service';
import { StorefrontResolver } from '../storefront/storefront.controller';

export const CUSTOMER_COOKIE = 'uc_c_sess';
/** Storefront sessions last a week (absolute); they are revocable server-side. */
const CUSTOMER_SESSION_MS = 7 * 24 * 3600_000;

export interface Shop {
  tenantId: string;
  channelId: string;
  features: string[];
  storefrontName: string;
  currency: string;
  isDemo: boolean;
}
export type CustomerRow = typeof customers.$inferSelect;
export interface CustomerScope extends Shop {
  customer: CustomerRow;
  sessionId: string;
  sessionExpiresAt: Date;
}

let dummyHash: Promise<string> | undefined;

/**
 * Storefront customer identity (Phase 09, ADR-024): accounts belong to one merchant's B2C storefront, separate from
 * staff and buyers. Same protections as staff sign-in: argon2id, per-IP and per-email throttling, lockout,
 * uniform "incorrect" errors, opaque hashed session tokens.
 */
@Injectable()
export class CustomerAuthService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly resolver: StorefrontResolver,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The B2C storefront for this request's domain; accounts exist only there. */
  async shop(req: AppRequest): Promise<Shop> {
    const { tenantId, channelId, preset, config } = await this.resolver.resolveContext(
      this.resolver.hostOf(req),
    );
    if (config.channel.type !== 'b2c_storefront')
      throw new AppError(404, 'STOREFRONT_NOT_FOUND', 'Customer accounts are not available on this domain');
    const features = await this.db.tenant(tenantId, (tx) => loadFeatures(tx, tenantId, preset));
    if (!features.includes('customers'))
      throw new AppError(404, 'STOREFRONT_NOT_FOUND', 'Customer accounts are not available on this domain');
    return {
      tenantId,
      channelId,
      features,
      storefrontName: config.channel.name,
      currency: config.currency,
      isDemo: config.tenant.isDemo,
    };
  }

  tokenFrom(req: Request): string | undefined {
    const v = (req.cookies as Record<string, string> | undefined)?.[CUSTOMER_COOKIE];
    return typeof v === 'string' && v.length >= 20 && v.length <= 100 ? v : undefined;
  }

  /** Signed-in customer of this storefront, or null (expired, revoked, disabled, or another tenant's session). */
  async resolve(shop: Shop, token: string | undefined): Promise<CustomerScope | null> {
    if (!token) return null;
    const now = new Date();
    const [row] = await this.db.tenant(shop.tenantId, (tx) =>
      tx
        .select({ s: customerSessions, c: customers })
        .from(customerSessions)
        .innerJoin(customers, eq(customers.id, customerSessions.customerId))
        .where(
          and(
            eq(customerSessions.tokenHash, sha256(token)),
            eq(customerSessions.tenantId, shop.tenantId),
            isNull(customerSessions.revokedAt),
            gt(customerSessions.expiresAt, now),
          ),
        ),
    );
    if (!row || row.c.status !== 'active') return null;
    return { ...shop, customer: row.c, sessionId: row.s.id, sessionExpiresAt: row.s.expiresAt };
  }

  async require(req: AppRequest): Promise<CustomerScope> {
    const shop = await this.shop(req);
    const scope = await this.resolve(shop, this.tokenFrom(req));
    if (!scope) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in to your account');
    return scope;
  }

  private async throttle(meta: RequestMeta, email: string, kind: 'login' | 'register') {
    const { perIp, perEmail, windowSeconds } = this.config.loginRateLimit;
    const ipOk = await this.redis.hit(`rl:c-${kind}:ip:${meta.ip ?? 'unknown'}`, perIp, windowSeconds);
    const emailOk = await this.redis.hit(`rl:c-${kind}:email:${email}`, perEmail, windowSeconds);
    if (!ipOk || !emailOk) throw new AppError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.');
  }

  private async startSession(shop: Shop, customerId: string, meta: RequestMeta) {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_MS);
    await this.db.tenant(shop.tenantId, (tx) =>
      tx.insert(customerSessions).values({
        tenantId: shop.tenantId,
        customerId,
        tokenHash: sha256(token),
        expiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent,
      }),
    );
    const scope = await this.resolve(shop, token);
    if (!scope) throw new AppError(500, 'INTERNAL', 'Session could not be started');
    return { token, scope };
  }

  async register(req: AppRequest, input: RegisterCustomerRequest, meta: RequestMeta) {
    const shop = await this.shop(req);
    const email = input.email.toLowerCase();
    await this.throttle(meta, email, 'register');
    const passwordHash = await hashPassword(input.password);
    const customer = await this.db.tenant(shop.tenantId, async (tx) => {
      const [created] = await tx
        .insert(customers)
        .values({
          tenantId: shop.tenantId,
          email,
          passwordHash,
          displayName: input.displayName,
          phone: input.phone,
        })
        .onConflictDoNothing()
        .returning();
      if (!created)
        throw new AppError(
          409,
          'EMAIL_TAKEN',
          'An account with this e-mail already exists. Sign in instead.',
        );
      await tx.insert(consentEvents).values(
        (['email', 'sms', 'whatsapp'] as const).map((channel) => ({
          tenantId: shop.tenantId,
          customerId: created.id,
          channel,
          purpose: 'marketing' as const,
          granted: input.marketing[channel],
          source: 'registration' as const,
          ip: meta.ip,
        })),
      );
      await enqueueEvent(tx, {
        tenantId: shop.tenantId,
        eventType: 'CustomerRegistered',
        aggregateType: 'customer',
        aggregateId: created.id,
        correlationId: meta.correlationId,
        payload: { customerId: created.id },
      });
      await writeAudit(tx, {
        tenantId: shop.tenantId,
        actorType: 'system',
        actorUserId: null,
        action: 'customers.registered',
        entityType: 'customer',
        entityId: created.id,
        newValues: { marketing: input.marketing },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return created;
    });
    return this.startSession(shop, customer.id, meta);
  }

  async login(req: AppRequest, input: CustomerLoginRequest, meta: RequestMeta) {
    const shop = await this.shop(req);
    const email = input.email.toLowerCase();
    await this.throttle(meta, email, 'login');
    const invalid = () => new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    const [c] = await this.db.tenant(shop.tenantId, (tx) =>
      tx
        .select()
        .from(customers)
        .where(and(eq(customers.tenantId, shop.tenantId), eq(customers.email, email))),
    );
    if (!c) {
      dummyHash ??= hashPassword('dummy-password-for-timing');
      await verifyPassword(await dummyHash, input.password);
      throw invalid();
    }
    const now = new Date();
    if (c.lockedUntil && c.lockedUntil > now)
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked after repeated failed sign-ins', {
        lockedUntil: c.lockedUntil.toISOString(),
      });
    if (!(await verifyPassword(c.passwordHash, input.password))) {
      await this.db.tenant(shop.tenantId, async (tx) => {
        const [counted] = await tx
          .update(customers)
          .set({ failedLogins: sql`${customers.failedLogins} + 1` })
          .where(eq(customers.id, c.id))
          .returning({ n: customers.failedLogins });
        if ((counted?.n ?? 1) >= this.config.lockout.maxFailures)
          await tx
            .update(customers)
            .set({ failedLogins: 0, lockedUntil: new Date(now.getTime() + this.config.lockout.lockMs) })
            .where(eq(customers.id, c.id));
      });
      throw invalid();
    }
    if (c.status !== 'active') throw new AppError(401, 'ACCOUNT_DISABLED', 'This account is disabled');
    await this.db.tenant(shop.tenantId, (tx) =>
      tx
        .update(customers)
        .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: now })
        .where(eq(customers.id, c.id)),
    );
    return this.startSession(shop, c.id, meta);
  }

  async logout(req: AppRequest) {
    const shop = await this.shop(req);
    const scope = await this.resolve(shop, this.tokenFrom(req));
    if (scope)
      await this.db.tenant(shop.tenantId, (tx) =>
        tx
          .update(customerSessions)
          .set({ revokedAt: new Date() })
          .where(eq(customerSessions.id, scope.sessionId)),
      );
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.COOKIE_SECURE,
      path: '/',
      maxAge: CUSTOMER_SESSION_MS,
    };
  }

  setCookie(res: Response, token: string) {
    res.cookie(CUSTOMER_COOKIE, token, this.cookieOptions());
  }

  clearCookie(res: Response) {
    const { maxAge: _maxAge, ...options } = this.cookieOptions();
    res.clearCookie(CUSTOMER_COOKIE, options);
  }
}
