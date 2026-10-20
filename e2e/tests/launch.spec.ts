import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSWORD } from '../global-setup';

/** Phase 12 E2E matrix (L-08): presets × roles, phone viewport, setup guide, plans, support access with banner. */
const MERCHANT = 'http://localhost:3100';
const PLATFORM = 'http://localhost:3101';
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`${MERCHANT}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  return new URL(page.url()).pathname;
}

async function audit(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${name}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
}

test('preset matrix: navigation follows each merchant’s preset', async ({ page }) => {
  const cases: { email: string; has: string[]; lacks: string[] }[] = [
    {
      email: 'owner@northwind.demo',
      has: ['Products', 'Orders', 'Setup guide'],
      lacks: ['Jewellery', 'Companies'],
    },
    { email: 'owner@aurum.demo', has: ['Companies', 'Jewellery', 'Setup guide'], lacks: [] },
    { email: 'owner@lumiere.demo', has: ['Customers', 'Jewellery'], lacks: ['Companies'] },
  ];
  for (const c of cases) {
    await signIn(page, c.email);
    for (const label of c.has)
      await expect(nav(page).getByRole('link', { name: label, exact: true })).toBeVisible();
    for (const label of c.lacks)
      await expect(nav(page).getByRole('link', { name: label, exact: true })).toHaveCount(0);
  }
});

test('role matrix: viewers read but cannot manage; owners see support approvals', async ({ page }) => {
  const base = await signIn(page, 'viewer@aurum.demo');
  await expect(nav(page).getByRole('link', { name: 'Support access' })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'Plan & usage' })).toBeVisible();
  await page.goto(`${MERCHANT}${base}/settings/support`);
  await expect(page.getByText('Only owners can approve platform support access.')).toBeVisible();
  await page.goto(`${MERCHANT}${base}/products`);
  await expect(page.getByRole('heading', { name: 'Products', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add product' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add product' })).toHaveCount(0);

  await signIn(page, 'owner@aurum.demo');
  await expect(nav(page).getByRole('link', { name: 'Support access' })).toBeVisible();
});

test('phone viewport: key admin pages fit without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const base = await signIn(page, 'owner@northwind.demo');
  for (const path of ['', '/setup', '/orders', '/products', '/settings/plan']) {
    await page.goto(`${MERCHANT}${base}${path}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - window.innerWidth');
    expect(overflow, `horizontal overflow on ${path || 'home'}`).toBeLessThanOrEqual(1);
  }
});

test('setup guide and plan pages show real progress and usage, accessibly', async ({ page }) => {
  const base = await signIn(page, 'owner@lumiere.demo');
  await expect(page.getByRole('heading', { name: 'Setup checklist' })).toBeVisible();
  await page.goto(`${MERCHANT}${base}/setup`);
  await expect(page.getByRole('heading', { name: 'Setup guide' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: /Setup progress/ })).toBeVisible();
  await expect(page.getByText('Approve metal rates')).toBeVisible(); // jewellery preset
  await audit(page, 'setup');
  await page.goto(`${MERCHANT}${base}/settings/plan`);
  await expect(page.getByRole('heading', { name: 'Growth plan' })).toBeVisible();
  await expect(page.getByText('Billing is not connected', { exact: false })).toBeVisible();
  await audit(page, 'plan');
  await page.screenshot({ path: 'screenshots/plan-usage.png', fullPage: true });
});

test('support access: operator asks, owner approves, read-only session with banner, owner ends it', async ({
  page,
  browser,
}) => {
  // Operator (platform support) requests access to Northwind.
  await page.goto(`${PLATFORM}/login`);
  await page.getByLabel('Email').fill('support@uc.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: /Northwind/ }).click();
  await expect(page.getByRole('heading', { name: 'Support access' })).toBeVisible();
  await page.getByRole('button', { name: 'Request access' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('E2E: customer says an order total looks wrong');
  await dialog.getByLabel('Duration').selectOption('30');
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(
    page.getByRole('cell', { name: 'E2E: customer says an order total looks wrong' }),
  ).toBeVisible();

  // The merchant owner approves in their own browser.
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const base = await signIn(owner, 'owner@northwind.demo');
  await owner.goto(`${MERCHANT}${base}/settings/support`);
  await expect(owner.getByRole('heading', { name: 'Support access', level: 1 })).toBeVisible();
  const row = owner.getByRole('row', { name: /E2E: customer says an order total looks wrong/ });
  await row.getByRole('button', { name: 'Approve' }).click();
  await owner.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(row.getByText('approved')).toBeVisible();
  await audit(owner, 'support settings');

  // The operator opens the merchant admin: a new tab with a one-time handoff link.
  await page.reload();
  const popupPromise = page.context().waitForEvent('page');
  await page
    .getByRole('row', { name: /E2E: customer says an order total looks wrong/ })
    .getByRole('button', { name: 'Open merchant admin' })
    .click();
  const support = await popupPromise;
  await expect(support.getByRole('status').getByText('Platform support session (read-only)')).toBeVisible();
  await expect(support.getByText('Support (read-only)', { exact: true })).toBeVisible();
  await expect(nav(support).getByRole('link', { name: 'Customers' })).toHaveCount(0);
  await expect(support.getByRole('link', { name: 'Switch merchant' })).toHaveCount(0);
  await support.screenshot({ path: 'screenshots/support-session.png', fullPage: true });

  // The owner ends it; the support tab loses access.
  await owner.reload();
  await owner
    .getByRole('row', { name: /E2E: customer says an order total looks wrong/ })
    .getByRole('button', { name: 'End access' })
    .click();
  await owner.getByRole('dialog').getByRole('button', { name: 'End access' }).click();
  await expect(
    owner.getByRole('row', { name: /E2E: customer says an order total looks wrong/ }).getByText('revoked'),
  ).toBeVisible();
  await support.reload();
  await expect(support).toHaveURL(/\/login/);
  await ownerContext.close();
});

test('platform plans page lists plans with limits and tenant counts', async ({ page }) => {
  await page.goto(`${PLATFORM}/login`);
  await page.getByLabel('Email').fill('platform@uc.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Plans' }).click();
  await expect(page.getByRole('heading', { name: 'Plans' })).toBeVisible();
  for (const name of ['Pilot', 'Starter', 'Growth'])
    await expect(page.getByRole('cell', { name: new RegExp(`^${name}`) })).toBeVisible();
  await audit(page, 'platform plans');
});
