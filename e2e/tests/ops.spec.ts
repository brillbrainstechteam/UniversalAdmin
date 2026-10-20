import { createHmac } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { hashPassword, requireEnv } from '@uc/db';
import { Pool } from 'pg';
import { E2E_PASSWORD } from '../global-setup';

const MERCHANT = 'http://localhost:3100';
const STORE = 'http://northwind.localhost:3103';
const PORTAL = 'http://aurum-b2b.localhost:3102';
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`${MERCHANT}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Serious and critical WCAG 2 A/AA violations on the current page. */
async function audit(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${name}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
}

/** RFC 6238 code for a base32 secret (same algorithm as authenticator apps). */
function totp(secret: string, step: number) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const stepNow = () => Math.floor(Date.now() / 30_000);

test('key admin, storefront and portal pages have no serious accessibility violations', async ({ page }) => {
  await signIn(page, 'owner@northwind.demo');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  const tenantPath = new URL(page.url()).pathname;
  for (const [path, name] of [
    ['', 'home'],
    ['/orders', 'orders'],
    ['/products', 'products'],
    ['/customers', 'customers'],
    ['/discounts', 'discounts'],
    ['/analytics', 'analytics'],
    ['/operations', 'operations'],
    ['/settings/webhooks', 'webhooks'],
  ] as const) {
    await page.goto(`${MERCHANT}${tenantPath}${path}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await audit(page, `admin ${name}`);
  }
  for (const [url, name] of [
    [`${STORE}/`, 'store home'],
    [`${STORE}/products/enamel-mug`, 'store product'],
    [`${STORE}/account/login`, 'store sign-in'],
    [`${PORTAL}/login`, 'portal sign-in'],
    [`${MERCHANT}/login`, 'admin sign-in'],
  ] as const) {
    await page.context().clearCookies();
    await page.goto(url);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await audit(page, name);
  }
});

test('a staff member turns on two-step verification and signs in with a code', async ({ page }) => {
  const pool = new Pool({ connectionString: requireEnv('TEST_DATABASE_OWNER_URL'), max: 1 });
  const email = `mfa.${Date.now()}@example.test`;
  try {
    const t = (await pool.query("select id from tenants where slug = 'northwind-general'")).rows[0]
      .id as string;
    const u = await pool.query(
      'insert into users (email, display_name, password_hash) values ($1, $2, $3) returning id',
      [email, 'MFA Admin', await hashPassword(E2E_PASSWORD)],
    );
    const m = await pool.query('insert into memberships (tenant_id, user_id) values ($1, $2) returning id', [
      t,
      u.rows[0].id,
    ]);
    const role = (await pool.query("select id from roles where tenant_id = $1 and key = 'admin'", [t]))
      .rows[0].id as string;
    await pool.query('insert into membership_roles (tenant_id, membership_id, role_id) values ($1, $2, $3)', [
      t,
      m.rows[0].id,
      role,
    ]);
  } finally {
    await pool.end();
  }
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await page.getByRole('link', { name: email }).click();
  await expect(page.getByRole('heading', { name: 'Account security' })).toBeVisible();
  await page.getByRole('button', { name: 'Set up two-step verification' }).click();
  const secret = await page.getByLabel('Setup key').inputValue();
  const step = stepNow();
  await page.getByLabel('Code from the app').fill(totp(secret, step));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByText('Save your recovery codes now')).toBeVisible();
  await expect(page.getByText(/^On\./)).toBeVisible();
  await audit(page, 'account security');
  // Sign in again: the password alone is not enough.
  await signIn(page, email);
  await expect(page.getByLabel('Verification code')).toBeVisible();
  await page.getByLabel('Verification code').fill(totp(secret, step + 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
});

test('staff add a webhook endpoint, see its secret once, and check operations health', async ({ page }) => {
  await signIn(page, 'owner@northwind.demo');
  await nav(page).getByRole('link', { name: 'Webhooks' }).click();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByLabel('Name').fill('E2E receiver');
  await page.getByLabel('URL').fill('https://example.com/uc-hook');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Signing secret — copy it now')).toBeVisible();
  await expect(page.getByText(/whsec_/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Webhook endpoints' })).toContainText('E2E receiver');
  await page.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByText('Test delivery queued')).toBeVisible();
  await nav(page).getByRole('link', { name: 'Operations' }).click();
  await expect(page.getByRole('table', { name: 'Health checks' })).toContainText(
    'Webhook deliveries retrying',
  );
  await expect(page.getByRole('table', { name: 'Providers' })).toContainText('needs account');
  await page.screenshot({ path: 'screenshots/operations.png', fullPage: true });
});
