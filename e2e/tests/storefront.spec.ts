import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSWORD } from '../global-setup';

const MERCHANT = 'http://localhost:3100';
/** Northwind's B2C store domain (demo seed); Chrome resolves *.localhost to this machine. */
const STORE = 'http://northwind.localhost:3103';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

test('a shopper registers, buys, pays (sandbox); staff ship it and the customer sees the shipment', async ({
  page,
}) => {
  const email = `e2e.customer.${Date.now()}@example.test`;
  await page.goto(`${STORE}/account/register`);
  await expect(page.getByText(/Demo store/)).toBeVisible();
  await page.getByLabel('Full name').fill('E2E Customer');
  await page.getByLabel('E-mail', { exact: true }).fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByLabel('E-mail me offers and news').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, E2E Customer' })).toBeVisible();

  // Product → server price → cart → checkout (prefilled from the account).
  await page.goto(`${STORE}/products/enamel-mug`);
  await expect(page.getByRole('heading', { name: 'Enamel Mug', level: 1 })).toBeVisible();
  await page.getByLabel('Quantity').fill('2');
  await expect(page.getByText('£19.00', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByRole('heading', { name: 'Cart' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Cart lines' })).toContainText('Enamel Mug');
  await page.getByRole('link', { name: 'Checkout' }).click();
  await expect(page.getByLabel('E-mail', { exact: true })).toHaveValue(email);
  await page.getByLabel('Address line 1').fill('9 Market Row');
  await page.getByLabel('City').fill('Bristol');
  await page.getByLabel('Country code').fill('GB');
  await page.getByRole('button', { name: 'Place order for £19.00' }).click();
  const heading = page.getByRole('heading', { name: /^Order / });
  await expect(heading).toBeVisible();
  const number = ((await heading.textContent()) ?? '').replace('Order ', '').trim();
  await expect(page.getByText('Sandbox payment')).toBeVisible();
  await page.getByRole('button', { name: 'Pay (sandbox)' }).click();
  await expect(page.getByText('payment received and your order is confirmed')).toBeVisible();
  await page.screenshot({ path: 'screenshots/storefront-order.png', fullPage: true });
  await page.getByRole('link', { name: 'My account' }).click();
  await expect(page.getByRole('link', { name: number })).toBeVisible();

  // Staff pack and dispatch it; the customer appears under Customers.
  await page.context().clearCookies();
  await page.goto(`${MERCHANT}/login`);
  await page.getByLabel('Email').fill('owner@northwind.demo');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await nav(page).getByRole('link', { name: 'Customers' }).click();
  await expect(page.getByRole('link', { name: /E2E Customer/ }).first()).toBeVisible();
  await nav(page).getByRole('link', { name: 'Orders' }).click();
  await page.getByLabel('Search').fill(number);
  await page.getByRole('link', { name: number }).click();
  await expect(page.getByRole('link', { name: /Customer account: E2E Customer/ })).toBeVisible();
  await page.getByRole('button', { name: 'Pack shipment' }).click();
  await page.getByRole('button', { name: 'Ship', exact: true }).click();
  await page.getByLabel('Carrier').fill('Demo Courier');
  await page.getByLabel('Tracking number (optional)').fill('DEMO-123');
  await page.getByRole('button', { name: 'Dispatch' }).click();
  await expect(page.getByRole('table', { name: 'Shipments' })).toContainText('Demo Courier · DEMO-123');
  await expect(page.getByRole('table', { name: 'Customer messages' })).toContainText(
    `Order ${number} has shipped`,
  );
  await page.screenshot({ path: 'screenshots/order-fulfillment.png', fullPage: true });

  // The customer sees the shipment.
  await page.context().clearCookies();
  await page.goto(`${STORE}/account/login`);
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: number }).click();
  await expect(page.getByText(/On its way · Demo Courier · tracking number DEMO-123/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request return' })).toBeVisible();
});
