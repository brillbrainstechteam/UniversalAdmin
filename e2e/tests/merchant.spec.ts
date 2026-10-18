import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSWORD } from '../global-setup';

const MERCHANT = 'http://localhost:3100';

async function signIn(page: Page, email: string) {
  await page.goto(`${MERCHANT}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

test('unauthenticated users are sent to login; bad credentials show an error', async ({ page }) => {
  await page.goto(`${MERCHANT}/t/00000000-0000-4000-8000-000000000000/settings/general`);
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Email').fill('owner@aurum.demo');
  await page.getByLabel('Password').fill('definitely-wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.uc-alert')).toContainText('Email or password is incorrect');
});

test('owner signs in, sees preset-gated navigation and edits business settings', async ({ page }) => {
  await signIn(page, 'owner@aurum.demo');
  await expect(page).toHaveURL(/\/t\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByText('Demo merchant')).toBeVisible();
  for (const item of ['Home', 'Audit log', 'General', 'Stores & channels', 'Locations', 'Staff', 'Roles']) {
    await expect(nav(page).getByRole('link', { name: item, exact: true })).toBeVisible();
  }
  // Modules from later phases are not shown as dead links.
  await expect(nav(page).getByRole('link', { name: 'Integrations' })).toHaveCount(0); // Phase 05
  await expect(nav(page).getByRole('link', { name: 'Inventory' })).toBeVisible(); // Phase 04
  await expect(nav(page).getByRole('link', { name: 'Products', exact: true })).toBeVisible(); // Phase 02
  await page.screenshot({ path: 'screenshots/merchant-home.png', fullPage: true });

  await nav(page).getByRole('link', { name: 'General' }).click();
  const phone = page.getByLabel('Contact phone');
  await phone.fill('+91 22 4000 1234');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Business settings saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Contact phone')).toHaveValue('+91 22 4000 1234');

  await nav(page).getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('cell', { name: 'settings.general.updated' }).first()).toBeVisible();
});

test('owner invites staff and receives a one-time link', async ({ page }) => {
  await signIn(page, 'owner@aurum.demo');
  await nav(page).getByRole('link', { name: 'Staff' }).click();
  await page.getByRole('button', { name: 'Invite staff' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite staff' });
  await dialog.getByLabel('Email').fill('new.staff@aurum.test');
  await dialog.getByLabel('Viewer').check();
  await dialog.getByRole('button', { name: 'Create invitation' }).click();
  await expect(dialog.getByText('Invitation created')).toBeVisible();
  await expect(dialog.getByLabel('Invitation link')).toContainText('/accept-invite#token=');
  await page.screenshot({ path: 'screenshots/merchant-invite.png' });
});

test('viewer gets read-only screens and an access-denied state for restricted pages', async ({ page }) => {
  await signIn(page, 'viewer@aurum.demo');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Audit log' })).toHaveCount(0);
  await nav(page).getByRole('link', { name: 'General' }).click();
  await expect(page.getByText('You can view these settings')).toBeVisible();
  await expect(page.getByLabel('Display name')).toBeDisabled();
  // Typing the URL directly still hits the server-side permission check.
  await page.goto(page.url().replace('/settings/general', '/audit'));
  await expect(page.getByText('You don’t have access to this page')).toBeVisible();
  await page.screenshot({ path: 'screenshots/viewer-forbidden.png' });
});

test('scoped inventory operator sees only assigned locations', async ({ page }) => {
  await signIn(page, 'stock@aurum.demo');
  await nav(page).getByRole('link', { name: 'Locations' }).click();
  await expect(page.getByText('Your access is limited to 1 assigned location')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Mumbai branch' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Jaipur branch' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add location' })).toHaveCount(0);
});

test('multi-tenant user picks a merchant; general-commerce tenant has no jewellery features', async ({
  page,
}) => {
  await signIn(page, 'multi@demo.local');
  await expect(page.getByRole('heading', { name: 'Choose a merchant' })).toBeVisible();
  await page.getByRole('link', { name: 'Northwind General Store (DEMO)' }).click();
  await expect(page.getByText('General commerce')).toBeVisible();
  await expect(page.getByText('Jewellery extension')).toHaveCount(0);
  await expect(page.getByText('Metal rates')).toHaveCount(0);
});
