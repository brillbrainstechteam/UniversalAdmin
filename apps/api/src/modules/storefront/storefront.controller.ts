import { Controller, Get, Inject, Injectable, Req } from '@nestjs/common';
import type { ChannelType, StorefrontConfig, ThemeTokens } from '@uc/contracts';
import { channelDomains, channels, tenants } from '@uc/db';
import { and, eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { AppError } from '../../common/errors';
import type { AppRequest } from '../../common/request';
import { DbService } from '../../db/db.service';

const HOST_RE = /^[a-z0-9.-]{1,253}$/;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

@Injectable()
export class StorefrontResolver {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Storefront tenant resolution (ADR-003): the request Host, or X-Storefront-Host only when the caller proves it
   * is a trusted storefront server with the gateway key. Never a client-supplied tenant id.
   */
  hostOf(req: AppRequest): string {
    const forwarded = req.header('x-storefront-host');
    const key = req.header('x-storefront-key');
    const raw =
      forwarded && key && safeEqual(key, this.config.STOREFRONT_GATEWAY_KEY) ? forwarded : req.header('host');
    return (raw ?? '').toLowerCase().replace(/:\d+$/, '');
  }

  async resolve(hostname: string): Promise<StorefrontConfig> {
    const notFound = new AppError(404, 'STOREFRONT_NOT_FOUND', 'No storefront is configured for this domain');
    if (!HOST_RE.test(hostname)) throw notFound;
    // System context: the hostname → tenant mapping is by definition cross-tenant.
    const [row] = await this.db.system((tx) =>
      tx
        .select({ domain: channelDomains, channel: channels, tenant: tenants })
        .from(channelDomains)
        .innerJoin(
          channels,
          and(eq(channels.id, channelDomains.channelId), eq(channels.tenantId, channelDomains.tenantId)),
        )
        .innerJoin(tenants, eq(tenants.id, channelDomains.tenantId))
        .where(eq(channelDomains.hostname, hostname)),
    );
    if (
      !row ||
      row.domain.status !== 'verified' ||
      row.channel.status !== 'active' ||
      row.tenant.status !== 'active' ||
      !['b2b_storefront', 'b2c_storefront'].includes(row.channel.type)
    ) {
      throw notFound;
    }
    return {
      tenant: { slug: row.tenant.slug, displayName: row.tenant.displayName, isDemo: row.tenant.isDemo },
      channel: { code: row.channel.code, name: row.channel.name, type: row.channel.type as ChannelType },
      hostname,
      theme: row.channel.theme as ThemeTokens,
      currency: row.tenant.defaultCurrency,
      locale: row.tenant.defaultLocale,
      timezone: row.tenant.timezone,
    };
  }
}

@Controller('v1/storefront')
export class StorefrontController {
  constructor(private readonly resolver: StorefrontResolver) {}

  @Get('config')
  config(@Req() req: AppRequest): Promise<StorefrontConfig> {
    return this.resolver.resolve(this.resolver.hostOf(req));
  }
}
