import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

// Render the actual component through Vite, using representative ledger records.
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { default: Ledger } = await server.ssrLoadModule('/src/components/MobileTransactionLedger.jsx');
  const base = { date: '2026-10-23', amount: 42, accountBalanceAfter: 0, totalBalanceAfter: 125, status: 'actual', direction: 'expense', account: { name: 'Checking' } };
  const entries = [
    { ...base, id: 'manual-1', sourceType: 'manual', title: 'Groceries', category: 'Food' },
    { ...base, id: 'recurring-1', sourceType: 'generated', title: 'Rent' },
    { ...base, id: 'opening-1', sourceType: 'opening', title: 'Opening balance', direction: 'opening' },
    { ...base, id: 'transfer-1', sourceType: 'manual', title: 'Transfer', direction: 'transfer', toAccount: { name: 'Savings' } },
  ];
  const props = { entries, sort: { key: 'date', direction: 'asc' }, onSortChange() {}, isSelectable: (e) => e.sourceType !== 'opening', isSelected: (e) => e.id === 'manual-1', onToggle() {}, onEdit() {}, onDelete() {}, statusClassName: () => 'pill primary', directionClassName: () => 'pill' };
  const html = renderToStaticMarkup(React.createElement(Ledger, props));
  assert.equal((html.match(/<article /g) || []).length, 4);
  assert.equal((html.match(/type="checkbox"/g) || []).length, 3);
  assert.equal((html.match(/checked=""/g) || []).length, 1);
  assert.equal((html.match(/>Delete<\/button>/g) || []).length, 2, 'Only manual transactions offer deletion');
  assert.equal((html.match(/>Edit<\/button>/g) || []).length, 3, 'Generated and manual transactions remain editable');
  assert.ok(html.includes('Starting balance'));
  assert.ok(html.includes('Savings'));
  assert.ok(html.includes('$0.00'), 'Zero account balances must remain visible');
  assert.ok(!html.includes('<details'), 'All card information and actions are immediately visible');
  assert.ok(html.includes('Category: Food'));
  assert.ok(html.includes('mobile-transaction-balances'));
  assert.ok(html.includes('Account balance'));
  assert.ok(html.includes('Total cash'));
  const empty = renderToStaticMarkup(React.createElement(Ledger, { ...props, entries: [] }));
  assert.ok(empty.includes('No transactions match'));
  console.log('Mobile ledger checks passed: selection, manual/generated/opening actions, balances, transfers, visible category and balances, and empty results.');
} finally {
  await server.close();
}
