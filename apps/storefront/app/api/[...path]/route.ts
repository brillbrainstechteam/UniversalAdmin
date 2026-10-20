import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextRequest } from 'next/server';

/**
 * Same-origin API proxy for the B2C storefront (ADR-023/024). The browser only talks to this origin; this server forwards
 * to the API with the shopper's domain in X-Storefront-Host and proves it is a trusted storefront server with the
 * gateway key — which never reaches the browser. Cookies pass through, so the buyer session stays HttpOnly on the
 * merchant's own store domain. Only /v1/storefront/* (not the B2B portal API) is reachable through this proxy.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let gatewayKey: string | undefined;
function key(): string {
  if (gatewayKey) return gatewayKey;
  gatewayKey = process.env.STOREFRONT_GATEWAY_KEY;
  if (!gatewayKey) {
    // Local development: read the monorepo .env (the portal is started from apps/buyer-portal).
    try {
      const env = readFileSync(resolve(process.cwd(), '../../.env'), 'utf8');
      gatewayKey = /^STOREFRONT_GATEWAY_KEY=(.*)$/m.exec(env)?.[1]?.trim();
    } catch {
      /* not available */
    }
  }
  if (!gatewayKey) throw new Error('STOREFRONT_GATEWAY_KEY is not configured');
  return gatewayKey;
}

const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4100';
const FORWARD = [
  'cookie',
  'content-type',
  'accept',
  'x-uc-csrf',
  'x-cart-token',
  'origin',
  'idempotency-key',
  'user-agent',
];

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (path[0] !== 'v1' || path[1] !== 'storefront' || path[2] === 'b2b')
    return new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Not found' }), { status: 404 });
  const url = new URL(`${API}/${path.map(encodeURIComponent).join('/')}`);
  url.search = req.nextUrl.search;
  const headers = new Headers();
  for (const h of FORWARD) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('x-storefront-host', (req.headers.get('host') ?? '').replace(/:\d+$/, ''));
  headers.set('x-storefront-key', key());
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
  const upstream = await fetch(url, { method: req.method, headers, body, redirect: 'manual' });
  const out = new Headers();
  for (const h of ['content-type', 'x-correlation-id', 'idempotent-replayed']) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  for (const c of upstream.headers.getSetCookie()) out.append('set-cookie', c);
  return new Response(upstream.status === 204 ? null : await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: out,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
