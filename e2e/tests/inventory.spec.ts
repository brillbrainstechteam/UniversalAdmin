import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSWORD } from '../global-setup';

const MERCHANT = 'http://localhost:3100';

async function signIn(page: Page, email: string) {
  await page.goto(`${MERCHANT}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const tabs = (page: Page) => page.getByRole('navigation', { name: 'Inventory sections' });
const stat = (page: Page, label: string) => page.locator('.uc-stat', { hasText: label }).locator('strong');

async function openVariant(page: Page, sku: string) {
  await nav(page).getByRole('link', { name: 'Inventory' }).click();
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();
  await page.getByLabel('Search').fill(sku);
  await page.getByRole('link', { name: sku, exact: true }).click();
  await expect(page.getByRole('heading', { name: `${sku} stock` })).toBeVisible();
}

test('owner receives stock, holds it, commits and releases; ATP follows every step', async ({ page }) => {
  await signIn(page, 'owner@aurum.demo');
  await openVariant(page, 'AUR-ROPE18-20IN'); // demo seed: 1 unit at the main warehouse
  await expect(stat(page, 'Available to promise')).toHaveText('1');

  await page.getByRole('button', { name: 'Receive stock' }).click();
  let dialog = page.getByRole('dialog', { name: 'Receive stock' });
  await dialog.getByLabel('Location').selectOption({ label: 'Main warehouse (main-wh)' });
  await dialog.getByLabel('Quantity (pcs)').fill('4');
  await dialog.getByLabel('Reference (GRN / delivery note)').fill('E2E-GRN-0001');
  await dialog.getByRole('button', { name: 'Post' }).click();
  await expect(page.getByText('Stock received: 1 ledger line(s) posted')).toBeVisible();
  await expect(stat(page, 'Available to promise')).toHaveText('5');

  // The same reference cannot be posted twice.
  await page.getByRole('button', { name: 'Receive stock' }).click();
  dialog = page.getByRole('dialog', { name: 'Receive stock' });
  await dialog.getByLabel('Location').selectOption({ label: 'Main warehouse (main-wh)' });
  await dialog.getByLabel('Quantity (pcs)').fill('4');
  await dialog.getByLabel('Reference (GRN / delivery note)').fill('E2E-GRN-0001');
  await dialog.getByRole('button', { name: 'Post' }).click();
  await expect(dialog.getByText(/already posted/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(stat(page, 'Available to promise')).toHaveText('5');

  await page.getByRole('button', { name: 'Hold stock' }).click();
  dialog = page.getByRole('dialog', { name: 'Hold stock' });
  await dialog.getByLabel('Quantity (pcs)').fill('2');
  await dialog.getByRole('button', { name: 'Hold', exact: true }).click();
  await expect(page.getByText(/^Held 2 at Main warehouse until/)).toBeVisible();
  await expect(stat(page, 'Available to promise')).toHaveText('3');

  const holds = page.locator('section', {
    has: page.getByRole('heading', { name: 'Active holds and commitments' }),
  });
  await holds.getByRole('button', { name: 'Commit' }).click();
  await expect(holds.getByText('committed')).toBeVisible();
  await expect(stat(page, 'Available to promise')).toHaveText('3');
  await holds.getByRole('button', { name: 'Release' }).click();
  const release = page.getByRole('dialog', { name: 'Release reservation' });
  await release.getByLabel('Reason (recorded in the audit log)').fill('Buyer changed the order');
  await release.getByRole('button', { name: 'Release' }).click();
  await expect(page.getByText('Reservation released')).toBeVisible();
  await expect(stat(page, 'Available to promise')).toHaveText('5');

  const ledger = page.locator('section', { has: page.getByRole('heading', { name: 'Ledger' }) });
  await expect(ledger.getByRole('cell', { name: 'Commitment released' })).toBeVisible();
  await expect(ledger.getByText('E2E-GRN-0001')).toBeVisible();
  await page.screenshot({ path: 'screenshots/inventory-variant.png', fullPage: true });
});

test('a piece is held as that exact piece; dashboard and transfers work for a location-scoped operator', async ({
  page,
}) => {
  await signIn(page, 'owner@aurum.demo');
  await openVariant(page, 'AUR-BAND22-14'); // demo pieces AUR-T-0001/2 at main, AUR-T-0003 at Mumbai
  const pieces = page.locator('section', { has: page.getByRole('heading', { name: 'Pieces' }) });
  const row = pieces.getByRole('row', { name: /AUR-T-0001/ });
  await row.getByRole('button', { name: 'Hold' }).click();
  await page
    .getByRole('dialog', { name: 'Hold piece AUR-T-0001' })
    .getByRole('button', { name: 'Hold', exact: true })
    .click();
  await expect(page.getByText(/^Held AUR-T-0001 at Main warehouse/)).toBeVisible();
  await expect(row.getByText('reserved')).toBeVisible();

  // Dispatch a transfer of piece AUR-T-0002 to Mumbai.
  await tabs(page).getByRole('link', { name: 'Transfers' }).click();
  await page.getByRole('link', { name: 'New transfer' }).click();
  await expect(page.getByRole('heading', { name: 'New transfer' })).toBeVisible();
  await page.getByLabel('From', { exact: true }).selectOption({ label: 'Main warehouse (main-wh)' });
  await page.getByLabel('To', { exact: true }).selectOption({ label: 'Mumbai branch (mumbai-branch)' });
  await page.getByLabel('Find SKU or product').fill('AUR-BAND22-14');
  await page.getByRole('button', { name: /AUR-BAND22-14/ }).click();
  await page.getByLabel('Piece for AUR-BAND22-14').selectOption({ label: 'AUR-T-0002' });
  await page.getByRole('button', { name: 'Dispatch transfer' }).click();
  await expect(page.getByRole('heading', { name: /^Transfer TR-\d{6}$/ })).toBeVisible();
  const number = (await page.getByRole('heading', { name: /^Transfer TR-/ }).textContent())!.replace(
    'Transfer ',
    '',
  );

  // The Mumbai-only operator receives it.
  await page.context().clearCookies();
  await signIn(page, 'stock@aurum.demo');
  await nav(page).getByRole('link', { name: 'Inventory' }).click();
  await tabs(page).getByRole('link', { name: 'Transfers' }).click();
  await page.getByRole('link', { name: number }).click();
  await page.getByRole('button', { name: 'Receive at Mumbai branch' }).click();
  await page
    .getByRole('dialog', { name: `Receive ${number}` })
    .getByRole('button', { name: 'Receive' })
    .click();
  await expect(page.getByText(`Transfer ${number} received`)).toBeVisible();
  await tabs(page).getByRole('link', { name: 'Stock levels' }).click();
  await page.getByLabel('Search').fill('AUR-BAND22-14');
  const level = page.getByRole('row', { name: /AUR-BAND22-14/ });
  await expect(level.getByRole('cell').nth(2)).toHaveText('2'); // Mumbai now holds AUR-T-0002 and AUR-T-0003
  await page.screenshot({ path: 'screenshots/inventory-dashboard.png', fullPage: true });
});

test('stocktake previews variance, then applies it to the ledger', async ({ page }) => {
  await signIn(page, 'owner@aurum.demo');
  await nav(page).getByRole('link', { name: 'Inventory' }).click();
  await tabs(page).getByRole('link', { name: 'Stocktakes' }).click();
  await page.getByRole('link', { name: 'New stocktake' }).click();
  await expect(page.getByRole('heading', { name: 'New stocktake' })).toBeVisible();
  await page.getByLabel('Location').selectOption({ label: 'Main warehouse (main-wh)' });
  await page.getByLabel('Find SKU or product').fill('AUR-BAND22-16');
  await page.getByRole('button', { name: /AUR-BAND22-16/ }).click();
  await page.getByLabel('Counted AUR-BAND22-16').fill('5'); // demo seed: 6 on hand
  await page.getByRole('button', { name: 'Preview variance' }).click();
  await expect(page.getByText('Variance preview ready (nothing posted yet)')).toBeVisible();
  await expect(page.getByRole('cell', { name: '−1' })).toBeVisible();
  await page.getByRole('button', { name: 'Apply stocktake' }).click();
  await expect(page.getByRole('heading', { name: 'Stocktake · Main warehouse' })).toBeVisible();
  await expect(page.getByText('applied', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Variance movements in the ledger' }).click();
  await expect(page.getByRole('cell', { name: 'Stocktake', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '−1' })).toBeVisible();
  await tabs(page).getByRole('link', { name: 'Issues' }).click();
  await page.getByRole('button', { name: 'Run check now' }).click();
  await expect(page.getByText(/Checked \d+ balances: 0 mismatch\(es\)/)).toBeVisible();
});
