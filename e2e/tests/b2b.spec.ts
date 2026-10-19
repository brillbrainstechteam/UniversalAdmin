import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSWORD } from '../global-setup';

const MERCHANT = 'http://localhost:3100';
/** Aurum's B2B portal domain (demo seed); Chrome resolves *.localhost to this machine. */
const PORTAL = 'http://aurum-b2b.localhost:3102';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

async function portalSignIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`${PORTAL}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Shree Jewels Pvt Ltd (DEMO)', level: 1 })).toBeVisible();
}

test('a company buyer prices at contract rates and sends an RFQ; staff reply from the RFQ inbox', async ({
  page,
}) => {
  await portalSignIn(page, 'buyer@shree.demo');
  await expect(page.getByText('Credit available')).toBeVisible();
  // Buyers (not approvers) do not get the approvals queue.
  await expect(nav(page).getByRole('link', { name: 'Approvals' })).toHaveCount(0);

  // Quick order prices a specific piece with the company's contract book (pricing only — nothing is reserved).
  await nav(page).getByRole('link', { name: 'Quick order' }).click();
  await page.getByLabel('Lines').fill('AUR-BAND22-14, AUR-T-0003');
  await page.getByRole('button', { name: 'Get prices' }).click();
  await expect(page.getByRole('table', { name: 'Priced lines' })).toContainText('Making');
  await expect(page.getByRole('button', { name: /^Place order for ₹/ })).toBeVisible();
  await page.screenshot({ path: 'screenshots/buyer-quick-order.png', fullPage: true });

  // RFQ with a per-line note.
  await nav(page).getByRole('link', { name: 'Requests for quote' }).click();
  await page.getByRole('link', { name: 'New request' }).click();
  await page.getByLabel('Lines').fill('AUR-BAND22-14, 25, matte finish');
  await page.getByLabel('Note to supplier (optional)').fill('E2E: quote for Diwali stock');
  await page.getByRole('button', { name: 'Send request' }).click();
  const heading = page.getByRole('heading', { name: /^Request RFQ-/, level: 1 });
  await expect(heading).toBeVisible();
  const rfqNumber = ((await heading.textContent()) ?? '').replace('Request ', '').trim();
  await expect(page.getByRole('table', { name: 'Requested items' })).toContainText('matte finish');

  // Staff see it in the RFQ inbox and reply.
  await page.context().clearCookies();
  await page.goto(`${MERCHANT}/login`);
  await page.getByLabel('Email').fill('owner@aurum.demo');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await nav(page).getByRole('link', { name: 'Companies' }).click();
  await expect(page.getByRole('cell', { name: 'Shree Jewels Pvt Ltd (DEMO)' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Company sections' })
    .getByRole('link', { name: 'RFQ inbox' })
    .click();
  await page.getByRole('link', { name: rfqNumber }).click();
  await expect(page.getByRole('heading', { name: `RFQ ${rfqNumber}` })).toBeVisible();
  await page.getByLabel('Reply').fill('We can do matte finish; quotation follows.');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.getByText('We can do matte finish; quotation follows.')).toBeVisible();

  // The buyer sees the supplier's reply in the thread.
  await portalSignIn(page, 'buyer@shree.demo');
  await nav(page).getByRole('link', { name: 'Requests for quote' }).click();
  await page.getByRole('link', { name: rfqNumber }).click();
  await expect(page.getByText('We can do matte finish; quotation follows.')).toBeVisible();
  await expect(page.getByText(/\(supplier\)/)).toBeVisible();
});

test('a company approver sees the approvals queue', async ({ page }) => {
  await portalSignIn(page, 'approver@shree.demo');
  await nav(page).getByRole('link', { name: 'Approvals' }).click();
  await expect(page.getByRole('heading', { name: 'Approvals', level: 1 })).toBeVisible();
  // Nothing is waiting in a fresh demo database (approve/reject is covered by the API suite, B-06).
  await expect(page.getByText('No orders')).toBeVisible();
});
