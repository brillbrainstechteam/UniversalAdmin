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

test('owner records per-piece weights in bulk, corrects one with a reason, and maker-checker blocks self-review', async ({
  page,
}) => {
  await signIn(page, 'owner@aurum.demo');
  await nav(page).getByRole('link', { name: 'Products', exact: true }).click();
  await page.getByRole('link', { name: '22K Plain Gold Band' }).click();
  const card = page.locator('section', {
    has: page.getByRole('heading', { name: 'Jewellery measurements' }),
  });
  await expect(card.getByText('4.600 g / 4.600 g / 0.000 g')).toBeVisible(); // design weights of size 14

  await card.getByRole('button', { name: 'Add pieces of AUR-BAND22-12' }).click();
  const dialog = page.getByRole('dialog', { name: /Add pieces/ });
  await dialog
    .getByLabel('Paste rows')
    .fill('E2E-P-001\tEE0001\t4.211\t4.211\t0\nE2E-P-002\t\t4.198\t4.198\t0');
  await dialog.getByRole('button', { name: 'Use pasted rows' }).click();
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByText('All 2 rows are valid')).toBeVisible();
  await expect(dialog.getByText('fine 3.857 g')).toBeVisible(); // 4.211 × 0.916 = 3.857276 → 3.857
  await dialog.getByRole('button', { name: 'Create 2 item(s)' }).click();
  await expect(page.getByText('2 items created')).toBeVisible();

  await nav(page).getByRole('link', { name: 'Serialized items' }).click();
  await page.getByLabel('Search').fill('E2E-P-001');
  await page.getByRole('link', { name: 'E2E-P-001' }).click();
  await expect(page.getByRole('heading', { name: 'Piece E2E-P-001' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '4.211000' }).first()).toBeVisible(); // canonical grams shown apart from input

  // Edit policy: correcting an active piece needs a reason.
  await page.getByLabel('Gross weight', { exact: true }).fill('4.215');
  await page.getByLabel('Net weight', { exact: true }).fill('4.215');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Give a reason when correcting/)).toBeVisible();
  await page.getByLabel('Reason for this change').fill('Re-weighed after final polish');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Item saved')).toBeVisible();
  await expect(page.getByRole('cell', { name: '4.215000' }).first()).toBeVisible();

  // Weight exception goes to review; the same person cannot approve it.
  await page.getByLabel('Net weight', { exact: true }).fill('4.300');
  await page
    .getByLabel('Weight exception reason (only if net exceeds gross)')
    .fill('Gross captured before soldering');
  await page.getByLabel('Reason for this change').fill('Recording exception for review');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Weight exception — review required' })).toBeVisible();
  await page.getByLabel('Review note').fill('Approving my own change');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('A different person must review')).toBeVisible();
  await page.screenshot({ path: 'screenshots/serial-item-review.png', fullPage: true });
});

test('owner confirms a default purity in jewellery settings', async ({ page }) => {
  await signIn(page, 'owner@lumiere.demo');
  await nav(page).getByRole('link', { name: 'Jewellery', exact: true }).click();
  await expect(page.getByText(/Some purities are platform defaults/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm 18K (750)' }).click();
  await expect(page.getByText('Purity confirmed')).toBeVisible();
  await page.screenshot({ path: 'screenshots/jewellery-settings.png', fullPage: true });
});

test('general-commerce merchants see no jewellery modules', async ({ page }) => {
  await signIn(page, 'owner@northwind.demo');
  await expect(nav(page).getByRole('link', { name: 'Serialized items' })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'Jewellery', exact: true })).toHaveCount(0);
  await nav(page).getByRole('link', { name: 'Products', exact: true }).click();
  await page.getByRole('link', { name: 'Canvas Tote' }).click();
  await expect(page.getByRole('heading', { name: 'Jewellery measurements' })).toHaveCount(0);
});
