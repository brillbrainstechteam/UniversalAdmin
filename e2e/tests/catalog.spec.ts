import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSWORD } from '../global-setup';

const MERCHANT = 'http://localhost:3100';
const API = 'http://localhost:4100';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function signIn(page: Page, email: string) {
  await page.goto(`${MERCHANT}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

test('merchant creates, illustrates, activates and publishes a product that the storefront then serves', async ({
  page,
  request,
}) => {
  await signIn(page, 'owner@northwind.demo');
  await nav(page).getByRole('link', { name: 'Products', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Canvas Tote' })).toBeVisible(); // seeded demo product
  await page.getByRole('link', { name: 'Add product' }).click();
  await page.getByLabel('Title').fill('E2E Picnic Blanket');
  await page.getByLabel('SKU').fill('E2E-BLANKET-1');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Picnic Blanket' })).toBeVisible();

  await page
    .getByLabel('Upload image')
    .setInputFiles({ name: 'blanket.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('Image uploaded')).toBeVisible();
  await expect(page.getByRole('img', { name: 'blanket.png' })).toBeVisible();

  await page.getByRole('button', { name: 'Activate' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Product is now active')).toBeVisible();
  await page.getByRole('button', { name: /Publish to Online store/ }).click();
  await expect(page.getByRole('button', { name: /Unpublish from Online store/ })).toBeVisible();
  await page.screenshot({ path: 'screenshots/product-detail.png', fullPage: true });

  const res = await request.get(`${API}/v1/storefront/catalog/products/e2e-picnic-blanket`, {
    headers: { Host: 'northwind.localhost' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ title: 'E2E Picnic Blanket', variants: [{ sku: 'E2E-BLANKET-1' }] });
  expect(body.images).toHaveLength(1);
  const image = await request.get(`${API}${body.images[0].url}`, {
    headers: { Host: 'northwind.localhost' },
  });
  expect(image.headers()['content-type']).toBe('image/png');
});

test('products list filters, searches and saves a view', async ({ page }) => {
  await signIn(page, 'owner@aurum.demo');
  await nav(page).getByRole('link', { name: 'Products', exact: true }).click();
  await page.getByLabel('Search').fill('AUR-ROPE18');
  await expect(page.getByRole('link', { name: '18K Rope Chain' })).toBeVisible();
  await expect(page.getByRole('link', { name: '22K Plain Gold Band' })).toHaveCount(0);
  await page.getByLabel('Search').fill('');
  await page.getByLabel('Status', { exact: true }).selectOption('active');
  await page.getByRole('button', { name: 'Save view' }).click();
  await page.getByRole('dialog').getByLabel('View name').fill('Active jewellery');
  await page.getByRole('dialog').getByRole('button', { name: 'Save view' }).click();
  await expect(page.getByText('View saved')).toBeVisible();
  await expect(page.getByLabel('Saved view').locator('option:checked')).toHaveText('Active jewellery');
  await page.screenshot({ path: 'screenshots/products-list.png', fullPage: true });
});

test('CSV import previews errors and applies valid products', async ({ page }) => {
  await signIn(page, 'owner@lumiere.demo');
  await nav(page).getByRole('link', { name: 'Products', exact: true }).click();
  await page.getByRole('link', { name: 'Import CSV' }).click();
  const csv = [
    'handle,title,status,option1_name,option1_value,sku',
    'e2e-hoops,Gold Hoops,active,Size,Small,E2E-HOOP-S',
    'e2e-hoops,,,Size,Large,E2E-HOOP-L',
    'Bad Handle,Broken,,,,E2E-BAD',
  ].join('\n');
  await page
    .getByLabel('Choose CSV file')
    .setInputFiles({ name: 'hoops.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText('2 valid', { exact: true })).toBeVisible();
  await expect(page.getByText('1 with errors', { exact: true })).toBeVisible();
  await expect(page.getByText(/Handle must be a lower-case slug/)).toBeVisible();
  await page.getByRole('button', { name: 'Apply 2 valid row(s)' }).click();
  await expect(page.getByText(/1 products created/)).toBeVisible();
  await page.screenshot({ path: 'screenshots/csv-import.png', fullPage: true });
  await page.getByRole('link', { name: 'Back to products' }).click();
  await expect(page.getByRole('link', { name: 'Gold Hoops' })).toBeVisible();
});

test('viewer can browse the catalog but not change it', async ({ page }) => {
  await signIn(page, 'viewer@aurum.demo');
  await nav(page).getByRole('link', { name: 'Products', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Add product' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Antique Kada Bangle' }).click();
  await expect(page.getByLabel('Title', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Upload image' })).toHaveCount(0);
  await page.goto(page.url().replace(/products\/.*/, 'products/new'));
  await expect(page.getByText('You don’t have access to this page')).toBeVisible();
});
