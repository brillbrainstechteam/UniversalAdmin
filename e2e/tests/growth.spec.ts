import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSWORD } from '../global-setup';

const MERCHANT = 'http://localhost:3100';
const STORE = 'http://northwind.localhost:3103';
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

test('staff publish a page and banner and create a code; shoppers see them and the code applies before payment', async ({
  page,
}) => {
  await page.goto(`${MERCHANT}/login`);
  await page.getByLabel('Email').fill('owner@northwind.demo');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // A page: draft → publish.
  await nav(page).getByRole('link', { name: 'Online Store' }).click();
  await expect(page.getByRole('heading', { name: 'Online Store', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New page' }).click();
  await page.getByLabel('Title').fill('Our story');
  await expect(page.getByLabel('Address')).toHaveValue('our-story');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Page /pages/our-story' })).toBeVisible();
  await page.getByRole('button', { name: 'Add block' }).click();
  await page
    .getByLabel('Text', { exact: true })
    .fill('Northwind has made sturdy everyday goods since 1984 (demo story).');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft differs from what is live')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/^Live: version 1/)).toBeVisible();

  // The announcement banner.
  await nav(page).getByRole('link', { name: 'Online Store' }).click();
  await page.getByRole('link', { name: 'Announcement banner' }).click();
  await page.getByLabel('Message').fill('Free gift wrap this week (demo)');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/^Live: version 1/)).toBeVisible();

  // A 10% code.
  await nav(page).getByRole('link', { name: 'Discounts' }).click();
  await page.getByRole('button', { name: 'New discount' }).click();
  await page.getByLabel('Name').fill('E2E ten percent');
  await page.getByLabel('Code (empty = automatic)').fill('E2E10');
  await page.getByLabel('Percent').fill('10');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Discounts' })).toContainText('E2E10');

  // Shopper side.
  await page.context().clearCookies();
  await page.goto(`${STORE}/pages/our-story`);
  await expect(page.getByRole('heading', { name: 'Our story' })).toBeVisible();
  await expect(page.getByText('sturdy everyday goods')).toBeVisible();
  await expect(page.getByText('Free gift wrap this week (demo)')).toBeVisible();
  await page.goto(`${STORE}/products/enamel-mug?utm_source=e2e-newsletter`);
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.getByLabel('Discount code').fill('E2E10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Code E2E10: −£0.95')).toBeVisible();
  await expect(page.getByText('Total £8.55')).toBeVisible();
  await page.screenshot({ path: 'screenshots/storefront-cart-discount.png', fullPage: true });
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByLabel('Full name').fill('Growth Shopper');
  await page.getByLabel('E-mail').fill('growth.shopper@example.test');
  await page.getByLabel('Address line 1').fill('2 Harbour Way');
  await page.getByLabel('City').fill('Leeds');
  await page.getByLabel('Country code').fill('GB');
  await page.getByRole('button', { name: 'Place order for £8.55' }).click();
  await page.getByRole('button', { name: 'Pay (sandbox)' }).click();
  await expect(page.getByText('payment received and your order is confirmed')).toBeVisible();

  // Reports: attribution shows the newsletter order, with definitions.
  await page.context().clearCookies();
  await page.goto(`${MERCHANT}/login`);
  await page.getByLabel('Email').fill('owner@northwind.demo');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await nav(page).getByRole('link', { name: 'Analytics' }).click();
  await page.getByLabel('Report').selectOption({ label: 'Attribution' });
  await expect(page.getByRole('table', { name: 'Attribution' })).toContainText('e2e-newsletter');
  await expect(page.getByText('No acquisition cost (CAC/ROAS) is shown')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Metric definitions' })).toBeVisible();
  await page.screenshot({ path: 'screenshots/analytics-attribution.png', fullPage: true });
});
