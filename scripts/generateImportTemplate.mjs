import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SpreadsheetFile,
  Workbook,
} from 'file:///C:/Users/lsmith/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const outputPath = path.join(projectRoot, 'public', 'budget-transaction-import-template.xlsx');

const directions = ['income', 'expense', 'transfer'];
const categories = [
  'Payroll',
  'Rent / Mortgage',
  'Utilities',
  'Insurance',
  'Groceries',
  'Dining',
  'Fuel',
  'Transfer',
  'Debt Payment',
  'Savings',
  'Subscription',
  'Medical',
  'Travel',
  'Shopping',
  'Other',
];

const workbook = Workbook.create();
const instructions = workbook.worksheets.add('Instructions');
const transactions = workbook.worksheets.add('Transactions');

instructions.getRange('A1').values = [['Budget Projection Import Template']];
instructions.getRange('A3:A11').values = [
  ['Fill transaction rows on the Transactions sheet only.'],
  ['Required columns: date, title, direction, amount, account.'],
  ['Use YYYY-MM-DD for dates to avoid import issues.'],
  ['Direction cells include a dropdown: income, expense, or transfer.'],
  ['Category cells include a dropdown with the built-in app categories.'],
  ['Status is optional. If blank, the app defaults it to actual.'],
  ['For transfers, fill both account and to_account.'],
  ['account and to_account must exactly match account names already created in the app.'],
  ['Blank rows are ignored during import.'],
];

transactions.getRange('A1:I2').values = [
  ['date', 'title', 'direction', 'status', 'amount', 'account', 'to_account', 'category', 'notes'],
  ['', '', '', '', '', '', '', '', ''],
];

transactions.getRange('C2:C500').dataValidation = {
  allowBlank: true,
  list: {
    inCellDropDown: true,
    source: directions,
  },
  errorAlert: {
    style: 'stop',
    title: 'Invalid direction',
    message: 'Choose income, expense, or transfer from the dropdown.',
  },
};

transactions.getRange('H2:H500').dataValidation = {
  allowBlank: true,
  list: {
    inCellDropDown: true,
    source: categories,
  },
  errorAlert: {
    style: 'stop',
    title: 'Invalid category',
    message: 'Choose one of the template categories from the dropdown.',
  },
};

const output = await SpreadsheetFile.exportXlsx(workbook);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await output.save(outputPath);

console.log(`Wrote ${outputPath}`);
