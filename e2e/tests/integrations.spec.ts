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
const section = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Connection sections' })
    .getByRole('button', { name: new RegExp(`^${name}`) });
const stat = (page: Page, label: string) => page.locator('.uc-stat', { hasText: label }).locator('strong');

const HEADER =
  'external_id,record_type,sku,title,product_type,purity,gross_wt_g,net_wt_g,stone_wt_g,huid,tag_no,location,quantity,unit,version,updated_at,deleted';
const file = (rows: string[]) => ({
  name: 'erp-export.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from([HEADER, ...rows].join('\n')),
});

test('blocked vendor connectors are shown honestly; a CSV import previews, applies, re-imports unchanged and flags a deletion for review', async ({
  page,
}) => {
  await signIn(page, 'owner@aurum.demo');
  await nav(page).getByRole('link', { name: 'Integrations' }).click();
  await expect(page.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible();
  const tally = page.locator('.uc-card', { has: page.getByText('TallyPrime', { exact: true }) });
  await expect(tally.getByText('blocked')).toBeVisible();
  await expect(tally.getByText(/TDL \/ UDF names/)).toBeVisible();
  const deps = page.locator('section', { has: page.getByRole('heading', { name: /Blocked dependencies/ }) });
  await expect(deps.getByRole('cell', { name: 'Live metal-rate feed' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'DEMO ERP (simulator)' })).toBeVisible();

  // Discovery checklist for a blocked vendor.
  const jwelly = page.locator('.uc-card', { has: page.getByText('Jwelly ERP', { exact: true }) });
  await jwelly.getByRole('button', { name: 'Discovery checklist' }).click();
  const disc = page.getByRole('dialog', { name: /Jwelly ERP — vendor discovery/ });
  await disc.getByLabel('Status').selectOption({ label: 'Docs requested' });
  await disc.getByLabel('Vendor contact').fill('sales@jwelly.com (E2E)');
  await disc.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Discovery checklist saved')).toBeVisible();
  await expect(jwelly.getByText('Docs requested')).toBeVisible();

  // Connect a CSV / Excel file connection.
  const csvCard = page.locator('.uc-card', {
    has: page.getByText('CSV / Excel file import', { exact: true }),
  });
  await csvCard.getByRole('button', { name: 'Connect' }).click();
  const dialog = page.getByRole('dialog', { name: /Connect CSV/ });
  await dialog.getByLabel('Name').fill('E2E ERP export');
  await dialog.getByRole('button', { name: 'Create connection' }).click();
  await expect(page.getByRole('heading', { name: 'E2E ERP export' })).toBeVisible();

  await section(page, 'Sync').click();
  const rows = [
    'E2E-1,,E2E-RING-1,E2E ring one,,,,,,,,main-wh,6,pcs,1,2026-05-01 10:00,',
    'E2E-2,,E2E-RING-2,E2E ring two,,,,,,,,main-wh,3,pcs,1,2026-05-01 10:00,',
    'E2E-3,,E2E-RING-3,E2E ring three,,,,,,,,nowhere,1,pcs,1,2026-05-01 10:00,',
  ];
  await page.getByLabel('Upload CSV or Excel file').setInputFiles(file(rows));
  await expect(page.getByRole('heading', { name: 'Import erp-export.csv' })).toBeVisible();
  await expect(page.getByText('This is a preview: nothing has changed yet.')).toBeVisible();
  await expect(stat(page, 'New')).toHaveText('2');
  await expect(stat(page, 'Errors')).toHaveText('1');
  await expect(page.getByText('location: Unknown location code "nowhere"')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply all' })).toBeDisabled();
  await page.getByRole('button', { name: 'Apply valid rows only' }).click();
  await page
    .getByRole('dialog', { name: 'Apply valid rows only' })
    .getByRole('button', { name: 'Apply' })
    .click();
  await expect(page.getByText(/^Applied 2 row\(s\)/)).toBeVisible();
  await expect(page.getByText('partially committed')).toBeVisible();
  await page.screenshot({ path: 'screenshots/integration-job.png', fullPage: true });

  // Re-import the valid rows: nothing new, nothing duplicated.
  await page.getByRole('link', { name: 'E2E ERP export' }).click();
  await section(page, 'Sync').click();
  await page.getByLabel('Upload CSV or Excel file').setInputFiles(file(rows.slice(0, 2)));
  await expect(stat(page, 'Same as before')).toHaveText('2');
  await expect(stat(page, 'New')).toHaveText('0');
  await page.getByRole('button', { name: 'Discard' }).click();
  await page
    .getByRole('dialog', { name: 'Discard this preview' })
    .getByRole('button', { name: 'Discard' })
    .click();
  await expect(page.getByText('discarded', { exact: true })).toBeVisible();

  // The source marks ring two as sold: flagged for review, never deleted here.
  await page.getByRole('link', { name: 'E2E ERP export' }).click();
  await section(page, 'Sync').click();
  await page
    .getByLabel('Upload CSV or Excel file')
    .setInputFiles(file(['E2E-2,,E2E-RING-2,E2E ring two,,,,,,,,main-wh,3,pcs,2,2026-05-02 10:00,sold']));
  await expect(stat(page, 'Deleted in source')).toHaveText('1');
  await page.getByRole('button', { name: 'Apply all' }).click();
  await page.getByRole('dialog', { name: 'Apply all rows' }).getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText(/^Applied 1 row\(s\)/)).toBeVisible();
  await page.getByRole('link', { name: 'E2E ERP export' }).click();
  await section(page, 'Discrepancies').click();
  const issue = page.getByRole('row', { name: /erp record deleted/ });
  await expect(issue).toBeVisible();
  await issue.getByRole('button', { name: 'Keep ours' }).click();
  const resolve = page.getByRole('dialog', { name: 'Keep our value' });
  await resolve
    .getByLabel('Reason (recorded in the audit log)')
    .fill('Sold in store; online listing archived separately');
  await resolve.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByText('Discrepancy resolved')).toBeVisible();
  await expect(page.getByText('No open discrepancies')).toBeVisible();

  // ERP owns stock: manual changes are refused in Inventory.
  await nav(page).getByRole('link', { name: 'Inventory' }).click();
  await page.getByLabel('Search').fill('E2E-RING-1');
  await page.getByRole('link', { name: 'E2E-RING-1', exact: true }).click();
  await page.getByRole('button', { name: 'Adjust' }).click();
  const adj = page.getByRole('dialog', { name: 'Adjust stock' });
  await adj.getByLabel('Location').selectOption({ label: 'Main warehouse (main-wh)' });
  await adj.getByLabel(/^Change/).fill('1');
  await adj.getByLabel(/^Note/).fill('Trying a manual change');
  await adj.getByRole('button', { name: 'Post' }).click();
  await expect(adj.getByText(/owned by the connection "E2E ERP export"/)).toBeVisible();
});

test('simulator: pull, advance a change, and export a test order', async ({ page }) => {
  await signIn(page, 'owner@aurum.demo');
  await nav(page).getByRole('link', { name: 'Integrations' }).click();
  await page.getByRole('link', { name: 'DEMO ERP (simulator)' }).click();
  await expect(page.getByText(/built-in simulator: demo data, not a real ERP/)).toBeVisible();
  await section(page, 'Sync').click();
  await page.getByRole('button', { name: 'Pull from simulator' }).click();
  await expect(page.getByRole('heading', { name: 'Simulator pull (step 0)' })).toBeVisible();
  await expect(stat(page, 'New')).toHaveText('9');
  await page.getByRole('button', { name: 'Apply all' }).click();
  await page.getByRole('dialog', { name: 'Apply all rows' }).getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText(/^Applied 9 row\(s\)/)).toBeVisible();

  await page.getByRole('link', { name: 'DEMO ERP (simulator)' }).click();
  await section(page, 'Sync').click();
  await page.getByRole('button', { name: 'Advance one change' }).click();
  await expect(page.getByText(/Step 1: .*Ring 01 sold one/)).toBeVisible();
  await page.getByRole('button', { name: 'Pull from simulator' }).click();
  await expect(stat(page, 'Changed')).toHaveText('1');
  await expect(stat(page, 'Same as before')).toHaveText('8');

  await page.getByRole('link', { name: 'DEMO ERP (simulator)' }).click();
  await section(page, 'Order export').click();
  await page.getByRole('button', { name: 'Queue export' }).click();
  await expect(page.getByText(/queued for export/)).toBeVisible();
  await expect(page.getByRole('row', { name: /TEST-SO-/ }).getByText('pending')).toBeVisible();
  await page.screenshot({ path: 'screenshots/integration-connection.png', fullPage: true });
});
