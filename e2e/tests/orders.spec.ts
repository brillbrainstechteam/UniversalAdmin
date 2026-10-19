import { expect, request as pwRequest, test, type Page } from '@playwright/test';
import { requireEnv } from '@uc/db';
import { E2E_PASSWORD } from '../global-setup';

const MERCHANT = 'http://localhost:3100';
const API = 'http://localhost:4100';

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`${MERCHANT}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const tabs = (page: Page) => page.getByRole('navigation', { name: 'Order sections' });

async function openOrders(page: Page) {
  await nav(page).getByRole('link', { name: 'Orders' }).click();
  await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible();
}

test('a storefront shopper checks out and pays (sandbox); staff see the frozen breakdown and timeline', async ({
  page,
}) => {
  // Headless storefront call path: a trusted storefront server forwards the shopper's domain with the gateway key.
  const shop = await pwRequest.newContext({
    baseURL: API,
    extraHTTPHeaders: {
      'x-storefront-host': 'northwind.localhost',
      'x-storefront-key': requireEnv('STOREFRONT_GATEWAY_KEY'),
    },
  });
  const product = await (await shop.get('/v1/storefront/catalog/products/enamel-mug')).json();
  const variantId = product.variants[0].id as string;
  const cart = await (await shop.post('/v1/storefront/carts')).json();
  const priced = await (
    await shop.put(`/v1/storefront/carts/${cart.cartId}/lines`, {
      headers: { 'x-cart-token': cart.cartToken },
      data: { lines: [{ variantId, quantity: 2 }] },
    })
  ).json();
  expect(priced.quote.totalMinor).toBe('1900');
  const placed = await shop.post('/v1/storefront/checkouts', {
    headers: { 'idempotency-key': `e2e-checkout-${Date.now()}` },
    data: {
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      quoteId: priced.quote.id,
      acknowledgedTotalMinor: priced.quote.totalMinor,
      contact: { name: 'E2E Shopper', email: 'e2e.shopper@example.test' },
      shippingAddress: { line1: '9 Market Row', city: 'Bristol', countryCode: 'GB' },
    },
  });
  expect(placed.status()).toBe(201);
  const order = await placed.json();
  const paid = await (
    await shop.post(`/v1/storefront/orders/${order.id}/sandbox-payment`, {
      data: { cartToken: cart.cartToken, outcome: 'succeeded' },
    })
  ).json();
  expect(paid).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
  await shop.dispose();

  await signIn(page, 'owner@northwind.demo');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await openOrders(page);
  await page.getByLabel('Search').fill(order.number);
  await page.getByRole('link', { name: order.number }).click();
  await expect(page.getByRole('heading', { name: `Order ${order.number}` })).toBeVisible();
  await expect(page.getByText('confirmed', { exact: true })).toBeVisible();
  await expect(page.getByText('paid', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Line 1 · £19.00' })).toBeVisible();
  await expect(
    page.getByRole('table', { name: /Breakdown for Enamel Mug/ }).getByRole('row', { name: /^Total/ }),
  ).toContainText('£19.00');
  await expect(page.getByText('Payment captured (sandbox)')).toBeVisible();
  await expect(page.getByText('SANDBOX', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'screenshots/order-detail.png', fullPage: true });
});

test('a staff order above the threshold waits for a second person, who approves it', async ({ page }) => {
  await signIn(page, 'owner@northwind.demo');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await openOrders(page);
  await tabs(page).getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Approval threshold (GBP)').fill('10.00');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Order settings saved')).toBeVisible();

  await tabs(page).getByRole('link', { name: 'Orders' }).click();
  await page.getByRole('link', { name: 'New order' }).click();
  await page.getByLabel('Customer name').fill('Wholesale Buyer Ltd');
  await page.getByLabel('Customer email').fill('buyer@example.test');
  await page.getByLabel('Add item (SKU, title or piece tag)').fill('NW-TOTE-NAT');
  await page.getByRole('button', { name: /Add NW-TOTE-NATURAL/ }).click();
  await page.getByRole('button', { name: 'Preview price' }).click();
  await expect(page.getByText('£18.00')).toBeVisible();
  await page.getByRole('button', { name: 'Create order' }).click();
  await expect(page.getByRole('heading', { name: /^Order ORD-/ })).toBeVisible();
  await expect(page.getByText('awaiting approval', { exact: true })).toBeVisible();
  await expect(
    page.getByText('You created this order, so someone else with approval rights must approve it.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  const orderUrl = page.url();

  await signIn(page, 'multi@demo.local'); // Northwind administrator
  await expect(page.getByRole('heading', { name: 'Choose a merchant' })).toBeVisible();
  await page.goto(orderUrl);
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Order approved')).toBeVisible();
  await expect(page.getByText('confirmed', { exact: true })).toBeVisible();
  await expect(page.getByText('Confirmed (stock committed)')).toBeVisible();
});

test('a quotation freezes its price and converts into an order', async ({ page }) => {
  await signIn(page, 'owner@northwind.demo');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await openOrders(page);
  await tabs(page).getByRole('link', { name: 'Quotations' }).click();
  await page.getByRole('link', { name: 'New quotation' }).click();
  await page.getByLabel('Customer name').fill('Cafe Corner');
  await page.getByLabel('Customer email').fill('cafe@example.test');
  await page.getByLabel('Add item (SKU, title or piece tag)').fill('NW-MUG');
  await page.getByRole('button', { name: /Add NW-MUG-01/ }).click();
  await page.getByLabel('Quantity for NW-MUG-01 · Enamel Mug').fill('4');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('heading', { name: /^Quotation QUO-/ })).toBeVisible();
  await page.getByRole('button', { name: 'Send (freeze price)' }).click();
  await expect(page.getByText('Quotation sent — price frozen')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Frozen price £38.00' })).toBeVisible();
  await page.getByRole('button', { name: 'Record acceptance' }).click();
  const dialog = page.getByRole('dialog', { name: "Record the customer's acceptance" });
  await dialog.getByLabel('Who accepted and how').fill('Accepted by phone, E2E');
  await dialog.getByRole('button', { name: 'Record acceptance' }).click();
  await expect(page.getByText('Acceptance recorded')).toBeVisible();
  await page.getByRole('button', { name: 'Convert to order' }).click();
  await expect(page.getByRole('heading', { name: /^Order ORD-/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'From quotation' })).toBeVisible();
  await expect(page.getByText('£38.00').first()).toBeVisible();
});
