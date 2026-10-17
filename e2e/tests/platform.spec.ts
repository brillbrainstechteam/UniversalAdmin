import { expect, test } from '@playwright/test';
import { E2E_PASSWORD } from '../global-setup';

const PLATFORM = 'http://localhost:3101';
const MERCHANT = 'http://localhost:3100';

test('platform owner provisions a tenant; the owner accepts the invite; suspension locks them out', async ({
  page,
  browser,
}) => {
  await page.goto(`${PLATFORM}/login`);
  await page.getByLabel('Email').fill('platform@uc.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Aurum Wholesale Jewellers (DEMO)' })).toBeVisible();
  await page.screenshot({ path: 'screenshots/platform-tenants.png', fullPage: true });

  await page.getByRole('link', { name: 'Provision tenant' }).click();
  await page.getByLabel('Display name').fill('Shree Jewels');
  await page.getByLabel('Legal name').fill('Shree Jewels Pvt Ltd');
  await page.getByLabel('Slug').fill('shree-jewels');
  await page.getByLabel('Contact email').fill('hello@shree.test');
  await page.getByLabel('Owner email').fill('owner@shree.test');
  await page.getByRole('button', { name: 'Provision tenant' }).click();
  await expect(page.getByRole('heading', { name: 'Tenant provisioned' })).toBeVisible();
  const inviteUrl = (await page.getByLabel('Owner invitation link').textContent())!.trim();
  expect(inviteUrl).toContain(`${MERCHANT}/accept-invite#token=`);

  // The new owner accepts in a separate browser context (no shared cookies).
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await owner.goto(inviteUrl);
  await expect(owner.getByText('Shree Jewels')).toBeVisible();
  await owner.getByLabel('Your name').fill('Shree Owner');
  await owner.getByLabel('Choose a password').fill('shree-owner-password');
  await owner.getByLabel('Confirm password').fill('shree-owner-password');
  await owner.getByRole('button', { name: 'Accept invitation' }).click();
  await owner.getByRole('link', { name: 'Continue to sign in' }).click();
  await owner.getByLabel('Email').fill('owner@shree.test');
  await owner.getByLabel('Password').fill('shree-owner-password');
  await owner.getByRole('button', { name: 'Sign in' }).click();
  await expect(owner.getByRole('heading', { name: 'Home' })).toBeVisible();
  const tenantUrl = owner.url();

  // Platform suspends the tenant with a reason.
  await page.getByRole('link', { name: 'Open tenant' }).click();
  await page.getByRole('button', { name: 'Suspend' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Reason/).fill('Pilot paused (e2e)');
  await dialog.getByRole('button', { name: 'Suspend tenant' }).click();
  await expect(page.getByText('Pilot paused (e2e)')).toBeVisible();
  await page.screenshot({ path: 'screenshots/platform-suspended.png', fullPage: true });

  await owner.goto(tenantUrl);
  await expect(owner.getByRole('heading', { name: 'This merchant account is suspended' })).toBeVisible();
  await ownerContext.close();
});

test('platform support is read-only', async ({ page }) => {
  await page.goto(`${PLATFORM}/login`);
  await page.getByLabel('Email').fill('support@uc.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Provision tenant' })).toHaveCount(0);
  await page.goto(`${PLATFORM}/tenants/new`);
  await expect(page.getByText('You don’t have access to this page')).toBeVisible();
});

test('merchant staff cannot sign in to the platform console', async ({ page }) => {
  await page.goto(`${PLATFORM}/login`);
  await page.getByLabel('Email').fill('owner@aurum.demo');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.uc-alert')).toContainText('not a platform operator');
});
