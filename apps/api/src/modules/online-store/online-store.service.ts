import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { Inject, Injectable } from '@nestjs/common';
import {
  BannerContent,
  MenuContent,
  PageContent,
  ThemeTokens,
  contentSchemaFor,
  type AddDomainRequest,
  type CreatePageRequest,
  type CreateRedirectRequest,
  type PreviewToken,
  type PublishRequest,
  type SaveDraftRequest,
  type SiteDocument,
  type StoreDomain,
  type StorefrontPage,
  type StorefrontSite,
} from '@uc/contracts';
import {
  channelDomains,
  channels,
  redirects,
  siteDocumentVersions,
  siteDocuments,
  users,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { AppError, Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { DbService } from '../../db/db.service';
import { assertPlanCapacity } from '../launch/plans.service';

type DocRow = typeof siteDocuments.$inferSelect;
const PREVIEW_MS = 15 * 60_000;
const TITLES = { theme: 'Theme', banner: 'Announcement banner' } as const;
const DEFAULT_BANNER: BannerContent = {
  message: 'Welcome to our store',
  linkHref: null,
  startsAt: null,
  endsAt: null,
};

function requireStore(ctx: Pick<TenantState, 'features'>) {
  if (!ctx.features.includes('online_store')) throw Errors.featureNotEntitled('online_store');
}

function parseContent(kind: DocRow['kind'], content: unknown): Record<string, unknown> {
  const r = contentSchemaFor(kind).safeParse(content);
  if (!r.success)
    throw Errors.validation(
      r.error.issues.map((i) => ({ path: ['content', ...i.path].join('.'), message: i.message })),
      'The content is not valid',
    );
  return r.data as Record<string, unknown>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Online store content (Phase 10, ADR-025): drafts, immutable published versions, rollback by republishing,
 * signed preview tokens, redirects and domain verification. Shoppers only ever receive published content.
 */
@Injectable()
export class OnlineStoreService {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private audit(
    tx: Tx,
    auth: AuthState,
    ctx: TenantState,
    meta: RequestMeta,
    action: string,
    id: string,
    values: Record<string, unknown>,
  ) {
    return writeAudit(tx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorUserId: auth.userId,
      action,
      entityType: 'site_document',
      entityId: id,
      newValues: values,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
  }

  private async storefrontChannel(tx: Tx, tenantId: string, channelId: string) {
    const [c] = await tx
      .select()
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.tenantId, tenantId)));
    if (!c) throw Errors.notFound('Channel');
    if (c.type !== 'b2c_storefront' && c.type !== 'b2b_storefront')
      throw Errors.unprocessable('VALIDATION_FAILED', `${c.name} is not a storefront channel`);
    return c;
  }

  /** Theme, header/footer menus and the banner exist for every storefront; the theme starts as published. */
  private async ensureDefaults(
    tx: Tx,
    tenantId: string,
    channel: typeof channels.$inferSelect,
    actor: string | null,
  ) {
    const existing = await tx
      .select({ kind: siteDocuments.kind, key: siteDocuments.key })
      .from(siteDocuments)
      .where(and(eq(siteDocuments.tenantId, tenantId), eq(siteDocuments.channelId, channel.id)));
    const has = (kind: string, key: string) => existing.some((e) => e.kind === kind && e.key === key);
    const now = new Date();
    const theme = ThemeTokens.parse(channel.theme);
    const seeds: { kind: DocRow['kind']; key: string; content: Record<string, unknown>; live: boolean }[] =
      [];
    if (!has('theme', 'main')) seeds.push({ kind: 'theme', key: 'main', content: theme, live: true });
    for (const key of ['header', 'footer'])
      if (!has('menu', key)) seeds.push({ kind: 'menu', key, content: { items: [] }, live: true });
    if (!has('banner', 'main'))
      seeds.push({ kind: 'banner', key: 'main', content: DEFAULT_BANNER, live: false });
    for (const s of seeds) {
      const [doc] = await tx
        .insert(siteDocuments)
        .values({
          tenantId,
          channelId: channel.id,
          kind: s.kind,
          key: s.key,
          draft: s.content,
          draftUpdatedBy: actor,
          ...(s.live ? { published: s.content, publishedVersion: 1, publishedAt: now, live: true } : {}),
        })
        .onConflictDoNothing()
        .returning();
      if (doc && s.live)
        await tx.insert(siteDocumentVersions).values({
          tenantId,
          documentId: doc.id,
          version: 1,
          content: s.content,
          note: 'Initial version',
          publishedBy: actor,
        });
    }
  }

  private title(d: DocRow): string {
    if (d.kind === 'page') return String((d.draft as { title?: string }).title ?? d.key);
    if (d.kind === 'menu') return d.key === 'header' ? 'Header menu' : 'Footer menu';
    return TITLES[d.kind];
  }

  private async toDocument(tx: Tx, d: DocRow): Promise<SiteDocument> {
    const versions = await tx
      .select({ v: siteDocumentVersions, name: users.displayName })
      .from(siteDocumentVersions)
      .leftJoin(users, eq(users.id, siteDocumentVersions.publishedBy))
      .where(eq(siteDocumentVersions.documentId, d.id))
      .orderBy(desc(siteDocumentVersions.version));
    const [editor] = d.draftUpdatedBy
      ? await tx
          .select({ id: users.id, name: users.displayName })
          .from(users)
          .where(eq(users.id, d.draftUpdatedBy))
      : [];
    return {
      id: d.id,
      channelId: d.channelId,
      kind: d.kind,
      key: d.key,
      draft: d.draft as Record<string, unknown>,
      published: (d.published as Record<string, unknown> | null) ?? null,
      publishedVersion: d.publishedVersion,
      publishedAt: d.publishedAt ? iso(d.publishedAt) : null,
      live: d.live,
      hasChanges: !d.live || !same(d.draft, d.published),
      draftUpdatedAt: iso(d.draftUpdatedAt),
      draftUpdatedBy: editor ?? null,
      versions: versions.map((x) => ({
        version: x.v.version,
        publishedAt: iso(x.v.publishedAt),
        publishedBy: x.name,
        note: x.v.note,
      })),
      version: d.version,
    };
  }

  async list(ctx: TenantState, auth: AuthState, channelId: string) {
    requireStore(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const channel = await this.storefrontChannel(tx, ctx.tenantId, channelId);
      await this.ensureDefaults(tx, ctx.tenantId, channel, auth.userId);
      const rows = await tx
        .select()
        .from(siteDocuments)
        .where(and(eq(siteDocuments.tenantId, ctx.tenantId), eq(siteDocuments.channelId, channelId)))
        .orderBy(asc(siteDocuments.kind), asc(siteDocuments.key));
      return {
        items: rows.map((d) => ({
          id: d.id,
          channelId: d.channelId,
          kind: d.kind,
          key: d.key,
          title: this.title(d),
          publishedVersion: d.publishedVersion,
          publishedAt: d.publishedAt ? iso(d.publishedAt) : null,
          live: d.live,
          hasChanges: !d.live || !same(d.draft, d.published),
          draftUpdatedAt: iso(d.draftUpdatedAt),
          draftUpdatedBy: null,
          version: d.version,
        })),
      };
    });
  }

  private async load(tx: Tx, ctx: TenantState, id: string, lock = false) {
    const q = tx.select().from(siteDocuments).where(eq(siteDocuments.id, id));
    const [d] = lock ? await q.for('update') : await q;
    if (!d || d.tenantId !== ctx.tenantId) throw Errors.notFound('Document');
    return d;
  }

  async get(ctx: TenantState, id: string): Promise<SiteDocument> {
    requireStore(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => this.toDocument(tx, await this.load(tx, ctx, id)));
  }

  async createPage(
    auth: AuthState,
    ctx: TenantState,
    input: CreatePageRequest,
    meta: RequestMeta,
  ): Promise<SiteDocument> {
    requireStore(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.storefrontChannel(tx, ctx.tenantId, input.channelId);
      const [d] = await tx
        .insert(siteDocuments)
        .values({
          tenantId: ctx.tenantId,
          channelId: input.channelId,
          kind: 'page',
          key: input.slug,
          draft: input.content,
          draftUpdatedBy: auth.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!d) throw Errors.duplicate('slug', `A page with the address /pages/${input.slug} exists`);
      await this.audit(tx, auth, ctx, meta, 'online_store.page_created', d.id, { slug: input.slug });
      return this.toDocument(tx, d);
    });
  }

  async saveDraft(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: SaveDraftRequest,
    meta: RequestMeta,
  ): Promise<SiteDocument> {
    requireStore(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const d = await this.load(tx, ctx, id, true);
      if (d.version !== input.version) throw Errors.versionConflict(d.version);
      const content = parseContent(d.kind, input.content);
      const [after] = await tx
        .update(siteDocuments)
        .set({
          draft: content,
          draftUpdatedAt: new Date(),
          draftUpdatedBy: auth.userId,
          version: d.version + 1,
        })
        .where(eq(siteDocuments.id, d.id))
        .returning();
      await this.audit(tx, auth, ctx, meta, 'online_store.draft_saved', d.id, { kind: d.kind, key: d.key });
      return this.toDocument(tx, after!);
    });
  }

  /** Publishes the draft (or, with `fromVersion`, an earlier version — a rollback) as a new immutable version. */
  async publish(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: PublishRequest,
    meta: RequestMeta,
  ): Promise<SiteDocument> {
    requireStore(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const d = await this.load(tx, ctx, id, true);
      if (d.version !== input.version) throw Errors.versionConflict(d.version);
      let content: Record<string, unknown>;
      if (input.fromVersion !== null) {
        const [v] = await tx
          .select()
          .from(siteDocumentVersions)
          .where(
            and(
              eq(siteDocumentVersions.documentId, d.id),
              eq(siteDocumentVersions.version, input.fromVersion),
            ),
          );
        if (!v) throw Errors.notFound('Version');
        content = parseContent(d.kind, v.content);
      } else content = parseContent(d.kind, d.draft);
      const [last] = await tx
        .select({ v: siteDocumentVersions.version })
        .from(siteDocumentVersions)
        .where(eq(siteDocumentVersions.documentId, d.id))
        .orderBy(desc(siteDocumentVersions.version))
        .limit(1);
      const next = (last?.v ?? 0) + 1;
      const now = new Date();
      await tx.insert(siteDocumentVersions).values({
        tenantId: ctx.tenantId,
        documentId: d.id,
        version: next,
        content,
        note: input.note ?? (input.fromVersion !== null ? `Rollback to version ${input.fromVersion}` : null),
        publishedBy: auth.userId,
        publishedAt: now,
      });
      const [after] = await tx
        .update(siteDocuments)
        .set({
          published: content,
          publishedVersion: next,
          publishedAt: now,
          live: true,
          ...(input.fromVersion !== null
            ? { draft: content, draftUpdatedAt: now, draftUpdatedBy: auth.userId }
            : {}),
          version: d.version + 1,
        })
        .where(eq(siteDocuments.id, d.id))
        .returning();
      // The theme is what the storefront config serves.
      if (d.kind === 'theme')
        await tx.update(channels).set({ theme: content }).where(eq(channels.id, d.channelId));
      await this.audit(tx, auth, ctx, meta, 'online_store.published', d.id, {
        kind: d.kind,
        key: d.key,
        version: next,
        fromVersion: input.fromVersion,
      });
      return this.toDocument(tx, after!);
    });
  }

  async unpublish(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    version: number,
    meta: RequestMeta,
  ): Promise<SiteDocument> {
    requireStore(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const d = await this.load(tx, ctx, id, true);
      if (d.version !== version) throw Errors.versionConflict(d.version);
      if (d.kind !== 'page' && d.kind !== 'banner')
        throw Errors.conflict('INVALID_STATE_TRANSITION', 'The theme and menus are always published');
      const [after] = await tx
        .update(siteDocuments)
        .set({ live: false, version: d.version + 1 })
        .where(eq(siteDocuments.id, d.id))
        .returning();
      await this.audit(tx, auth, ctx, meta, 'online_store.unpublished', d.id, { kind: d.kind, key: d.key });
      return this.toDocument(tx, after!);
    });
  }

  // ---------------------------------------------------------------- preview tokens

  private sign(payload: string) {
    return createHmac('sha256', this.config.PREVIEW_TOKEN_SECRET).update(payload).digest('base64url');
  }

  async previewToken(ctx: TenantState, channelId: string): Promise<PreviewToken> {
    requireStore(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.storefrontChannel(tx, ctx.tenantId, channelId);
      const [domain] = await tx
        .select({ hostname: channelDomains.hostname })
        .from(channelDomains)
        .where(and(eq(channelDomains.channelId, channelId), eq(channelDomains.status, 'verified')))
        .orderBy(desc(channelDomains.isPrimary))
        .limit(1);
      const expiresAt = Date.now() + PREVIEW_MS;
      const payload = Buffer.from(
        JSON.stringify({ t: ctx.tenantId, c: channelId, e: expiresAt, n: randomBytes(6).toString('hex') }),
      ).toString('base64url');
      return {
        token: `${payload}.${this.sign(payload)}`,
        expiresAt: new Date(expiresAt).toISOString(),
        hostname: domain?.hostname ?? null,
      };
    });
  }

  /** True only for an unexpired, correctly signed token for exactly this tenant and channel. */
  verifyPreview(token: string | undefined, tenantId: string, channelId: string): boolean {
    if (!token || token.length > 500) return false;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return false;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
    try {
      const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        t: string;
        c: string;
        e: number;
      };
      return p.t === tenantId && p.c === channelId && typeof p.e === 'number' && p.e > Date.now();
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- storefront

  async site(tenantId: string, channelId: string, preview: boolean): Promise<StorefrontSite> {
    return this.db.tenant(tenantId, async (tx) => {
      const [channel] = await tx.select().from(channels).where(eq(channels.id, channelId));
      const rows = await tx
        .select()
        .from(siteDocuments)
        .where(and(eq(siteDocuments.tenantId, tenantId), eq(siteDocuments.channelId, channelId)));
      const content = (d: DocRow | undefined) =>
        !d ? null : preview ? d.draft : d.live ? d.published : null;
      const find = (kind: DocRow['kind'], key: string) => rows.find((r) => r.kind === kind && r.key === key);
      const theme = ThemeTokens.safeParse(content(find('theme', 'main')) ?? channel!.theme);
      const menu = (key: string) => MenuContent.safeParse(content(find('menu', key)) ?? { items: [] });
      const banner = BannerContent.safeParse(content(find('banner', 'main')));
      const now = new Date().toISOString();
      const bannerShown =
        banner.success &&
        (!banner.data.startsAt || banner.data.startsAt <= now) &&
        (!banner.data.endsAt || banner.data.endsAt > now)
          ? banner.data
          : null;
      return {
        preview,
        theme: theme.success ? theme.data : ThemeTokens.parse(channel!.theme),
        menus: {
          header: menu('header').success ? menu('header').data! : { items: [] },
          footer: menu('footer').success ? menu('footer').data! : { items: [] },
        },
        banner: bannerShown,
        pages: rows
          .filter((r) => r.kind === 'page' && (preview || r.live))
          .map((r) => ({
            slug: r.key,
            title: String(((preview ? r.draft : r.published) as { title?: string }).title ?? r.key),
          }))
          .sort((a, b) => a.title.localeCompare(b.title)),
      };
    });
  }

  async page(tenantId: string, channelId: string, slug: string, preview: boolean): Promise<StorefrontPage> {
    return this.db.tenant(tenantId, async (tx) => {
      const [d] = await tx
        .select()
        .from(siteDocuments)
        .where(
          and(
            eq(siteDocuments.tenantId, tenantId),
            eq(siteDocuments.channelId, channelId),
            eq(siteDocuments.kind, 'page'),
            eq(siteDocuments.key, slug),
          ),
        );
      const raw = !d ? null : preview ? d.draft : d.live ? d.published : null;
      const parsed = PageContent.safeParse(raw);
      if (!parsed.success) throw new AppError(404, 'NOT_FOUND', 'Page not found');
      return { ...parsed.data, slug, preview };
    });
  }

  // ---------------------------------------------------------------- redirects

  async redirects(ctx: TenantState, channelId: string) {
    requireStore(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.storefrontChannel(tx, ctx.tenantId, channelId);
      const rows = await tx
        .select()
        .from(redirects)
        .where(and(eq(redirects.tenantId, ctx.tenantId), eq(redirects.channelId, channelId)))
        .orderBy(asc(redirects.fromPath));
      return {
        items: rows.map((r) => ({
          id: r.id,
          channelId: r.channelId,
          fromPath: r.fromPath,
          toPath: r.toPath,
          statusCode: r.statusCode as 301 | 302,
          createdAt: iso(r.createdAt),
        })),
      };
    });
  }

  async addRedirect(auth: AuthState, ctx: TenantState, input: CreateRedirectRequest, meta: RequestMeta) {
    requireStore(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.storefrontChannel(tx, ctx.tenantId, input.channelId);
      // Refuse chains/loops: the target must not itself be redirected, and nothing may redirect to this source.
      const clash = await tx
        .select({ id: redirects.id })
        .from(redirects)
        .where(and(eq(redirects.channelId, input.channelId), inArray(redirects.fromPath, [input.toPath])));
      const into = await tx
        .select({ id: redirects.id })
        .from(redirects)
        .where(and(eq(redirects.channelId, input.channelId), eq(redirects.toPath, input.fromPath)));
      if (clash.length || into.length)
        throw Errors.validation([{ path: 'toPath', message: 'Redirect chains and loops are not allowed' }]);
      const [r] = await tx
        .insert(redirects)
        .values({
          tenantId: ctx.tenantId,
          channelId: input.channelId,
          fromPath: input.fromPath,
          toPath: input.toPath,
          statusCode: input.statusCode,
          createdBy: auth.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!r) throw Errors.duplicate('fromPath', `${input.fromPath} already redirects`);
      await this.audit(tx, auth, ctx, meta, 'online_store.redirect_added', r.id, {
        fromPath: r.fromPath,
        toPath: r.toPath,
      });
      return {
        id: r.id,
        channelId: r.channelId,
        fromPath: r.fromPath,
        toPath: r.toPath,
        statusCode: r.statusCode as 301 | 302,
        createdAt: iso(r.createdAt),
      };
    });
  }

  async removeRedirect(auth: AuthState, ctx: TenantState, id: string, meta: RequestMeta) {
    requireStore(ctx);
    await this.db.tenant(ctx.tenantId, async (tx) => {
      const [r] = await tx
        .delete(redirects)
        .where(and(eq(redirects.id, id), eq(redirects.tenantId, ctx.tenantId)))
        .returning();
      if (!r) throw Errors.notFound('Redirect');
      await this.audit(tx, auth, ctx, meta, 'online_store.redirect_removed', r.id, { fromPath: r.fromPath });
    });
  }

  async lookupRedirect(tenantId: string, channelId: string, path: string) {
    return this.db.tenant(tenantId, async (tx) => {
      const [r] = await tx
        .select()
        .from(redirects)
        .where(and(eq(redirects.channelId, channelId), eq(redirects.fromPath, path)));
      if (!r) throw new AppError(404, 'NOT_FOUND', 'No redirect');
      return { toPath: r.toPath, statusCode: r.statusCode };
    });
  }

  // ---------------------------------------------------------------- domains

  private toDomain(d: typeof channelDomains.$inferSelect): StoreDomain {
    return {
      id: d.id,
      channelId: d.channelId,
      hostname: d.hostname,
      status: d.status,
      isPrimary: d.isPrimary,
      verificationRecord:
        d.status === 'pending' && d.verificationToken
          ? { type: 'TXT', name: `_uc-verify.${d.hostname}`, value: d.verificationToken }
          : null,
      verifiedAt: d.verifiedAt ? iso(d.verifiedAt) : null,
      lastCheckAt: d.lastCheckAt ? iso(d.lastCheckAt) : null,
      lastCheckError: d.lastCheckError,
    };
  }

  async domains(ctx: TenantState, channelId: string) {
    requireStore(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.storefrontChannel(tx, ctx.tenantId, channelId);
      const rows = await tx
        .select()
        .from(channelDomains)
        .where(and(eq(channelDomains.tenantId, ctx.tenantId), eq(channelDomains.channelId, channelId)))
        .orderBy(asc(channelDomains.hostname));
      return { items: rows.map((d) => this.toDomain(d)) };
    });
  }

  async addDomain(
    auth: AuthState,
    ctx: TenantState,
    input: AddDomainRequest,
    meta: RequestMeta,
  ): Promise<StoreDomain> {
    requireStore(ctx);
    // Global uniqueness of hostnames spans tenants, so this check runs outside the tenant scope.
    const [taken] = await this.db.system((tx) =>
      tx
        .select({ id: channelDomains.id })
        .from(channelDomains)
        .where(eq(channelDomains.hostname, input.hostname)),
    );
    if (taken) throw Errors.duplicate('hostname', 'This domain is already connected to a store');
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.storefrontChannel(tx, ctx.tenantId, input.channelId);
      await assertPlanCapacity(tx, ctx.tenantId, 'domains');
      const [d] = await tx
        .insert(channelDomains)
        .values({
          tenantId: ctx.tenantId,
          channelId: input.channelId,
          hostname: input.hostname,
          status: 'pending',
          verificationToken: `uc-verify=${randomBytes(16).toString('hex')}`,
        })
        .onConflictDoNothing()
        .returning();
      if (!d) throw Errors.duplicate('hostname', 'This domain is already connected to a store');
      await this.audit(tx, auth, ctx, meta, 'online_store.domain_added', d.id, { hostname: d.hostname });
      return this.toDomain(d);
    });
  }

  /**
   * Proves control of the domain: the TXT record `_uc-verify.<host>` must contain the token. Hosts under .localhost
   * or .test can be verified without DNS outside production only (development verification).
   */
  async verifyDomain(auth: AuthState, ctx: TenantState, id: string, meta: RequestMeta): Promise<StoreDomain> {
    requireStore(ctx);
    const [d] = await this.db.tenant(ctx.tenantId, (tx) =>
      tx
        .select()
        .from(channelDomains)
        .where(and(eq(channelDomains.id, id), eq(channelDomains.tenantId, ctx.tenantId))),
    );
    if (!d) throw Errors.notFound('Domain');
    if (d.status === 'verified') return this.toDomain(d);
    let error: string | null = null;
    const devHost = /\.(localhost|test)$/.test(d.hostname);
    if (devHost) {
      if (this.config.NODE_ENV === 'production')
        error = 'Development hostnames cannot be verified in production';
    } else {
      try {
        const records = (await resolveTxt(`_uc-verify.${d.hostname}`)).map((parts) => parts.join(''));
        if (!records.includes(d.verificationToken ?? ''))
          error = `TXT record found, but it does not contain ${d.verificationToken}`;
      } catch (e) {
        const code = (e as { code?: string }).code;
        error =
          code === 'ENOTFOUND' || code === 'ENODATA'
            ? `No TXT record at _uc-verify.${d.hostname} yet (DNS changes can take a while)`
            : `DNS lookup failed (${code ?? 'error'})`;
      }
    }
    const now = new Date();
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [after] = await tx
        .update(channelDomains)
        .set(
          error
            ? { lastCheckAt: now, lastCheckError: error }
            : { status: 'verified', verifiedAt: now, lastCheckAt: now, lastCheckError: null },
        )
        .where(eq(channelDomains.id, d.id))
        .returning();
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        error ? 'online_store.domain_check_failed' : 'online_store.domain_verified',
        d.id,
        {
          hostname: d.hostname,
          method: devHost ? 'development' : 'dns_txt',
          error,
        },
      );
      if (error) throw new AppError(422, 'DOMAIN_NOT_VERIFIED', error, { domain: this.toDomain(after!) });
      return this.toDomain(after!);
    });
  }

  async removeDomain(auth: AuthState, ctx: TenantState, id: string, meta: RequestMeta) {
    requireStore(ctx);
    await this.db.tenant(ctx.tenantId, async (tx) => {
      const [d] = await tx
        .select()
        .from(channelDomains)
        .where(and(eq(channelDomains.id, id), eq(channelDomains.tenantId, ctx.tenantId)));
      if (!d) throw Errors.notFound('Domain');
      if (d.isPrimary)
        throw Errors.conflict('INVALID_STATE_TRANSITION', 'The primary domain cannot be removed');
      await tx.delete(channelDomains).where(eq(channelDomains.id, d.id));
      await this.audit(tx, auth, ctx, meta, 'online_store.domain_removed', d.id, { hostname: d.hostname });
    });
  }
}
