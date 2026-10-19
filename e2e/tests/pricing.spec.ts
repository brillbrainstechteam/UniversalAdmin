import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSWORD } from '../global-setup';

const MERCHANT = 'http://localhost:3100';

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`${MERCHANT}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const tabs = (page: Page) => page.getByRole('navigation', { name: 'Pricing sections' });

async function openPricing(page: Page) {
  await nav(page)
    .getByRole('link', { name: /^Pricing( & Metal Rates)?$/ })
    .click();
  await expect(page.getByRole('heading', { name: /^Pricing( & metal rates)?$/, level: 1 })).toBeVisible();
}

test('a proposed rate needs a second person: the proposer cannot approve, the approver publishes it', async ({
  page,
}) => {
  await signIn(page, 'owner@aurum.demo');
  await openPricing(page);
  await tabs(page).getByRole('link', { name: 'Metal rates' }).click();
  await page.getByRole('button', { name: 'Propose rate' }).click();
  const dialog = page.getByRole('dialog', { name: 'Propose a metal rate' });
  await dialog.getByLabel('Purity').selectOption({ label: 'gold · 22K (916)' });
  await dialog.getByLabel('Rate (INR)').fill('70000');
  await dialog.getByLabel('Quoted unit').selectOption({ label: 'per 10 grams' });
  await dialog.getByLabel('Reason / source reference').fill('E2E board rate check');
  await dialog.getByRole('button', { name: 'Propose' }).click();
  await expect(page.getByText('Rate proposed — it needs another person to approve it')).toBeVisible();
  const row = page.getByRole('row', { name: /E2E board rate check/ });
  await expect(row.getByText('Needs another approver')).toBeVisible();
  await expect(row.getByText('(70000 per 10g)')).toBeVisible();

  await signIn(page, 'rates@aurum.demo');
  await openPricing(page);
  const pending = page.locator('section', {
    has: page.getByRole('heading', { name: 'Rate proposals waiting for approval' }),
  });
  await pending.getByRole('button', { name: 'Approve 22K (916) rate' }).click();
  await expect(page.getByText('22K (916) rate approved')).toBeVisible();
  const current = page.locator('section', {
    has: page.getByRole('heading', { name: 'Current metal rates' }),
  });
  await expect(current.getByRole('row', { name: /22K \(916\)/ }).getByText('₹7,000.00')).toBeVisible();
  await page.screenshot({ path: 'screenshots/pricing-rates.png', fullPage: true });
});

test('calculator explains a piece price, saves a quote and revalidates it', async ({ page }) => {
  await signIn(page, 'owner@aurum.demo');
  await openPricing(page);
  await tabs(page).getByRole('link', { name: 'Calculator' }).click();
  await page.getByLabel('Find by SKU, title or piece tag').fill('AUR-T-0002');
  await page.getByRole('button', { name: /Piece AUR-T-0002/ }).click();
  await page.getByRole('button', { name: 'Calculate' }).click();
  const breakdown = page.getByRole('table', { name: /Breakdown for/ });
  // 4.587 g × 7000 = 32,109.00 ; 4.587 × 450 = 2,064.15 ; hallmark 45 → 34,218.15
  await expect(breakdown.getByRole('row', { name: /Metal value \(net weight\)/ })).toContainText(
    '₹32,109.00',
  );
  await expect(breakdown.getByRole('row', { name: /Making charge per gram/ })).toContainText('₹2,064.15');
  await expect(breakdown.getByRole('row', { name: /^Total/ })).toContainText('₹34,218.15');
  await expect(page.getByText(/Rate ₹7,000.00\/g from Manual entry/)).toBeVisible();
  await page.screenshot({ path: 'screenshots/pricing-calculator.png', fullPage: true });

  await page.getByRole('button', { name: 'Save as quote' }).click();
  await expect(page.getByRole('heading', { name: 'Quote ₹34,218.15' })).toBeVisible();
  await page.getByRole('button', { name: 'Revalidate with current rates' }).click();
  await expect(page.getByText('Price unchanged; this quote is still valid.')).toBeVisible();
  await tabs(page).getByRole('link', { name: 'Quotes' }).click();
  await expect(page.getByRole('cell', { name: '₹34,218.15' }).first()).toBeVisible();
});

test('general commerce prices from list prices without any metal rates', async ({ page }) => {
  await signIn(page, 'owner@northwind.demo');
  await expect(nav(page).getByRole('link', { name: 'Pricing', exact: true })).toBeVisible();
  await openPricing(page);
  await expect(tabs(page).getByRole('link', { name: 'Metal rates' })).toHaveCount(0);
  await tabs(page).getByRole('link', { name: 'Calculator' }).click();
  await page.getByLabel('Find by SKU, title or piece tag').fill('NW-MUG');
  await page.getByRole('button', { name: /NW-MUG-01/ }).click();
  await page.getByLabel('Quantity (pieces)').fill('2');
  await page.getByRole('button', { name: 'Calculate' }).click();
  await expect(
    page.getByRole('table', { name: /Breakdown for/ }).getByRole('row', { name: /^Total/ }),
  ).toContainText('£19.00');
});

test('tax rules start pending validation; viewers can read pricing but not change it', async ({ page }) => {
  await signIn(page, 'owner@northwind.demo');
  await openPricing(page);
  await tabs(page).getByRole('link', { name: 'Settings & tax' }).click();
  await page.getByRole('button', { name: 'New tax rule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New tax rule' });
  await dialog.getByLabel('Label').fill('E2E VAT (to validate)');
  await dialog.getByLabel('Rate %').fill('20');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('row', { name: /E2E VAT/ }).getByText('pending validation')).toBeVisible();

  await signIn(page, 'viewer@aurum.demo');
  await openPricing(page);
  await tabs(page).getByRole('link', { name: 'Metal rates' }).click();
  await expect(page.getByRole('heading', { name: 'Metal rates', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Propose rate' })).toHaveCount(0);
  await tabs(page).getByRole('link', { name: 'Price books & rules' }).click();
  await expect(page.getByRole('button', { name: 'New price book' })).toHaveCount(0);
});
