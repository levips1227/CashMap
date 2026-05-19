import { startTransition, useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { budgetApi } from './api';
import {
  addDays,
  buildBudgetInsights,
  buildProjection,
  describeRecurringRule,
  formatCurrency,
  formatCurrencyCompact,
  formatDateLabel,
  formatMonthLabel,
  getDefaultDateRange,
  getMonthBounds,
  getMonthKey,
  getRulePreview,
  getTodayKey,
} from './budgetEngine';
import DebtPayoffCalculator from './DebtPayoffCalculator';
import {
  buildLoanDebtRows,
  createBlankDebtRow,
  mergeLoanDebtRows,
} from './debtPayoffUtils';
import LegacyLoanManager from './LegacyLoanManager';

const VIEW_OPTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'recurring', label: 'Recurring' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'loans', label: 'Loans' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'reconcile', label: 'Reconcile' },
];

const PASSWORD_MIN_LENGTH = 8;
const USER_ROLES = ['Admin', 'Standard User'];
const HOUSEHOLD_ROLES = ['Owner', 'Member', 'Viewer'];
const GENDER_OPTIONS = ['Male', 'Female', 'Nonbinary', 'Other', 'Prefer not to say'];
const INCOME_BRACKETS = Array.from({ length: 10 }, (_, index) => {
  const start = index * 20000;
  const end = start + 19999;
  return `$${start.toLocaleString()} - $${end.toLocaleString()}`;
}).concat('$200,000+');

const DEFAULT_LOOKUPS = {
  cashWarningThreshold: 150,
  statuses: ['Projected', 'Actual', 'Cleared'],
  statusFilters: ['All', 'Projected', 'Actual', 'Cleared', 'Actual + Cleared'],
  ruleDirections: ['Income', 'Expense', 'Transfer'],
  frequencyUnits: ['Day', 'Week', 'Month'],
  cashAccountTypes: ['Checking', 'Savings', 'Cash', 'Wallet', 'Brokerage', 'Other'],
  budgetDirections: ['Expense', 'Income'],
  budgetModes: ['Limit', 'Goal'],
  categorySuggestions: [
    'Payroll',
    'Rent / Mortgage',
    'Utilities',
    'Insurance',
    'Groceries',
    'Dining',
    'Fuel',
    'Transfer',
    'Debt Payment',
    'Credit Card',
    'Savings',
    'Subscription',
    'Medical',
    'Travel',
    'Shopping',
    'Other',
  ],
  accountColorPalette: ['#155eef', '#0891b2', '#0f766e', '#7c3aed', '#b45309', '#dc2626'],
};

function getInviteTokenFromUrl() {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('invite') || '';
}

function getDefaultProfileDraft(user = null) {
  return {
    firstName: user?.firstName || '',
    lastName: user?.lastName || '',
    phone: user?.phone || '',
    gender: user?.gender || 'Prefer not to say',
    annualHouseholdIncome: user?.annualHouseholdIncome || '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  };
}

function clearInviteTokenFromUrl() {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.delete('invite');
  window.history.replaceState({}, '', url.toString());
}

function getDefaultAccountDraft(lookups = DEFAULT_LOOKUPS) {
  return {
    name: '',
    institution: '',
    trackingType: 'cash',
    accountType: lookups.cashAccountTypes[0],
    color: lookups.accountColorPalette[0],
    openingBalance: '0.00',
    openingBalanceDate: getTodayKey(),
    notes: '',
    sortOrder: '0',
    isActive: true,
    warningBalance: String(lookups.cashWarningThreshold ?? 150),
    minimumBalance: '0.00',
  };
}

function getDefaultTransactionDraft(accounts = []) {
  const primary = accounts[0]?.id ?? '';
  const secondary = accounts[1]?.id ?? '';
  return {
    date: getTodayKey(),
    title: '',
    amount: '',
    direction: 'expense',
    status: 'actual',
    accountId: primary,
    toAccountId: secondary,
    category: '',
    notes: '',
    recurringRuleId: null,
    occurrenceKey: '',
  };
}

let batchTransactionRowSequence = 1;

function createBatchTransactionRow(accounts = []) {
  return {
    rowId: `batch-row-${batchTransactionRowSequence++}`,
    ...getDefaultTransactionDraft(accounts),
  };
}

function getDefaultBatchTransactionRows(accounts = [], count = 4) {
  return Array.from({ length: count }, () => createBatchTransactionRow(accounts));
}

function isBatchTransactionRowMeaningful(row) {
  return Boolean(
    String(row.title || '').trim()
    || String(row.amount || '').trim()
    || String(row.category || '').trim()
    || String(row.notes || '').trim(),
  );
}

function getMeaningfulBatchTransactionRows(rows) {
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => isBatchTransactionRowMeaningful(row));
}

function normalizeImportHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeImportDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value || '').trim();
  if (!text) {
    throw new Error('Date is required.');
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    const [, monthText, dayText, yearText] = slashMatch;
    const year = yearText.length === 2 ? `20${yearText}` : yearText;
    const month = monthText.padStart(2, '0');
    const day = dayText.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  throw new Error(`Could not read date "${text}". Use YYYY-MM-DD.`);
}

function normalizeImportDirection(value) {
  const direction = String(value || '').trim().toLowerCase();
  if (['income', 'expense', 'transfer'].includes(direction)) {
    return direction;
  }
  throw new Error(`Direction must be income, expense, or transfer. Received "${value}".`);
}

function normalizeImportStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (!status) return 'actual';
  if (['projected', 'actual', 'cleared'].includes(status)) {
    return status;
  }
  throw new Error(`Status must be projected, actual, or cleared. Received "${value}".`);
}

function normalizeImportAmount(value) {
  if (value === '' || value === null || value === undefined) {
    throw new Error('Amount is required.');
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Amount must be a positive number. Received "${value}".`);
  }
  return amount;
}

async function buildImportedTransactionsFromWorkbook(file, accounts) {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const sheetName = workbook.SheetNames.find((name) => normalizeImportHeader(name) === 'transactions') || workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('No worksheet found in the uploaded workbook.');
  }

  const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false });
  if (!rawRows.length) {
    throw new Error('The workbook does not contain any transaction rows to import.');
  }

  const accountLookup = new Map(accounts.map((account) => [account.name.trim().toLowerCase(), account]));
  const importedTransactions = [];

  rawRows.forEach((rawRow, index) => {
    const rowNumber = index + 2;
    const row = Object.fromEntries(
      Object.entries(rawRow).map(([key, value]) => [normalizeImportHeader(key), value]),
    );

    const title = String(row.title || '').trim();
    const category = String(row.category || '').trim();
    const notes = String(row.notes || '').trim();

    if (!title && !row.amount && !category && !notes) {
      return;
    }

    if (!title) {
      throw new Error(`Import row ${rowNumber}: title is required.`);
    }

    const direction = normalizeImportDirection(row.direction);
    const status = normalizeImportStatus(row.status);
    const sourceAccountName = String(row.account || row.source_account || '').trim().toLowerCase();
    if (!sourceAccountName) {
      throw new Error(`Import row ${rowNumber}: account is required.`);
    }

    const sourceAccount = accountLookup.get(sourceAccountName);
    if (!sourceAccount) {
      throw new Error(`Import row ${rowNumber}: account "${row.account}" does not match an existing account name in the app.`);
    }

    let destinationAccount = null;
    const destinationName = String(row.to_account || row.destination_account || '').trim().toLowerCase();
    if (direction === 'transfer') {
      if (!destinationName) {
        throw new Error(`Import row ${rowNumber}: to_account is required for transfer rows.`);
      }
      destinationAccount = accountLookup.get(destinationName);
      if (!destinationAccount) {
        throw new Error(`Import row ${rowNumber}: to_account "${row.to_account}" does not match an existing account name in the app.`);
      }
      if (destinationAccount.id === sourceAccount.id) {
        throw new Error(`Import row ${rowNumber}: transfer source and destination must be different.`);
      }
    }

    importedTransactions.push({
      date: normalizeImportDate(row.date),
      title,
      direction,
      status,
      amount: normalizeImportAmount(row.amount),
      accountId: sourceAccount.id,
      toAccountId: destinationAccount?.id ?? null,
      category,
      notes,
    });
  });

  if (!importedTransactions.length) {
    throw new Error('The workbook only contained blank rows. Add transactions below the header row and try again.');
  }

  return importedTransactions;
}

function buildTransactionPayload(draft) {
  return {
    ...draft,
    amount: Number(draft.amount || 0),
    accountId: Number(draft.accountId),
    toAccountId: draft.direction === 'transfer' && draft.toAccountId
      ? Number(draft.toAccountId)
      : null,
    recurringRuleId: draft.recurringRuleId ? Number(draft.recurringRuleId) : null,
    occurrenceKey: draft.occurrenceKey || '',
  };
}

function buildTransactionDraftFromEntry(entry, statusOverride = entry.status) {
  return {
    date: entry.date,
    title: entry.title,
    amount: String(entry.amount),
    direction: entry.direction,
    status: statusOverride,
    accountId: entry.accountId,
    toAccountId: entry.toAccountId || '',
    category: entry.category || '',
    notes: entry.notes || '',
    recurringRuleId: entry.recurringRuleId || null,
    occurrenceKey: entry.occurrenceKey || '',
  };
}

function buildTransactionPayloadFromEntry(entry, statusOverride = entry.status) {
  return buildTransactionPayload({
    ...buildTransactionDraftFromEntry(entry, statusOverride),
    amount: entry.amount,
  });
}

function validateBatchTransactionRows(rows) {
  const meaningfulRows = getMeaningfulBatchTransactionRows(rows);
  if (!meaningfulRows.length) {
    throw new Error('Enter at least one transaction row before saving.');
  }

  for (const { row, index } of meaningfulRows) {
    const rowLabel = `Row ${index + 1}`;
    if (!String(row.title || '').trim()) {
      throw new Error(`${rowLabel}: enter a title.`);
    }
    if (row.amount === '' || row.amount === null || row.amount === undefined) {
      throw new Error(`${rowLabel}: enter an amount.`);
    }
    if (!row.accountId) {
      throw new Error(`${rowLabel}: choose an account.`);
    }
    if (row.direction === 'transfer' && !row.toAccountId) {
      throw new Error(`${rowLabel}: choose a destination account.`);
    }
    if (row.direction === 'transfer' && Number(row.accountId) === Number(row.toAccountId)) {
      throw new Error(`${rowLabel}: transfer source and destination must be different.`);
    }
  }

  return meaningfulRows.map(({ row }) => buildTransactionPayload(row));
}

function getDefaultRuleDraft(accounts = []) {
  const primary = accounts[0]?.id ?? '';
  const secondary = accounts[1]?.id ?? '';
  const today = getTodayKey();
  return {
    title: '',
    amount: '',
    direction: 'expense',
    accountId: primary,
    toAccountId: secondary,
    category: '',
    frequencyUnit: 'month',
    frequencyInterval: '1',
    startsOn: today,
    endsOn: '',
    maxOccurrences: '',
    weekday: String(new Date(`${today}T00:00:00Z`).getUTCDay()),
    monthDay: String(new Date(`${today}T00:00:00Z`).getUTCDate()),
    status: 'active',
    notes: '',
  };
}

function getDefaultReconciliationDraft(accounts = [], reconciliations = []) {
  const primary = accounts[0]?.id ?? '';
  const latestForAccount = reconciliations
    .filter((item) => item.accountId === primary)
    .sort((left, right) => right.statementEndingDate.localeCompare(left.statementEndingDate))[0];
  return {
    accountId: primary,
    statementEndingDate: getTodayKey(),
    openingBalance: latestForAccount ? String(latestForAccount.closingBalance) : '0.00',
    closingBalance: '',
    notes: '',
    transactionIds: [],
  };
}

function deriveCategoryOptions({ lookups, transactions, recurringRules, budgets }) {
  const categories = new Map();
  const addCategory = (value) => {
    const category = String(value || '').trim();
    if (!category) return;
    const key = category.toLowerCase();
    if (!categories.has(key)) {
      categories.set(key, category);
    }
  };

  (lookups.categorySuggestions || []).forEach(addCategory);
  transactions.forEach((transaction) => addCategory(transaction.category));
  recurringRules.forEach((rule) => addCategory(rule.category));
  budgets.forEach((budget) => addCategory(budget.category));

  return [...categories.values()].sort((left, right) => left.localeCompare(right));
}

function buildBudgetPlannerRows({ summaries }) {
  return summaries.map((summary) => ({
    rowId: `budget-${summary.direction}-${summary.category.trim().toLowerCase()}`,
    defaultBudgetId: summary.defaultBudgetId,
    monthBudgetId: summary.monthBudgetId,
    category: summary.category,
    direction: summary.direction,
    amount: summary.hasBudget ? formatCurrency(summary.amount) : '',
    mode: summary.mode,
    notes: summary.notes || '',
  }));
}

function getInitialFilters() {
  return {
    ...getDefaultDateRange(),
    statusFilter: 'all',
    accountFilter: 'all',
  };
}

function normalizeStatusFilterValue(label) {
  if (label === 'Projected') return 'projected';
  if (label === 'Actual') return 'actual';
  if (label === 'Cleared') return 'cleared';
  if (label === 'Actual + Cleared') return 'actual-cleared';
  return 'all';
}

function normalizeUsername(value) {
  return String(value || '').trim();
}

function parseCurrencyInput(value) {
  const normalized = String(value ?? '').replace(/[$,\s]/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCurrencyInput(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return formatCurrency(parseCurrencyInput(text));
}

function hasAnotherActiveAdmin(users, excludeId = null) {
  return users.some((user) => user.role === 'Admin' && !user.disabled && user.id !== excludeId);
}

function settingsDraftFromLookups(lookups) {
  return {
    cashWarningThreshold: String(lookups.cashWarningThreshold ?? 150),
    cashAccountTypes: (lookups.cashAccountTypes || []).join(', '),
    categorySuggestions: (lookups.categorySuggestions || []).join(', '),
  };
}

function splitSettingsList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusClassName(status) {
  if (status === 'cleared') return 'pill success';
  if (status === 'actual') return 'pill primary';
  if (status === 'projected') return 'pill muted';
  return 'pill';
}

function directionClassName(direction) {
  if (direction === 'opening') return 'pill primary';
  if (direction === 'income' || direction === 'opening') return 'pill income';
  if (direction === 'transfer') return 'pill warning';
  return 'pill danger';
}

function rangeTitle(filters) {
  const startMonth = filters.startDate.slice(0, 7);
  const endMonth = filters.endDate.slice(0, 7);
  if (startMonth === endMonth) {
    return formatMonthLabel(filters.startDate);
  }
  return `${formatDateLabel(filters.startDate)} to ${formatDateLabel(filters.endDate)}`;
}

function describeBudgetStatus(summary) {
  if (summary.status === 'over') return 'Projected to exceed this line.';
  if (summary.status === 'short') return 'Projected income is below this target.';
  if (summary.status === 'unbudgeted') return 'Activity exists, but no budget is set.';
  if (summary.status === 'met') return 'Goal already met in this month.';
  if (summary.mode === 'goal') return `${formatCurrency(summary.remaining)} still needed to reach the goal.`;
  return `${formatCurrency(summary.remaining)} projected variance against the budget.`;
}

function budgetStatusClassName(summary) {
  if (summary?.overBudget || summary?.incomeShort) return 'pill danger';
  if (summary?.unbudgeted) return 'pill warning';
  if (summary?.goalMet || summary?.status === 'on-track') return 'pill success';
  return 'pill muted';
}

function getLedgerSelectionId(entry) {
  if (entry.sourceType === 'manual') return `manual:${entry.id}`;
  if (entry.sourceType === 'generated') return `generated:${entry.recurringRuleId}:${entry.occurrenceKey}`;
  return `locked:${entry.id}`;
}

function isSelectableLedgerEntry(entry) {
  return entry.sourceType === 'manual' || entry.sourceType === 'generated';
}

function getLedgerSortValue(entry, sortKey) {
  if (sortKey === 'date') return entry.date;
  if (sortKey === 'title') return entry.title || '';
  if (sortKey === 'direction') return `${entry.direction || ''}|${entry.amount || 0}`;
  if (sortKey === 'account') return `${entry.account?.name || ''}|${entry.toAccount?.name || ''}`;
  if (sortKey === 'status') return entry.status || '';
  if (sortKey === 'amount') return Number(entry.amount || 0);
  if (sortKey === 'after') return Number(entry.accountBalanceAfter ?? Number.NEGATIVE_INFINITY);
  if (sortKey === 'total') return Number(entry.totalBalanceAfter ?? Number.NEGATIVE_INFINITY);
  return entry.date;
}

function compareLedgerSortValues(leftValue, rightValue) {
  if (typeof leftValue === 'number' && typeof rightValue === 'number') {
    return leftValue - rightValue;
  }
  return String(leftValue ?? '').localeCompare(String(rightValue ?? ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function getLedgerSequenceRank(entry) {
  if (entry.direction === 'opening' || entry.sourceType === 'opening') return 0;
  if (entry.sourceType === 'manual') return 1;
  if (entry.sourceType === 'generated') return 2;
  return 3;
}

function compareLedgerSequence(left, right) {
  const rankCompare = getLedgerSequenceRank(left) - getLedgerSequenceRank(right);
  if (rankCompare !== 0) return rankCompare;
  return String(left.id).localeCompare(String(right.id), undefined, { numeric: true });
}

function sortLedgerEntries(entries, sort) {
  const directionMultiplier = sort.direction === 'desc' ? -1 : 1;
  return [...entries].sort((left, right) => {
    const primary = compareLedgerSortValues(
      getLedgerSortValue(left, sort.key),
      getLedgerSortValue(right, sort.key),
    );
    if (primary !== 0) return primary * directionMultiplier;

    const dateCompare = left.date.localeCompare(right.date);
    if (dateCompare !== 0) return dateCompare;
    return compareLedgerSequence(left, right);
  });
}

function getTransactionSignedAmountForAccount(transaction, accountId) {
  if (transaction.direction === 'income') {
    return transaction.accountId === accountId ? transaction.amount : 0;
  }
  if (transaction.direction === 'expense') {
    return transaction.accountId === accountId ? -transaction.amount : 0;
  }
  if (transaction.direction === 'transfer') {
    if (transaction.accountId === accountId) return -transaction.amount;
    if (transaction.toAccountId === accountId) return transaction.amount;
  }
  return 0;
}

function FilterButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      className={`soft-button${active ? ' active' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SortHeaderButton({
  label,
  sortKey,
  activeSort,
  onSort,
}) {
  const isActive = activeSort.key === sortKey;
  return (
    <button
      type="button"
      className={`column-sort-button${isActive ? ' active' : ''}`}
      onClick={() => onSort(sortKey)}
    >
      <span>{label}</span>
      {isActive ? <span className="sort-marker">{activeSort.direction === 'asc' ? '^' : 'v'}</span> : null}
    </button>
  );
}

function SectionCard({ title, kicker, actions, children }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          {kicker ? <div className="kicker">{kicker}</div> : null}
          <h2>{title}</h2>
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function MetricCard({ label, value, meta, tone = 'cool', onClick }) {
  const Tag = onClick ? 'button' : 'article';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`metric-card ${tone}${onClick ? ' clickable' : ''}`} onClick={onClick}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {meta ? <div className="metric-meta">{meta}</div> : null}
    </Tag>
  );
}

function SplitMetricCard({ label, leftLabel, leftValue, rightLabel, rightValue, meta, tone = 'cool', onClick }) {
  const Tag = onClick ? 'button' : 'article';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`metric-card split-metric-card ${tone}${onClick ? ' clickable' : ''}`} onClick={onClick}>
      <div className="metric-label">{label}</div>
      <div className="split-metric-values">
        <div>
          <span>{leftLabel}</span>
          <strong>{leftValue}</strong>
        </div>
        <div>
          <span>{rightLabel}</span>
          <strong>{rightValue}</strong>
        </div>
      </div>
      {meta ? <div className="metric-meta">{meta}</div> : null}
    </Tag>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

function CategoryPicker({ value, onChange, options, placeholder = 'Select category' }) {
  const [customActive, setCustomActive] = useState(false);
  const matchedOption = options.find((option) => option.toLowerCase() === String(value || '').toLowerCase());

  useEffect(() => {
    if (value && !matchedOption) {
      setCustomActive(true);
    }
  }, [value, matchedOption]);

  return (
    <div className="category-picker">
      <select
        value={customActive ? '__custom' : matchedOption || ''}
        onChange={(event) => {
          if (event.target.value === '__custom') {
            setCustomActive(true);
            return;
          }
          setCustomActive(false);
          onChange(event.target.value);
        }}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
        <option value="__custom">Custom category...</option>
      </select>
      {customActive ? (
        <input
          value={value === '__custom' ? '' : value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Type category"
        />
      ) : null}
    </div>
  );
}

function LoginView({ busy, error, onSubmit }) {
  const [username, setUsername] = useState('Admin');
  const [password, setPassword] = useState('change-me-please');

  return (
    <main className="auth-shell">
      <section className="auth-panel">
         <img src="/faviconNB.png" alt="CashMap Logo" className="w-128 h-128 mx-auto" />
        {/* <div className="kicker">CashMap</div> */}
        {/* <h1>Forecast cash across accounts before the month happens.</h1> */}
        <p className="auth-copy">
          {/* Track each account balance, generate recurring expenses forward, and plan transfers before anything overdrafts. */}
        </p>
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({ username, password });
          }}
        >
          <Field label="Username">
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
          </Field>
          <Field label="Password">
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </Field>
          {error ? <div className="inline-error">{error}</div> : null}
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? 'Signing in…' : 'Open budget workspace'}
          </button>
        </form>
        {/* <div className="dev-note">
          Local default: <code>Admin</code> / <code>change-me-please</code>
        </div> */}
      </section>
    </main>
  );
}

void LoginView;

function AuthView({ busy, error, inviteInfo, onLogin, onSignup }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState('Prefer not to say');
  const [annualHouseholdIncome, setAnnualHouseholdIncome] = useState('');

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <img src="/faviconNB.png" alt="CashMap Logo" className="w-128 h-128 mx-auto" />
        <div className="entry-mode-toggle auth-toggle">
          <button
            type="button"
            className={`soft-button${mode === 'login' ? ' active' : ''}`}
            onClick={() => setMode('login')}
          >
            Log in
          </button>
          <button
            type="button"
            className={`soft-button${mode === 'signup' ? ' active' : ''}`}
            onClick={() => setMode('signup')}
          >
            Sign up
          </button>
        </div>
        <h1>{inviteInfo ? `Join ${inviteInfo.householdName}` : mode === 'signup' ? 'Create your CashMap account' : 'Open your CashMap workspace'}</h1>
        <p className="auth-copy">
          {inviteInfo
            ? `This invite grants ${inviteInfo.role.toLowerCase()} access and expires ${formatDateLabel(inviteInfo.expiresAt.slice(0, 10))}.`
            : 'Track each account balance, generate recurring expenses forward, and plan transfers before anything overdrafts.'}
        </p>
        <form
          className="auth-form"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (mode === 'signup') {
              onSignup({
                username,
                password,
                confirmPassword,
                firstName,
                lastName,
                phone,
                gender,
                annualHouseholdIncome,
              });
              return;
            }
            onLogin({ username, password });
          }}
        >
          <input
            type="text"
            name="cashmap-shadow-username"
            autoComplete="username"
            tabIndex={-1}
            aria-hidden="true"
            className="hidden-autofill-field"
          />
          <input
            type="password"
            name="cashmap-shadow-password"
            autoComplete="current-password"
            tabIndex={-1}
            aria-hidden="true"
            className="hidden-autofill-field"
          />
          <Field label="Username">
            <input
              name={mode === 'signup' ? 'signup-username' : 'login-username'}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete={mode === 'signup' ? 'username' : 'off'}
              required
            />
          </Field>
          <Field label="Password">
            <input
              name={mode === 'signup' ? 'signup-password' : 'login-password'}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'signup' ? 'new-password' : 'off'}
              required
            />
          </Field>
          {mode === 'signup' ? (
            <>
              <Field label="First name">
                <input
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  autoComplete="given-name"
                  required
                />
              </Field>
              <Field label="Last name">
                <input
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  autoComplete="family-name"
                  required
                />
              </Field>
              <Field label="Phone number">
                <input value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" />
              </Field>
              <Field label="Gender">
                <select value={gender} onChange={(event) => setGender(event.target.value)} required>
                  {GENDER_OPTIONS.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </Field>
              <Field label="Annual household income">
                <select
                  value={annualHouseholdIncome}
                  onChange={(event) => setAnnualHouseholdIncome(event.target.value)}
                  required
                >
                  <option value="">Select income range</option>
                  {INCOME_BRACKETS.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </Field>
              <Field label="Confirm password" hint={`Minimum ${PASSWORD_MIN_LENGTH} characters.`}>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </Field>
            </>
          ) : null}
          {error ? <div className="inline-error">{error}</div> : null}
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? 'Working…' : mode === 'signup' ? 'Create account' : 'Open budget workspace'}
          </button>
        </form>
      </section>
    </main>
  );
}

export default function App() {
  const [session, setSession] = useState({ status: 'loading', user: null });
  const [data, setData] = useState({
    lookups: DEFAULT_LOOKUPS,
    households: [],
    activeHousehold: null,
    accounts: [],
    transactions: [],
    recurringRules: [],
    recurringOverrides: [],
    budgets: [],
    reconciliations: [],
    loanPayments: [],
    loanDraws: [],
  });
  const [inviteToken, setInviteToken] = useState(getInviteTokenFromUrl);
  const [inviteInfo, setInviteInfo] = useState(null);
  const [filters, setFilters] = useState(getInitialFilters);
  const [activeView, setActiveView] = useState('overview');
  const [accountDraft, setAccountDraft] = useState(getDefaultAccountDraft(DEFAULT_LOOKUPS));
  const [editingAccountId, setEditingAccountId] = useState(null);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [transactionEntryMode, setTransactionEntryMode] = useState('single');
  const [transactionDraft, setTransactionDraft] = useState(getDefaultTransactionDraft());
  const [batchTransactionRows, setBatchTransactionRows] = useState(() => getDefaultBatchTransactionRows());
  const [transactionImportFile, setTransactionImportFile] = useState(null);
  const [transactionImportInputKey, setTransactionImportInputKey] = useState(0);
  const [editingTransactionId, setEditingTransactionId] = useState(null);
  const [ledgerSort, setLedgerSort] = useState({ key: 'date', direction: 'asc' });
  const [selectedLedgerEntryIds, setSelectedLedgerEntryIds] = useState([]);
  const [bulkLedgerStatus, setBulkLedgerStatus] = useState('cleared');
  const [ruleDraft, setRuleDraft] = useState(getDefaultRuleDraft());
  const [editingRuleId, setEditingRuleId] = useState(null);
  const [overrideDraft, setOverrideDraft] = useState(null);
  const [recurringModalRuleId, setRecurringModalRuleId] = useState(null);
  const [recurringOverrideRows, setRecurringOverrideRows] = useState([]);
  const [loanTab, setLoanTab] = useState('manager');
  const [debtPayoffRows, setDebtPayoffRows] = useState([]);
  const [debtPayoffLoading, setDebtPayoffLoading] = useState(false);
  const [debtPayoffExtras, setDebtPayoffExtras] = useState({
    monthly: '0',
    yearly: '0',
    oneTimeAmount: '0',
    oneTimeMonth: '1',
  });
  const [debtPayoffFixedTotal, setDebtPayoffFixedTotal] = useState(true);
  const [debtPayoffMethod, setDebtPayoffMethod] = useState('avalanche');
  const [budgetMonth, setBudgetMonth] = useState(getMonthKey(getTodayKey()));
  const [budgetPlannerRows, setBudgetPlannerRows] = useState([]);
  const [budgetPlannerCategory, setBudgetPlannerCategory] = useState('');
  const [budgetPlannerDirection, setBudgetPlannerDirection] = useState('expense');
  const [budgetSaveScope, setBudgetSaveScope] = useState('default');
  const [showBudgetWarnings, setShowBudgetWarnings] = useState(false);
  const [showOverviewWarnings, setShowOverviewWarnings] = useState(false);
  const [reconciliationDraft, setReconciliationDraft] = useState(getDefaultReconciliationDraft());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('profile');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState({ type: '', message: '' });
  const [profileDraft, setProfileDraft] = useState(getDefaultProfileDraft());
  const [adminSettingsDraft, setAdminSettingsDraft] = useState(settingsDraftFromLookups(DEFAULT_LOOKUPS));
  const [settingsUsers, setSettingsUsers] = useState([]);
  const [householdDraft, setHouseholdDraft] = useState({ name: 'My Household' });
  const [householdRenameDraft, setHouseholdRenameDraft] = useState('');
  const [householdMembers, setHouseholdMembers] = useState([]);
  const [householdInvites, setHouseholdInvites] = useState([]);
  const [householdInviteRole, setHouseholdInviteRole] = useState('Member');
  const [latestInviteLink, setLatestInviteLink] = useState('');
  const [householdAssignmentDraft, setHouseholdAssignmentDraft] = useState({ userId: '', role: 'Member' });
  const [adminHouseholds, setAdminHouseholds] = useState([]);
  const [adminHouseholdSearch, setAdminHouseholdSearch] = useState('');
  const [adminHouseholdSort, setAdminHouseholdSort] = useState({ key: 'lastActivityAt', direction: 'desc' });
  const [adminSelectedHouseholdId, setAdminSelectedHouseholdId] = useState(null);
  const [archiveConfirm, setArchiveConfirm] = useState({ open: false, checked: false, householdId: null, householdName: '' });
  const [userDraft, setUserDraft] = useState({ username: '', role: 'Standard User', password: '', confirmPassword: '' });
  const [editingUserId, setEditingUserId] = useState(null);
  const [resetPasswordDraft, setResetPasswordDraft] = useState({ userId: null, password: '', confirmPassword: '' });
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState({ type: '', message: '' });

  useEffect(() => {
    loadWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lookups = data.lookups || DEFAULT_LOOKUPS;
  const isAdmin = session.user?.role === 'Admin';
  const activeHousehold = data.activeHousehold || null;
  const settingsHouseholdId = settingsTab === 'admin-households' ? adminSelectedHouseholdId : activeHousehold?.id;
  const canManageActiveHousehold = Boolean(activeHousehold?.canManage);
  const hasActiveHousehold = Boolean(activeHousehold?.id);
  const filteredAdminHouseholds = useMemo(() => {
    const query = adminHouseholdSearch.trim().toLowerCase();
    const filtered = query
      ? adminHouseholds.filter((household) => (
        [
          household.name,
          household.ownerUsername,
          household.ownerFirstName,
          household.ownerLastName,
          household.status,
        ].some((value) => String(value || '').toLowerCase().includes(query))
      ))
      : adminHouseholds;
    return [...filtered].sort((left, right) => {
      const leftValue = left[adminHouseholdSort.key] ?? '';
      const rightValue = right[adminHouseholdSort.key] ?? '';
      if (leftValue < rightValue) return adminHouseholdSort.direction === 'asc' ? -1 : 1;
      if (leftValue > rightValue) return adminHouseholdSort.direction === 'asc' ? 1 : -1;
      return left.id - right.id;
    });
  }, [adminHouseholds, adminHouseholdSearch, adminHouseholdSort]);
  const adminSelectedHousehold = useMemo(
    () => adminHouseholds.find((household) => household.id === adminSelectedHouseholdId) || null,
    [adminHouseholds, adminSelectedHouseholdId],
  );
  const activeAdminCount = settingsUsers.filter((user) => user.role === 'Admin' && !user.disabled).length;
  const cashAccounts = useMemo(
    () => data.accounts.filter((account) => (account.trackingType || 'cash') !== 'loan'),
    [data.accounts],
  );
  const activeCashAccounts = useMemo(
    () => cashAccounts.filter((account) => account.isActive),
    [cashAccounts],
  );
  const cashAccountIdsKey = cashAccounts.map((account) => account.id).join(',');
  const activeAccountIdsKey = activeCashAccounts.map((account) => account.id).join(',');
  const defaultActiveAccountId = activeCashAccounts[0]?.id ?? '';
  const defaultSecondaryAccountId = activeCashAccounts[1]?.id ?? '';
  const accountMap = Object.fromEntries(data.accounts.map((account) => [account.id, account]));
  const categoryOptions = useMemo(() => deriveCategoryOptions({
    lookups,
    transactions: data.transactions,
    recurringRules: data.recurringRules,
    budgets: data.budgets,
  }), [lookups, data.transactions, data.recurringRules, data.budgets]);
  const selectedAccount = cashAccounts.find((account) => account.id === selectedAccountId) || cashAccounts[0] || null;
  const recurringModalRule = data.recurringRules.find((rule) => rule.id === recurringModalRuleId) || null;
  const filledBatchRowCount = getMeaningfulBatchTransactionRows(batchTransactionRows).length;
  const selectedAccountFilter = filters.accountFilter === 'all' ? 'all' : Number(filters.accountFilter);
  const projection = buildProjection({
    accounts: data.accounts,
    transactions: data.transactions,
    recurringRules: data.recurringRules,
    recurringOverrides: data.recurringOverrides,
    startDate: filters.startDate,
    endDate: filters.endDate,
    statusFilter: filters.statusFilter,
    accountFilter: selectedAccountFilter,
    warningThreshold: lookups.cashWarningThreshold,
  });
  const sortedVisibleEntries = useMemo(
    () => sortLedgerEntries(projection.visibleEntries, ledgerSort),
    [projection.visibleEntries, ledgerSort],
  );
  const selectableLedgerEntries = sortedVisibleEntries.filter(isSelectableLedgerEntry);
  const selectedLedgerEntries = sortedVisibleEntries.filter((entry) => (
    selectedLedgerEntryIds.includes(getLedgerSelectionId(entry))
  ));
  const allVisibleLedgerSelected = selectableLedgerEntries.length > 0
    && selectableLedgerEntries.every((entry) => selectedLedgerEntryIds.includes(getLedgerSelectionId(entry)));
  const visibleLedgerSelectionKey = selectableLedgerEntries.map(getLedgerSelectionId).join('|');
  const isEditingGeneratedOccurrence = Boolean(
    !editingTransactionId && transactionDraft.recurringRuleId && transactionDraft.occurrenceKey,
  );
  const isEditingTransactionDraft = Boolean(editingTransactionId || isEditingGeneratedOccurrence);
  const budgetRange = useMemo(() => getMonthBounds(budgetMonth), [budgetMonth]);
  const budgetProjection = useMemo(() => buildProjection({
    accounts: data.accounts,
    transactions: data.transactions,
    recurringRules: data.recurringRules,
    recurringOverrides: data.recurringOverrides,
    startDate: budgetRange.startDate,
    endDate: budgetRange.endDate,
    statusFilter: 'all',
    accountFilter: 'all',
    warningThreshold: lookups.cashWarningThreshold,
  }), [
    data.accounts,
    data.transactions,
    data.recurringRules,
    data.recurringOverrides,
    budgetRange.startDate,
    budgetRange.endDate,
    lookups.cashWarningThreshold,
  ]);
  const budgetInsights = useMemo(() => buildBudgetInsights({
    budgets: data.budgets,
    entries: budgetProjection.allEntries,
    monthKey: budgetMonth,
  }), [data.budgets, budgetProjection.allEntries, budgetMonth]);
  const reconciliationCandidates = data.transactions
    .filter((transaction) => {
      const accountId = Number(reconciliationDraft.accountId);
      if (!accountId) return false;
      const touchesAccount = transaction.accountId === accountId || transaction.toAccountId === accountId;
      if (!touchesAccount) return false;
      if (transaction.status === 'projected') return false;
      if (transaction.reconciliationId && !reconciliationDraft.transactionIds.includes(transaction.id)) return false;
      return !reconciliationDraft.statementEndingDate || transaction.date <= reconciliationDraft.statementEndingDate;
    })
    .sort((left, right) => left.date.localeCompare(right.date) || left.id - right.id);
  const selectedReconciliationTransactions = reconciliationCandidates.filter((transaction) => (
    reconciliationDraft.transactionIds.includes(transaction.id)
  ));
  const reconciliationClearedDelta = selectedReconciliationTransactions.reduce((sum, transaction) => (
    sum + getTransactionSignedAmountForAccount(transaction, Number(reconciliationDraft.accountId))
  ), 0);
  const reconciliationDifference = Number(reconciliationDraft.openingBalance || 0)
    + reconciliationClearedDelta
    - Number(reconciliationDraft.closingBalance || 0);

  useEffect(() => {
    if (!activeCashAccounts.length) return;
    setTransactionDraft((current) => (
      current.accountId ? current : { ...current, accountId: defaultActiveAccountId, toAccountId: defaultSecondaryAccountId }
    ));
    setBatchTransactionRows((current) => {
      let changed = false;
      const nextRows = current.map((row) => {
        if (row.accountId) return row;
        changed = true;
        return { ...row, accountId: defaultActiveAccountId, toAccountId: defaultSecondaryAccountId };
      });
      return changed ? nextRows : current;
    });
    setRuleDraft((current) => (
      current.accountId ? current : { ...current, accountId: defaultActiveAccountId, toAccountId: defaultSecondaryAccountId }
    ));
    setReconciliationDraft((current) => {
      if (current.accountId) return current;
      return { ...current, accountId: defaultActiveAccountId };
    });
  }, [activeAccountIdsKey, activeCashAccounts.length, defaultActiveAccountId, defaultSecondaryAccountId]);

  useEffect(() => {
    if (!cashAccounts.length) {
      setSelectedAccountId(null);
      return;
    }
    if (!selectedAccountId || !cashAccounts.some((account) => account.id === selectedAccountId)) {
      setSelectedAccountId(cashAccounts[0].id);
    }
  }, [cashAccounts, cashAccountIdsKey, selectedAccountId]);

  useEffect(() => {
    setBudgetPlannerRows(buildBudgetPlannerRows({
      summaries: budgetInsights.summaries,
    }));
  }, [budgetMonth, budgetInsights.summaries]);

  useEffect(() => {
    const visibleIds = new Set(visibleLedgerSelectionKey ? visibleLedgerSelectionKey.split('|') : []);
    setSelectedLedgerEntryIds((current) => {
      const next = current.filter((id) => visibleIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [visibleLedgerSelectionKey]);

  useEffect(() => {
    if (!inviteToken) {
      setInviteInfo(null);
      return;
    }
    let cancelled = false;
    budgetApi.getInvite(inviteToken)
      .then((response) => {
        if (cancelled) return;
        setInviteInfo(response.invite || null);
      })
      .catch((error) => {
        if (cancelled) return;
        setInviteInfo(null);
        setBanner({ type: 'error', message: error.message || 'Invite link could not be loaded.' });
      });
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  function applyBootstrapPayload(payload) {
    startTransition(() => {
      setSession({ status: 'authenticated', user: payload.user });
      setData({
        lookups: payload.lookups,
        households: payload.households || [],
        activeHousehold: payload.activeHousehold || null,
        accounts: payload.accounts,
        transactions: payload.transactions,
        recurringRules: payload.recurringRules,
        recurringOverrides: payload.recurringOverrides,
        budgets: payload.budgets,
        reconciliations: payload.reconciliations,
        loanPayments: payload.loanPayments || [],
        loanDraws: payload.loanDraws || [],
      });
      setProfileDraft((current) => ({
        ...getDefaultProfileDraft(payload.user),
        currentPassword: current.currentPassword || '',
        newPassword: current.newPassword || '',
        confirmPassword: current.confirmPassword || '',
      }));
      setHouseholdRenameDraft(payload.activeHousehold?.name || '');
      setAccountDraft(getDefaultAccountDraft(payload.lookups));
      const payloadCashAccounts = payload.accounts.filter((account) => (account.trackingType || 'cash') !== 'loan' && account.isActive);
      setTransactionDraft(getDefaultTransactionDraft(payloadCashAccounts));
      setBatchTransactionRows(getDefaultBatchTransactionRows(payloadCashAccounts));
      setRuleDraft(getDefaultRuleDraft(payloadCashAccounts));
      setReconciliationDraft(getDefaultReconciliationDraft(payloadCashAccounts, payload.reconciliations));
      setSelectedAccountId((current) => current ?? payloadCashAccounts[0]?.id ?? null);
      setBanner({ type: '', message: '' });
    });
  }

  async function refreshActiveHouseholdMembers(householdId = data.activeHousehold?.id) {
    if (!householdId) {
      setHouseholdMembers([]);
      setHouseholdInvites([]);
      setLatestInviteLink('');
      return;
    }
    const response = await budgetApi.listHouseholdMembers(householdId);
    setHouseholdMembers(response.members || []);
    setHouseholdInvites(response.invites || []);
    setHouseholdRenameDraft(response.household?.name || data.activeHousehold?.name || '');
  }

  function getTargetHouseholdId() {
    return settingsHouseholdId || null;
  }

  async function loadWorkspace() {
    setBusy(true);
    try {
      const payload = await budgetApi.bootstrap();
      applyBootstrapPayload(payload);
    } catch (error) {
      if (error.status === 401) {
        setSession({ status: 'anonymous', user: null });
        setData({
          lookups: DEFAULT_LOOKUPS,
          households: [],
          activeHousehold: null,
          accounts: [],
          transactions: [],
          recurringRules: [],
          recurringOverrides: [],
          budgets: [],
          reconciliations: [],
          loanPayments: [],
          loanDraws: [],
        });
        setBanner({ type: '', message: '' });
      } else {
        setBanner({ type: 'error', message: error.message });
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleLogin(credentials) {
    setBusy(true);
    try {
      await budgetApi.login(credentials);
      await loadWorkspace();
      if (inviteToken && inviteInfo) {
        setBanner({ type: 'success', message: `Invite ready for ${inviteInfo.householdName}. Use Join Household to connect this account.` });
      }
    } catch (error) {
      setBanner({ type: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleSignup(credentials) {
    if (
      !credentials.username
      || !credentials.password
      || !credentials.confirmPassword
      || !credentials.firstName
      || !credentials.lastName
      || !credentials.gender
      || !credentials.annualHouseholdIncome
    ) {
      setBanner({ type: 'error', message: 'Username, name, income range, and password fields are required.' });
      return;
    }
    if (credentials.password !== credentials.confirmPassword) {
      setBanner({ type: 'error', message: 'Passwords do not match.' });
      return;
    }
    if (credentials.password.length < PASSWORD_MIN_LENGTH) {
      setBanner({ type: 'error', message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
      return;
    }
    setBusy(true);
    try {
      await budgetApi.signup({
        username: credentials.username,
        password: credentials.password,
        firstName: credentials.firstName,
        lastName: credentials.lastName,
        phone: credentials.phone,
        gender: credentials.gender,
        annualHouseholdIncome: credentials.annualHouseholdIncome,
        inviteToken: inviteToken || undefined,
      });
      if (inviteToken) {
        clearInviteTokenFromUrl();
        setInviteToken('');
        setInviteInfo(null);
      }
      await loadWorkspace();
    } catch (error) {
      setBanner({ type: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!settingsOpen || settingsTab !== 'households') return;
    refreshActiveHouseholdMembers().catch((error) => {
      setSettingsNotice('error', error.message || 'Could not load household details.');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen, settingsTab, data.activeHousehold?.id]);

  useEffect(() => {
    if (!settingsOpen || settingsTab !== 'admin-households' || !isAdmin) return;
    refreshAdminHouseholds().catch((error) => {
      setSettingsNotice('error', error.message || 'Could not load admin household data.');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen, settingsTab, isAdmin]);

  useEffect(() => {
    if (!hasActiveHousehold && activeView !== 'overview') {
      setActiveView('overview');
    }
  }, [activeView, hasActiveHousehold]);

  useEffect(() => {
    if (!hasActiveHousehold || activeView !== 'loans' || loanTab !== 'payoff') return;
    refreshDebtPayoffLoanRows().catch((error) => {
      setBanner({ type: 'error', message: error.message || 'Could not refresh loan payoff rows.' });
    });
  }, [activeView, loanTab, hasActiveHousehold]);

  async function handleLogout() {
    setBusy(true);
    try {
      await budgetApi.logout();
      setSession({ status: 'anonymous', user: null });
      setData({
        lookups: DEFAULT_LOOKUPS,
        households: [],
        activeHousehold: null,
        accounts: [],
        transactions: [],
        recurringRules: [],
        recurringOverrides: [],
        budgets: [],
        reconciliations: [],
        loanPayments: [],
        loanDraws: [],
      });
      setSettingsOpen(false);
      setSettingsUsers([]);
      setHouseholdMembers([]);
      setHouseholdInvites([]);
    } catch (error) {
      setBanner({ type: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  function setSuccess(message) {
    setBanner({ type: 'success', message });
  }

  function setFailure(error) {
    setBanner({ type: 'error', message: error.message || String(error) });
  }

  function setSettingsNotice(type, message) {
    setSettingsMessage({ type, message });
  }

  function resetProfileDraft() {
    setProfileDraft(getDefaultProfileDraft(session.user));
  }

  function resetUserDraft() {
    setEditingUserId(null);
    setUserDraft({ username: '', role: 'Standard User', password: '', confirmPassword: '' });
    setResetPasswordDraft({ userId: null, password: '', confirmPassword: '' });
  }

  async function refreshSettingsUsers() {
    if (!isAdmin) return;
    const response = await budgetApi.listUsers();
    setSettingsUsers(response.users || []);
  }

  async function refreshAdminHouseholds(selectedId = adminSelectedHouseholdId) {
    if (!isAdmin) return;
    const response = await budgetApi.listAdminHouseholds();
    const households = response.households || [];
    setAdminHouseholds(households);
    const nextId = selectedId && households.some((item) => item.id === selectedId)
      ? selectedId
      : households[0]?.id || null;
    setAdminSelectedHouseholdId(nextId);
    if (nextId) {
      await refreshActiveHouseholdMembers(nextId);
    } else {
      setHouseholdMembers([]);
      setHouseholdInvites([]);
    }
  }

  async function openSettings(tab = 'profile') {
    const activeTab = ['households', 'admin-households'].includes(tab) ? tab : isAdmin ? tab : 'profile';
    setSettingsOpen(true);
    setSettingsTab(activeTab);
    setSettingsMessage({ type: '', message: '' });
    setAdminSettingsDraft(settingsDraftFromLookups(lookups));
    setHouseholdDraft({ name: 'My Household' });
    setHouseholdAssignmentDraft({ userId: '', role: 'Member' });
    setHouseholdInviteRole('Member');
    setLatestInviteLink('');
    resetProfileDraft();
    resetUserDraft();

    setSettingsBusy(true);
    try {
      if (activeTab === 'households') {
        await refreshActiveHouseholdMembers();
      }
      if (isAdmin) {
        const [settingsResponse, usersResponse] = await Promise.all([
          budgetApi.getSettings(),
          budgetApi.listUsers(),
        ]);
        setAdminSettingsDraft(settingsDraftFromLookups({
          ...lookups,
          ...(settingsResponse.settings || {}),
        }));
        setSettingsUsers(usersResponse.users || []);
        if (activeTab === 'admin-households') {
          await refreshAdminHouseholds();
        }
      }
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not load settings.');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function switchActiveHousehold(householdId) {
    setBusy(true);
    try {
      const payload = await budgetApi.switchHousehold(householdId);
      applyBootstrapPayload(payload);
      setSuccess('Household switched.');
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function acceptPendingInvite() {
    if (!inviteToken || !inviteInfo) return;
    setBusy(true);
    try {
      const payload = await budgetApi.acceptInvite(inviteToken);
      applyBootstrapPayload(payload);
      clearInviteTokenFromUrl();
      setInviteToken('');
      setInviteInfo(null);
      setBanner({ type: 'success', message: `Joined ${inviteInfo.householdName}.` });
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function createHouseholdFromSettings(event) {
    event.preventDefault();
    setSettingsBusy(true);
    setSettingsMessage({ type: '', message: '' });
    try {
      await budgetApi.createHousehold({ name: householdDraft.name || 'My Household' });
      setHouseholdDraft({ name: 'My Household' });
      await loadWorkspace();
      if (settingsOpen) {
        setSettingsTab('households');
      }
      setSettingsNotice('success', 'Household created.');
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not create household.');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function renameActiveHousehold(event) {
    event.preventDefault();
    const householdId = getTargetHouseholdId();
    if (!householdId) return;
    setSettingsBusy(true);
    setSettingsMessage({ type: '', message: '' });
    try {
      await budgetApi.renameHousehold(householdId, { name: householdRenameDraft });
      await loadWorkspace();
      await refreshActiveHouseholdMembers(householdId);
      if (settingsTab === 'admin-households' && isAdmin) {
        await refreshAdminHouseholds(householdId);
      }
      setSettingsNotice('success', 'Household updated.');
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not update household.');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function createInviteLink(event) {
    event.preventDefault();
    const householdId = getTargetHouseholdId();
    if (!householdId) return;
    setSettingsBusy(true);
    setSettingsMessage({ type: '', message: '' });
    try {
      const response = await budgetApi.createHouseholdInvite(householdId, { role: householdInviteRole });
      setLatestInviteLink(response.invite?.inviteUrl || '');
      await refreshActiveHouseholdMembers(householdId);
      setSettingsNotice('success', 'Invite link created.');
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not create invite.');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function saveProfileDetails(event) {
    event.preventDefault();
    setSettingsBusy(true);
    setSettingsMessage({ type: '', message: '' });
    try {
      const response = await budgetApi.updateOwnProfile({
        firstName: profileDraft.firstName,
        lastName: profileDraft.lastName,
        phone: profileDraft.phone,
        gender: profileDraft.gender,
        annualHouseholdIncome: profileDraft.annualHouseholdIncome,
      });
      setSession((current) => ({ ...current, user: response.user }));
      setProfileDraft((current) => ({
        ...getDefaultProfileDraft(response.user),
        currentPassword: current.currentPassword,
        newPassword: current.newPassword,
        confirmPassword: current.confirmPassword,
      }));
      setSettingsNotice('success', 'Profile updated.');
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not update profile.');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function updateMemberRole(memberId, role) {
    const householdId = getTargetHouseholdId();
    setSettingsBusy(true);
    setSettingsMessage({ type: '', message: '' });
    try {
      await budgetApi.updateHouseholdMember(memberId, { role });
      await refreshActiveHouseholdMembers(householdId);
      await loadWorkspace();
      if (settingsTab === 'admin-households' && isAdmin) {
        await refreshAdminHouseholds(householdId);
      }
      setSettingsNotice('success', 'Member role updated.');
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not update member role.');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function leaveHousehold(household) {
    if (!household?.id) return;
    if (!window.confirm(`Leave ${household.name}?`)) return;
    setSettingsBusy(true);
    setSettingsMessage({ type: '', message: '' });
    try {
      await budgetApi.leaveHousehold(household.id);
      await loadWorkspace();
      if (settingsTab === 'admin-households' && isAdmin) {
        await refreshAdminHouseholds(household.id);
      } else {
        await refreshActiveHouseholdMembers();
      }
      setSettingsNotice('success', `You left ${household.name}.`);
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not leave household.');
    } finally {
      setSettingsBusy(false);
    }
  }

  function openArchiveHouseholdConfirm(household) {
    setArchiveConfirm({
      open: true,
      checked: false,
      householdId: household.id,
      householdName: household.name,
    });
  }

  async function confirmArchiveHousehold() {
    if (!archiveConfirm.householdId) return;
    setSettingsBusy(true);
    setSettingsMessage({ type: '', message: '' });
    try {
      await budgetApi.archiveHousehold(archiveConfirm.householdId, {
        confirmArchive: true,
        acknowledgePermanentDelete: archiveConfirm.checked,
      });
      setArchiveConfirm({ open: false, checked: false, householdId: null, householdName: '' });
      await loadWorkspace();
      if (settingsTab === 'admin-households' && isAdmin) {
        await refreshAdminHouseholds();
      } else {
        await refreshActiveHouseholdMembers();
      }
      setSettingsNotice('success', 'Household archived. It can be restored by an admin for 30 days.');
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not archive household.');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function restoreArchivedHousehold(householdId) {
    setSettingsBusy(true);
    setSettingsMessage({ type: '', message: '' });
    try {
      await budgetApi.restoreAdminHousehold(householdId);
      await refreshAdminHouseholds(householdId);
      setSettingsNotice('success', 'Household restored.');
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not restore household.');
    } finally {
      setSettingsBusy(false);
    }
  }

  function setAdminHouseholdSortKey(sortKey) {
    setAdminHouseholdSort((current) => (
      current.key === sortKey
        ? { key: sortKey, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key: sortKey, direction: sortKey === 'name' ? 'asc' : 'desc' }
    ));
  }

  async function addCurrentAdminToHousehold(householdId) {
    setSettingsBusy(true);
    setSettingsMessage({ type: '', message: '' });
    try {
      await budgetApi.addHouseholdMember(householdId, { userId: session.user.id, role: 'Member' });
      await refreshAdminHouseholds(householdId);
      await loadWorkspace();
      setSettingsNotice('success', 'You were added to the household.');
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not add you to the household.');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function removeCurrentAdminFromHousehold(household) {
    if (!household?.currentUserMembershipId) return;
    if (!window.confirm(`Remove yourself from ${household.name}?`)) return;
    setSettingsBusy(true);
    setSettingsMessage({ type: '', message: '' });
    try {
      await budgetApi.removeHouseholdMember(household.currentUserMembershipId);
      await refreshAdminHouseholds(household.id);
      await loadWorkspace();
      setSettingsNotice('success', 'You were removed from the household.');
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not remove you from the household.');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function removeMember(member) {
    const householdId = getTargetHouseholdId();
    if (!window.confirm(`Remove ${member.username} from this household?`)) return;
    setSettingsBusy(true);
    setSettingsMessage({ type: '', message: '' });
    try {
      await budgetApi.removeHouseholdMember(member.id);
      await refreshActiveHouseholdMembers(householdId);
      await loadWorkspace();
      if (settingsTab === 'admin-households' && isAdmin) {
        await refreshAdminHouseholds(householdId);
      }
      setSettingsNotice('success', 'Member removed.');
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not remove member.');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function addExistingUserToHousehold(event) {
    event.preventDefault();
    const householdId = getTargetHouseholdId();
    if (!householdId) return;
    setSettingsBusy(true);
    setSettingsMessage({ type: '', message: '' });
    try {
      await budgetApi.addHouseholdMember(householdId, {
        userId: Number(householdAssignmentDraft.userId),
        role: householdAssignmentDraft.role,
      });
      setHouseholdAssignmentDraft({ userId: '', role: 'Member' });
      await refreshActiveHouseholdMembers(householdId);
      if (settingsTab === 'admin-households' && isAdmin) {
        await refreshAdminHouseholds(householdId);
      }
      setSettingsNotice('success', 'User assigned to household.');
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not assign user.');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function changeOwnPassword(event) {
    event.preventDefault();
    setSettingsMessage({ type: '', message: '' });
    const { currentPassword, newPassword, confirmPassword } = profileDraft;
    if (!currentPassword || !newPassword || !confirmPassword) {
      setSettingsNotice('error', 'All password fields are required.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setSettingsNotice('error', 'New passwords do not match.');
      return;
    }
    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      setSettingsNotice('error', `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }

    setSettingsBusy(true);
    try {
      await budgetApi.updateOwnPassword({ currentPassword, newPassword });
      resetProfileDraft();
      setSettingsNotice('success', 'Password updated.');
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not update password.');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function saveAdminSettings(event) {
    event.preventDefault();
    if (!isAdmin) return;
    setSettingsBusy(true);
    try {
      const payload = {
        cashWarningThreshold: Number(adminSettingsDraft.cashWarningThreshold || 0),
        cashAccountTypes: splitSettingsList(adminSettingsDraft.cashAccountTypes),
        categorySuggestions: splitSettingsList(adminSettingsDraft.categorySuggestions),
      };
      const response = await budgetApi.updateSettings(payload);
      setAdminSettingsDraft(settingsDraftFromLookups({
        ...lookups,
        ...(response.settings || {}),
      }));
      setSettingsNotice('success', 'Default settings saved.');
      await loadWorkspace();
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not save settings.');
    } finally {
      setSettingsBusy(false);
    }
  }

  function editSettingsUser(user) {
    setEditingUserId(user.id);
    setUserDraft({
      username: user.username,
      role: user.role,
      password: '',
      confirmPassword: '',
    });
    setResetPasswordDraft({ userId: null, password: '', confirmPassword: '' });
    setSettingsMessage({ type: '', message: '' });
  }

  async function saveSettingsUser(event) {
    event.preventDefault();
    if (!isAdmin) return;
    const username = normalizeUsername(userDraft.username);
    const role = USER_ROLES.includes(userDraft.role) ? userDraft.role : 'Standard User';
    setSettingsMessage({ type: '', message: '' });

    if (!username) {
      setSettingsNotice('error', 'Username is required.');
      return;
    }

    setSettingsBusy(true);
    try {
      if (editingUserId) {
        const existing = settingsUsers.find((user) => user.id === editingUserId);
        if (existing?.role === 'Admin' && role !== 'Admin' && !hasAnotherActiveAdmin(settingsUsers, existing.id)) {
          throw new Error('At least one admin must remain.');
        }
        const response = await budgetApi.updateUser(editingUserId, { username, role });
        if (response.user?.id === session.user?.id) {
          setSession({ status: 'authenticated', user: response.user });
        }
        setSettingsNotice('success', 'User updated.');
      } else {
        if (!userDraft.password || !userDraft.confirmPassword) {
          throw new Error('Password and confirmation are required.');
        }
        if (userDraft.password !== userDraft.confirmPassword) {
          throw new Error('Passwords do not match.');
        }
        if (userDraft.password.length < PASSWORD_MIN_LENGTH) {
          throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
        }
        await budgetApi.createUser({ username, role, password: userDraft.password });
        setSettingsNotice('success', 'User created.');
      }
      resetUserDraft();
      await refreshSettingsUsers();
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not save user.');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function toggleSettingsUserDisabled(user) {
    if (!isAdmin) return;
    const disabled = !user.disabled;
    if (disabled && user.role === 'Admin' && !hasAnotherActiveAdmin(settingsUsers, user.id)) {
      setSettingsNotice('error', 'Keep at least one admin active.');
      return;
    }
    setSettingsBusy(true);
    try {
      await budgetApi.updateUser(user.id, { disabled });
      await refreshSettingsUsers();
      setSettingsNotice('success', disabled ? 'User disabled.' : 'User enabled.');
      if (disabled && user.id === session.user?.id) {
        await handleLogout();
      }
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not update user.');
    } finally {
      setSettingsBusy(false);
    }
  }

  function startUserPasswordReset(user) {
    setResetPasswordDraft({ userId: user.id, password: '', confirmPassword: '' });
    setSettingsMessage({ type: '', message: '' });
  }

  async function resetSettingsUserPassword(user) {
    if (!isAdmin) return;
    if (!resetPasswordDraft.password || !resetPasswordDraft.confirmPassword) {
      setSettingsNotice('error', 'Enter password and confirmation.');
      return;
    }
    if (resetPasswordDraft.password !== resetPasswordDraft.confirmPassword) {
      setSettingsNotice('error', 'Passwords do not match.');
      return;
    }
    if (resetPasswordDraft.password.length < PASSWORD_MIN_LENGTH) {
      setSettingsNotice('error', `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    setSettingsBusy(true);
    try {
      await budgetApi.resetUserPassword(user.id, resetPasswordDraft.password);
      setResetPasswordDraft({ userId: null, password: '', confirmPassword: '' });
      setSettingsNotice('success', `Password reset for ${user.username}.`);
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not reset password.');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function deleteSettingsUser(user) {
    if (!isAdmin) return;
    if (user.role === 'Admin' && !hasAnotherActiveAdmin(settingsUsers, user.id)) {
      setSettingsNotice('error', 'Cannot delete the last admin.');
      return;
    }
    if (!window.confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    setSettingsBusy(true);
    try {
      await budgetApi.deleteUser(user.id);
      await refreshSettingsUsers();
      setSettingsNotice('success', 'User deleted.');
      if (user.id === session.user?.id) {
        await handleLogout();
      }
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not delete user.');
    } finally {
      setSettingsBusy(false);
    }
  }

  function resetAccountEditor() {
    setEditingAccountId(null);
    setAccountDraft(getDefaultAccountDraft(lookups));
  }

  function resetTransactionEditor() {
    setEditingTransactionId(null);
    setTransactionDraft(getDefaultTransactionDraft(activeCashAccounts));
  }

  function resetBatchTransactionEditor() {
    setBatchTransactionRows(getDefaultBatchTransactionRows(activeCashAccounts));
  }

  function resetTransactionImport() {
    setTransactionImportFile(null);
    setTransactionImportInputKey((current) => current + 1);
  }

  function resetRuleEditor() {
    setEditingRuleId(null);
    setRuleDraft(getDefaultRuleDraft(activeCashAccounts));
  }

  function resetOverrideEditor() {
    setOverrideDraft(null);
  }

  function updateBudgetPlannerRow(rowId, patch) {
    setBudgetPlannerRows((current) => current.map((row) => (
      row.rowId === rowId ? { ...row, ...patch } : row
    )));
  }

  function addBudgetPlannerCategory() {
    const category = budgetPlannerCategory.trim();
    if (!category) return;
    const direction = budgetPlannerDirection === 'income' ? 'income' : 'expense';
    const key = `${direction}|${category.toLowerCase()}`;
    setBudgetPlannerRows((current) => {
      if (current.some((row) => `${row.direction}|${row.category.trim().toLowerCase()}` === key)) {
        return current;
      }
      return [
        ...current,
        {
          rowId: `budget-${direction}-${category.toLowerCase()}`,
          defaultBudgetId: null,
          monthBudgetId: null,
          category,
          direction,
          amount: '',
          mode: direction === 'income' ? 'goal' : 'limit',
          notes: '',
        },
      ].sort((left, right) => {
        if (left.direction !== right.direction) return left.direction === 'income' ? -1 : 1;
        return left.category.localeCompare(right.category);
      });
    });
    setBudgetPlannerCategory('');
  }

  function resetReconciliationEditor() {
    setReconciliationDraft(getDefaultReconciliationDraft(activeCashAccounts, data.reconciliations));
  }

  async function saveAccount(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = {
        ...accountDraft,
        trackingType: 'cash',
        accountType: accountDraft.accountType,
        openingBalance: Number(accountDraft.openingBalance || 0),
        openingBalanceDate: accountDraft.openingBalanceDate,
        sortOrder: Number(accountDraft.sortOrder || 0),
        warningBalance: Number(accountDraft.warningBalance || 0),
        minimumBalance: Number(accountDraft.minimumBalance || 0),
        loanDetails: null,
      };
      if (editingAccountId) {
        await budgetApi.updateAccount(editingAccountId, payload);
        setSuccess('Account updated.');
      } else {
        await budgetApi.createAccount(payload);
        setSuccess('Account created.');
      }
      resetAccountEditor();
      await loadWorkspace();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function saveTransaction(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const savingGeneratedOccurrence = isEditingGeneratedOccurrence;
      const payload = buildTransactionPayload(transactionDraft);
      if (editingTransactionId) {
        await budgetApi.updateTransaction(editingTransactionId, payload);
        setSuccess('Transaction updated.');
      } else {
        await budgetApi.createTransaction(payload);
        setSuccess(savingGeneratedOccurrence ? 'Recurring occurrence saved as a one-off transaction.' : 'Transaction saved.');
      }
      resetTransactionEditor();
      await loadWorkspace();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function saveTransactionBatch(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = validateBatchTransactionRows(batchTransactionRows);
      const response = await budgetApi.createTransactionsBatch(payload);
      setSuccess(`${response.transactions.length} transactions saved.`);
      resetBatchTransactionEditor();
      await loadWorkspace();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function applyBulkLedgerStatus() {
    if (!selectedLedgerEntries.length) {
      setFailure(new Error('Select at least one ledger row first.'));
      return;
    }

    setBusy(true);
    try {
      const manualEntries = selectedLedgerEntries.filter((entry) => entry.sourceType === 'manual');
      const generatedEntries = selectedLedgerEntries.filter((entry) => entry.sourceType === 'generated');

      await Promise.all(manualEntries.map((entry) => (
        budgetApi.updateTransaction(entry.id, buildTransactionPayloadFromEntry(entry, bulkLedgerStatus))
      )));

      if (generatedEntries.length) {
        await budgetApi.createTransactionsBatch(generatedEntries.map((entry) => (
          buildTransactionPayloadFromEntry(entry, bulkLedgerStatus)
        )));
      }

      setSuccess(`${selectedLedgerEntries.length} ledger row${selectedLedgerEntries.length === 1 ? '' : 's'} marked ${bulkLedgerStatus}.`);
      setSelectedLedgerEntryIds([]);
      await loadWorkspace();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function importTransactionsFromWorkbook() {
    if (!transactionImportFile) {
      setFailure(new Error('Choose an Excel or CSV file before importing.'));
      return;
    }

    setBusy(true);
    try {
      const importedTransactions = await buildImportedTransactionsFromWorkbook(transactionImportFile, cashAccounts);
      const response = await budgetApi.createTransactionsBatch(importedTransactions);
      setSuccess(`${response.transactions.length} transactions imported from ${transactionImportFile.name}.`);
      resetTransactionImport();
      await loadWorkspace();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function saveRule(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = {
        ...ruleDraft,
        amount: Number(ruleDraft.amount || 0),
        accountId: Number(ruleDraft.accountId),
        toAccountId: ruleDraft.direction === 'transfer' && ruleDraft.toAccountId
          ? Number(ruleDraft.toAccountId)
          : null,
        frequencyInterval: Number(ruleDraft.frequencyInterval || 1),
        maxOccurrences: ruleDraft.maxOccurrences ? Number(ruleDraft.maxOccurrences) : null,
        weekday: ruleDraft.frequencyUnit === 'week' ? Number(ruleDraft.weekday) : null,
        monthDay: ruleDraft.frequencyUnit === 'month' ? Number(ruleDraft.monthDay) : null,
      };
      if (editingRuleId) {
        await budgetApi.updateRecurringRule(editingRuleId, payload);
        setSuccess('Recurring rule updated.');
      } else {
        await budgetApi.createRecurringRule(payload);
        setSuccess('Recurring rule created.');
      }
      resetRuleEditor();
      await loadWorkspace();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function saveOverride(event) {
    event.preventDefault();
    if (!overrideDraft) return;
    setBusy(true);
    try {
      const payload = {
        ruleId: overrideDraft.ruleId,
        occurrenceDate: overrideDraft.occurrenceDate,
        action: overrideDraft.action,
        amount: overrideDraft.action === 'modify' ? Number(overrideDraft.amount || 0) : null,
        title: overrideDraft.action === 'modify' ? overrideDraft.title : null,
        accountId: overrideDraft.action === 'modify' ? Number(overrideDraft.accountId) : null,
        toAccountId: overrideDraft.action === 'modify' && overrideDraft.direction === 'transfer' && overrideDraft.toAccountId
          ? Number(overrideDraft.toAccountId)
          : null,
        category: overrideDraft.action === 'modify' ? overrideDraft.category : null,
        notes: overrideDraft.action === 'modify' ? overrideDraft.notes : null,
        status: overrideDraft.action === 'modify' ? overrideDraft.status : null,
      };
      await budgetApi.upsertRecurringOverride(payload);
      setSuccess('Occurrence override saved.');
      resetOverrideEditor();
      await loadWorkspace();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function saveBudgetPlanner() {
    setBusy(true);
    try {
      const scope = budgetSaveScope === 'month' ? 'month' : 'default';
      const payload = budgetPlannerRows.map((row) => ({
        id: scope === 'month' ? row.monthBudgetId : row.defaultBudgetId,
        scope,
        month: scope === 'month' ? budgetMonth : null,
        category: row.category,
        direction: row.direction,
        mode: row.mode,
        amount: parseCurrencyInput(row.amount),
        notes: row.notes,
        enabled: parseCurrencyInput(row.amount) > 0,
      }));
      const response = await budgetApi.saveBudgetPlanner(payload);
      setSuccess(`Budget planner saved as ${scope === 'month' ? 'this month only' : 'ongoing defaults'}. ${response.summary.created} created, ${response.summary.updated} updated, ${response.summary.deleted} removed.`);
      await loadWorkspace();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function saveReconciliation(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = {
        accountId: Number(reconciliationDraft.accountId),
        statementEndingDate: reconciliationDraft.statementEndingDate,
        openingBalance: Number(reconciliationDraft.openingBalance || 0),
        closingBalance: Number(reconciliationDraft.closingBalance || 0),
        clearedDelta: Number(reconciliationClearedDelta.toFixed(2)),
        difference: Number(reconciliationDifference.toFixed(2)),
        transactionIds: reconciliationDraft.transactionIds,
        notes: reconciliationDraft.notes,
      };
      await budgetApi.createReconciliation(payload);
      setSuccess('Reconciliation saved and selected transactions marked cleared.');
      resetReconciliationEditor();
      await loadWorkspace();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  function toggleReconciliationTransaction(transactionId) {
    setReconciliationDraft((current) => {
      const exists = current.transactionIds.includes(transactionId);
      return {
        ...current,
        transactionIds: exists
          ? current.transactionIds.filter((id) => id !== transactionId)
          : [...current.transactionIds, transactionId],
      };
    });
  }

  function editAccount(account) {
    setActiveView('accounts');
    setSelectedAccountId(account.id);
    setEditingAccountId(account.id);
    setAccountDraft({
      name: account.name,
      institution: account.institution,
      trackingType: 'cash',
      accountType: account.accountType || lookups.cashAccountTypes[0],
      color: account.color,
      openingBalance: String(account.openingBalance),
      openingBalanceDate: account.openingBalanceDate,
      notes: account.notes,
      sortOrder: String(account.sortOrder),
      isActive: account.isActive,
      warningBalance: String(account.warningBalance ?? lookups.cashWarningThreshold),
      minimumBalance: String(account.minimumBalance ?? 0),
    });
  }

  function editTransaction(transaction) {
    setActiveView('transactions');
    setTransactionEntryMode('single');
    setEditingTransactionId(transaction.sourceType === 'manual' ? transaction.id : null);
    setTransactionDraft(buildTransactionDraftFromEntry(transaction));
  }

  function editRule(rule) {
    setActiveView('recurring');
    setEditingRuleId(rule.id);
    setRuleDraft({
      title: rule.title,
      amount: String(rule.amount),
      direction: rule.direction,
      accountId: rule.accountId,
      toAccountId: rule.toAccountId || '',
      category: rule.category || '',
      frequencyUnit: rule.frequencyUnit,
      frequencyInterval: String(rule.frequencyInterval),
      startsOn: rule.startsOn,
      endsOn: rule.endsOn || '',
      maxOccurrences: rule.maxOccurrences ? String(rule.maxOccurrences) : '',
      weekday: Number.isInteger(rule.weekday) ? String(rule.weekday) : '0',
      monthDay: Number.isInteger(rule.monthDay) ? String(rule.monthDay) : '1',
      status: rule.status,
      notes: rule.notes || '',
    });
  }

  function switchTransactionEntryMode(mode) {
    if (mode === 'single') {
      setTransactionEntryMode('single');
      return;
    }
    resetTransactionEditor();
    setTransactionEntryMode('batch');
  }

  function setLedgerSortKey(sortKey) {
    setLedgerSort((current) => {
      if (current.key === sortKey) {
        return {
          key: sortKey,
          direction: current.direction === 'asc' ? 'desc' : 'asc',
        };
      }
      return {
        key: sortKey,
        direction: sortKey === 'date' ? 'desc' : 'asc',
      };
    });
  }

  function toggleLedgerEntrySelection(entry) {
    if (!isSelectableLedgerEntry(entry)) return;
    const selectionId = getLedgerSelectionId(entry);
    setSelectedLedgerEntryIds((current) => (
      current.includes(selectionId)
        ? current.filter((id) => id !== selectionId)
        : [...current, selectionId]
    ));
  }

  function toggleAllVisibleLedgerEntries() {
    const visibleIds = selectableLedgerEntries.map(getLedgerSelectionId);
    setSelectedLedgerEntryIds((current) => {
      if (allVisibleLedgerSelected) {
        return current.filter((id) => !visibleIds.includes(id));
      }
      return [...new Set([...current, ...visibleIds])];
    });
  }

  function updateBatchTransactionRow(rowId, patch) {
    setBatchTransactionRows((current) => current.map((row) => {
      if (row.rowId !== rowId) return row;
      const nextRow = { ...row, ...patch };
      if (Object.prototype.hasOwnProperty.call(patch, 'direction') && patch.direction !== 'transfer') {
        nextRow.toAccountId = '';
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'accountId') && Number(nextRow.toAccountId) === Number(nextRow.accountId)) {
        nextRow.toAccountId = '';
      }
      return nextRow;
    }));
  }

  function addBatchTransactionRow() {
    setBatchTransactionRows((current) => [...current, createBatchTransactionRow(activeCashAccounts)]);
  }

  function removeBatchTransactionRow(rowId) {
    setBatchTransactionRows((current) => {
      if (current.length === 1) {
        return [createBatchTransactionRow(activeCashAccounts)];
      }
      return current.filter((row) => row.rowId !== rowId);
    });
  }

  function openOverride(entryOrOverride, rule, existingOverride = null) {
    const entry = existingOverride ? {
      ...rule,
      date: existingOverride.occurrenceDate,
      title: existingOverride.title || rule.title,
      amount: existingOverride.amount ?? rule.amount,
      accountId: existingOverride.accountId ?? rule.accountId,
      toAccountId: existingOverride.toAccountId ?? rule.toAccountId,
      category: existingOverride.category ?? rule.category,
      notes: existingOverride.notes ?? rule.notes,
      status: existingOverride.status || 'projected',
      recurringRuleId: rule.id,
    } : entryOrOverride;

    const matchedOverride = existingOverride || data.recurringOverrides.find(
      (item) => item.ruleId === entry.recurringRuleId && item.occurrenceDate === entry.date,
    );

    setActiveView('recurring');
    setOverrideDraft({
      id: matchedOverride?.id ?? null,
      ruleId: entry.recurringRuleId,
      occurrenceDate: entry.date,
      action: matchedOverride?.action ?? 'modify',
      title: matchedOverride?.title ?? entry.title,
      amount: String(matchedOverride?.amount ?? entry.amount),
      accountId: matchedOverride?.accountId ?? entry.accountId,
      toAccountId: matchedOverride?.toAccountId ?? entry.toAccountId ?? '',
      category: matchedOverride?.category ?? entry.category ?? '',
      notes: matchedOverride?.notes ?? entry.notes ?? '',
      status: matchedOverride?.status ?? entry.status ?? 'projected',
      direction: rule.direction,
      ruleTitle: rule.title,
    });
  }

  function buildRecurringOverrideRows(rule) {
    return getRulePreview(rule, data.recurringOverrides, data.transactions, 3650, 12).map((occurrence) => {
      const existingOverride = data.recurringOverrides.find(
        (item) => item.ruleId === rule.id && item.occurrenceDate === occurrence.date,
      );
      return {
        rowId: `${rule.id}-${occurrence.date}`,
        overrideId: existingOverride?.id ?? null,
        ruleId: rule.id,
        occurrenceDate: occurrence.date,
        title: existingOverride?.title ?? occurrence.title,
        amount: String(existingOverride?.amount ?? occurrence.amount),
        originalAmount: String(rule.amount),
        accountId: existingOverride?.accountId ?? occurrence.accountId,
        toAccountId: existingOverride?.toAccountId ?? occurrence.toAccountId ?? '',
        category: existingOverride?.category ?? occurrence.category ?? '',
        notes: existingOverride?.notes ?? occurrence.notes ?? '',
        status: existingOverride?.status ?? occurrence.status ?? 'projected',
        direction: rule.direction,
      };
    });
  }

  function openRecurringOverrideModal(rule) {
    setRecurringModalRuleId(rule.id);
    setRecurringOverrideRows(buildRecurringOverrideRows(rule));
  }

  function closeRecurringOverrideModal() {
    setRecurringModalRuleId(null);
    setRecurringOverrideRows([]);
  }

  function updateRecurringOverrideRow(rowId, patch) {
    setRecurringOverrideRows((current) => current.map((row) => (
      row.rowId === rowId ? { ...row, ...patch } : row
    )));
  }

  async function saveRecurringOverrideRows() {
    if (!recurringModalRule) return;
    setBusy(true);
    try {
      let saved = 0;
      let deleted = 0;
      for (const row of recurringOverrideRows) {
        const amount = parseCurrencyInput(row.amount);
        const originalAmount = parseCurrencyInput(row.originalAmount);
        if (Math.abs(amount - originalAmount) < 0.005) {
          if (row.overrideId) {
            await budgetApi.deleteRecurringOverride(row.overrideId);
            deleted += 1;
          }
          continue;
        }
        await budgetApi.upsertRecurringOverride({
          ruleId: row.ruleId,
          occurrenceDate: row.occurrenceDate,
          action: 'modify',
          amount,
          title: row.title || recurringModalRule.title,
          accountId: Number(row.accountId || recurringModalRule.accountId),
          toAccountId: row.direction === 'transfer' && row.toAccountId ? Number(row.toAccountId) : null,
          category: row.category || recurringModalRule.category,
          notes: row.notes || recurringModalRule.notes,
          status: row.status || 'projected',
        });
        saved += 1;
      }
      closeRecurringOverrideModal();
      setSuccess(`${saved} recurring override${saved === 1 ? '' : 's'} saved${deleted ? ` and ${deleted} reset` : ''}.`);
      await loadWorkspace();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function refreshDebtPayoffLoanRows(options = {}) {
    setDebtPayoffLoading(true);
    try {
      const loanRows = await buildLoanDebtRows();
      setDebtPayoffRows((current) => {
        if (!current.length) {
          return loanRows.length ? loanRows : [createBlankDebtRow()];
        }
        return mergeLoanDebtRows(current, loanRows, options);
      });
    } finally {
      setDebtPayoffLoading(false);
    }
  }

  async function removeAccount(id) {
    if (!window.confirm('Delete this account? This only works if nothing references it yet.')) return;
    setBusy(true);
    try {
      await budgetApi.deleteAccount(id);
      setSuccess('Account deleted.');
      await loadWorkspace();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function removeTransaction(id) {
    if (!window.confirm('Delete this transaction?')) return;
    setBusy(true);
    try {
      await budgetApi.deleteTransaction(id);
      setSuccess('Transaction deleted.');
      await loadWorkspace();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function removeRule(id) {
    if (!window.confirm('Delete this recurring rule and its overrides?')) return;
    setBusy(true);
    try {
      await budgetApi.deleteRecurringRule(id);
      setSuccess('Recurring rule deleted.');
      await loadWorkspace();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function removeOverride(id) {
    if (!window.confirm('Remove this occurrence override?')) return;
    setBusy(true);
    try {
      await budgetApi.deleteRecurringOverride(id);
      setSuccess('Occurrence override removed.');
      resetOverrideEditor();
      await loadWorkspace();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function removeReconciliation(id) {
    if (!window.confirm('Delete this reconciliation and return its transactions to actual status?')) return;
    setBusy(true);
    try {
      await budgetApi.deleteReconciliation(id);
      setSuccess('Reconciliation removed.');
      resetReconciliationEditor();
      await loadWorkspace();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  if (session.status !== 'authenticated') {
    return (
      <AuthView
        busy={busy}
        error={banner.type === 'error' ? banner.message : ''}
        inviteInfo={inviteInfo}
        onLogin={handleLogin}
        onSignup={handleSignup}
      />
    );
  }

  const chartAccounts = selectedAccountFilter === 'all'
    ? activeCashAccounts.slice(0, 4)
    : activeCashAccounts.filter((account) => account.id === selectedAccountFilter);
  const showsProjectionControls = hasActiveHousehold && (activeView === 'overview' || activeView === 'transactions');

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero-copy flex items-center gap-0">
          <img src="/favicon2NB.png" alt="CashMap Logo" className="w-32 h-32 mr-4 self-start flex-shrink-0" />
          <div>
            <div className="kicker">Cash flow operating panel</div>
            <h1>CashMap</h1>
            <p>
              Map Your Money. Build Your Future.
            </p>
          </div>
        </div>
        <div className="hero-actions">
          <div className="user-chip">
            {data.households.length ? (
              <select
                className="household-switcher"
                value={data.activeHousehold?.id || ''}
                onChange={(event) => switchActiveHousehold(Number(event.target.value))}
              >
                {data.households.map((household) => (
                  <option key={household.id} value={household.id}>
                    {household.name}{household.role ? ` · ${household.role}` : ''}
                  </option>
                ))}
              </select>
            ) : null}
            <span>{session.user.username}</span>
            <span className="user-role">{session.user.role}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Open settings"
              title="Settings"
              onClick={() => openSettings('profile')}
            >
              ⚙
            </button>
            <button type="button" className="soft-button" onClick={handleLogout}>
              Log out
            </button>
          </div>
          {showsProjectionControls ? (
          <div className="range-pills">
            <FilterButton
              active={false}
              onClick={() => setFilters((current) => ({ ...current, ...getDefaultDateRange() }))}
            >
              This Month
            </FilterButton>
            <FilterButton
              active={false}
              onClick={() => setFilters((current) => ({ ...current, startDate: getTodayKey(), endDate: addDays(getTodayKey(), 30) }))}
            >
              Next 30 Days
            </FilterButton>
            <FilterButton
              active={false}
              onClick={() => setFilters((current) => ({ ...current, startDate: getTodayKey(), endDate: addDays(getTodayKey(), 90) }))}
            >
              90 Day Forecast
            </FilterButton>
          </div>
          ) : null}
        </div>
      </header>

      <nav className="view-tabs">
        {VIEW_OPTIONS.map((view) => (
          <button
            key={view.id}
            type="button"
            className={`tab-button${activeView === view.id ? ' active' : ''}`}
            disabled={!hasActiveHousehold && view.id !== 'overview'}
            onClick={() => setActiveView(view.id)}
          >
            {view.label}
          </button>
        ))}
      </nav>

      {banner.message ? (
        <div className={`banner ${banner.type === 'error' ? 'error' : 'success'}`}>
          {banner.message}
        </div>
      ) : null}

      {inviteInfo ? (
        <section className="panel household-empty-state">
          <div className="panel-head compact">
            <div>
              <div className="kicker">Invite Link</div>
              <h2>Join {inviteInfo.householdName}</h2>
            </div>
          </div>
          <p className="auth-copy">
            This invite grants {inviteInfo.role.toLowerCase()} access. It stays valid until an account accepts it or the 7 day window expires.
          </p>
          <div className="form-actions">
            <button type="button" className="primary-button" onClick={acceptPendingInvite} disabled={busy || session.status !== 'authenticated'}>
              Join household
            </button>
            <button
              type="button"
              className="soft-button"
              onClick={() => {
                clearInviteTokenFromUrl();
                setInviteToken('');
                setInviteInfo(null);
              }}
            >
              Dismiss link
            </button>
          </div>
        </section>
      ) : null}

      {!hasActiveHousehold ? (
        <section className="panel household-empty-state">
          <div className="panel-head">
            <div>
              <div className="kicker">Households</div>
              <h2>Create or join your first household</h2>
            </div>
          </div>
          <p className="auth-copy">
            Households keep financial data separated by person, family, or shared budget. Create one now or use a household invite link.
          </p>
          <div className="form-actions">
            <button type="button" className="primary-button" onClick={() => openSettings('households')}>
              Open household settings
            </button>
          </div>
        </section>
      ) : null}

      {showsProjectionControls ? (
      <section className="filters panel">
        <div className="panel-head compact">
          <div>
            <div className="kicker">Projection Window</div>
            <h2>{rangeTitle(filters)}</h2>
          </div>
        </div>
        <div className="filters-grid">
          <Field label="Start date">
            <input
              type="date"
              value={filters.startDate}
              onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))}
            />
          </Field>
          <Field label="End date">
            <input
              type="date"
              value={filters.endDate}
              onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))}
            />
          </Field>
          <Field label="Status filter">
            <select
              value={filters.statusFilter}
              onChange={(event) => setFilters((current) => ({ ...current, statusFilter: event.target.value }))}
            >
              {lookups.statusFilters.map((label) => {
                const value = normalizeStatusFilterValue(label);
                return (
                  <option key={label} value={value}>
                    {label}
                  </option>
                );
              })}
            </select>
          </Field>
          <Field label="Account focus">
            <select
              value={filters.accountFilter}
              onChange={(event) => setFilters((current) => ({ ...current, accountFilter: event.target.value === 'all' ? 'all' : Number(event.target.value) }))}
            >
              <option value="all">All accounts</option>
              {cashAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </section>
      ) : null}

      {hasActiveHousehold && activeView === 'overview' ? (
        <div className="content-grid">
          <section className="metric-grid">
            <MetricCard
              label="Ending Cash"
              value={formatCurrency(projection.rangeEndSnapshot.total)}
              meta={`Across ${activeCashAccounts.length || cashAccounts.length} active cash accounts`}
              tone="cool"
            />
            <MetricCard
              label="Net Cash Flow"
              value={formatCurrency(projection.totals.income - projection.totals.expenses)}
              meta={`${formatCurrency(projection.totals.income)} in and ${formatCurrency(projection.totals.expenses)} out`}
              tone="teal"
            />
            <MetricCard
              label="Projected Outflow"
              value={formatCurrency(projection.totals.projectedExpenses)}
              meta={`${formatCurrency(projection.totals.projectedIncome)} projected in`}
              tone="sand"
            />
            <MetricCard
              label="Low Balance Alerts"
              value={String(projection.warnings.length)}
              meta={projection.warnings.length ? 'Click to review current/future alerts' : 'No current/future low-balance warnings'}
              tone={projection.warnings.length ? 'rose' : 'cool'}
              onClick={() => setShowOverviewWarnings((current) => !current)}
            />
            <MetricCard
              label="Budget Warnings"
              value={String(budgetInsights.warnings.length)}
              meta={budgetInsights.warnings.length ? `${formatMonthLabel(`${budgetMonth}-01`)} is projected over budget` : 'No category overages projected this month'}
              tone={budgetInsights.warnings.length ? 'rose' : 'cool'}
            />
          </section>

          <SectionCard title="Cash trajectory" kicker="Combined Forecast">
            {projection.chartSeries.length ? (
              <div className="chart-shell">
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={projection.chartSeries} margin={{ top: 16, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="4 4" stroke="rgba(148, 163, 184, 0.18)" />
                    <XAxis dataKey="label" minTickGap={24} stroke="#6b7280" />
                    <YAxis tickFormatter={formatCurrencyCompact} stroke="#6b7280" width={84} />
                    <Tooltip
                      formatter={(value, key) => {
                        if (key === 'total') return [formatCurrency(value), 'Total cash'];
                        const accountId = Number(String(key).replace('account-', ''));
                        return [formatCurrency(value), accountMap[accountId]?.name || key];
                      }}
                      labelFormatter={(value, payload) => payload?.[0]?.payload?.date ? formatDateLabel(payload[0].payload.date) : value}
                    />
                    <Legend />
                    <ReferenceLine y={0} stroke="#f97316" strokeDasharray="6 6" />
                    <Line type="monotone" dataKey="total" stroke="#155eef" strokeWidth={3} dot={false} name="Total cash" />
                    {chartAccounts.map((account) => (
                      <Line
                        key={account.id}
                        type="monotone"
                        dataKey={`account-${account.id}`}
                        stroke={account.color}
                        strokeWidth={2}
                        dot={false}
                        name={account.name}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="empty-state">No balances exist in this range yet. Add an account or transaction to start forecasting.</div>
            )}
          </SectionCard>

          <SectionCard title="Accounts under watch" kicker="Balance health">
            <div className="account-card-grid">
              {projection.accountSummaries.map((account) => (
                <article key={account.id} className={`account-card${account.needsAttention ? ' danger' : account.lowCash ? ' warning' : ''}`}>
                  <div className="account-card-head">
                    <span className="account-dot" style={{ backgroundColor: account.color }} />
                    <div>
                      <h3>{account.name}</h3>
                      <p>{account.institution || account.accountType}</p>
                    </div>
                  </div>
                  <div className="account-balance">{formatCurrency(account.endBalance)}</div>
                  <div className="account-meta">
                    <span>Start {formatCurrency(account.startBalance)}</span>
                    <span>Range change {formatCurrency(account.delta)}</span>
                    <span>Lowest {formatCurrency(account.minBalance)} on {formatDateLabel(account.minBalanceDate)}</span>
                  </div>
                  <div className="card-row-actions">
                    <button type="button" className="soft-button" onClick={() => editAccount(account)}>
                      Edit account
                    </button>
                  </div>
                </article>
              ))}
              {!projection.accountSummaries.length ? (
                <div className="empty-state">No accounts yet. Start in the Accounts tab by entering your first cash account and opening balance.</div>
              ) : null}
            </div>
          </SectionCard>

          {showOverviewWarnings ? (
            <SectionCard title="Warnings and upcoming pressure" kicker="Overdraft prevention">
              {projection.warnings.length ? (
                <div className="warning-list">
                  {projection.warnings.map((warning) => (
                    <div key={`${warning.accountId}-${warning.minBalanceDate}`} className={`warning-item ${warning.severity}`}>
                      <strong>{warning.accountName}</strong>
                      <span>{warning.severity === 'below-floor' ? 'Drops below the account floor' : 'Gets close to empty'}</span>
                      <span>{formatCurrency(warning.minBalance)} on {formatDateLabel(warning.minBalanceDate)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">No current or future overdraft warnings in the selected window.</div>
              )}
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {hasActiveHousehold && activeView === 'transactions' ? (
        <div className={`content-grid ${transactionEntryMode === 'batch' ? 'transaction-batch-layout' : 'split'}`}>
          <SectionCard
            title={editingTransactionId ? 'Edit transaction' : isEditingGeneratedOccurrence ? 'Edit recurring occurrence' : transactionEntryMode === 'batch' ? 'Batch transaction entry' : 'Add transaction'}
            kicker={transactionEntryMode === 'batch' ? 'Save several rows together' : 'Manual Entry'}
            actions={(
              <div className="entry-mode-toggle">
                <button
                  type="button"
                  className={`soft-button${transactionEntryMode === 'single' ? ' active' : ''}`}
                  onClick={() => switchTransactionEntryMode('single')}
                >
                  Single entry
                </button>
                <button
                  type="button"
                  className={`soft-button${transactionEntryMode === 'batch' ? ' active' : ''}`}
                  onClick={() => switchTransactionEntryMode('batch')}
                >
                  Batch entry
                </button>
                {isEditingTransactionDraft ? (
                  <button type="button" className="soft-button" onClick={resetTransactionEditor}>Cancel edit</button>
                ) : null}
              </div>
            )}
          >
            {transactionEntryMode === 'single' ? (
              <form className="form-grid" onSubmit={saveTransaction}>
                <Field label="Date">
                  <input
                    type="date"
                    value={transactionDraft.date}
                    onChange={(event) => setTransactionDraft((current) => ({ ...current, date: event.target.value }))}
                  />
                </Field>
                <Field label="Title">
                  <input
                    value={transactionDraft.title}
                    onChange={(event) => setTransactionDraft((current) => ({ ...current, title: event.target.value }))}
                    placeholder="Rent, payroll, Costco, transfer..."
                  />
                </Field>
                <Field label="Direction">
                  <select
                    value={transactionDraft.direction}
                    onChange={(event) => setTransactionDraft((current) => ({ ...current, direction: event.target.value }))}
                  >
                    {lookups.ruleDirections.map((direction) => (
                      <option key={direction} value={direction.toLowerCase()}>{direction}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Status">
                  <select
                    value={transactionDraft.status}
                    onChange={(event) => setTransactionDraft((current) => ({ ...current, status: event.target.value }))}
                  >
                    {lookups.statuses.map((status) => (
                      <option key={status} value={status.toLowerCase()}>{status}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Amount">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={transactionDraft.amount}
                    onChange={(event) => setTransactionDraft((current) => ({ ...current, amount: event.target.value }))}
                  />
                </Field>
                <Field label={transactionDraft.direction === 'transfer' ? 'From account' : 'Account'}>
                  <select
                    value={transactionDraft.accountId}
                    onChange={(event) => setTransactionDraft((current) => ({ ...current, accountId: Number(event.target.value) }))}
                  >
                    <option value="">Select account</option>
                    {activeCashAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.name}</option>
                    ))}
                  </select>
                </Field>
                {transactionDraft.direction === 'transfer' ? (
                  <Field label="To account">
                    <select
                      value={transactionDraft.toAccountId}
                      onChange={(event) => setTransactionDraft((current) => ({ ...current, toAccountId: Number(event.target.value) }))}
                    >
                      <option value="">Select destination</option>
                      {activeCashAccounts.filter((account) => account.id !== transactionDraft.accountId).map((account) => (
                        <option key={account.id} value={account.id}>{account.name}</option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                <Field label="Category">
                  <CategoryPicker
                    value={transactionDraft.category}
                    onChange={(category) => setTransactionDraft((current) => ({ ...current, category }))}
                    options={categoryOptions}
                  />
                </Field>
                <Field label="Notes" hint="Optional context like statement memo or why it differs from budget.">
                  <textarea
                    rows="3"
                    value={transactionDraft.notes}
                    onChange={(event) => setTransactionDraft((current) => ({ ...current, notes: event.target.value }))}
                  />
                </Field>
                <div className="form-actions">
                  <button type="submit" className="primary-button" disabled={busy}>
                    {editingTransactionId ? 'Update transaction' : isEditingGeneratedOccurrence ? 'Save occurrence' : 'Save transaction'}
                  </button>
                  <button type="button" className="soft-button" onClick={resetTransactionEditor}>
                    Reset
                  </button>
                </div>
              </form>
            ) : (
              <form className="form-grid" onSubmit={saveTransactionBatch}>
                <div className="inline-note">
                  Fill as many rows as you want, then save them together. Blank rows are ignored.
                </div>
                <div className="import-panel">
                  <div className="import-copy">
                    <strong>Import from Excel or CSV</strong>
                    <span>
                      Account names in the file must match the account names already in the app exactly.
                    </span>
                    <a className="link-button" href="/budget-transaction-import-template.xlsx" download>
                      Download import template
                    </a>
                  </div>
                  <div className="import-actions">
                    <input
                      key={transactionImportInputKey}
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      onChange={(event) => setTransactionImportFile(event.target.files?.[0] || null)}
                    />
                    <div className="form-actions">
                      <button type="button" className="primary-button" disabled={busy || !transactionImportFile} onClick={importTransactionsFromWorkbook}>
                        {transactionImportFile ? `Import ${transactionImportFile.name}` : 'Import workbook'}
                      </button>
                      {transactionImportFile ? (
                        <button type="button" className="soft-button" onClick={resetTransactionImport}>
                          Clear file
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="table-wrap">
                  <table className="data-table batch-entry-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Date</th>
                        <th>Title</th>
                        <th>Direction</th>
                        <th>Status</th>
                        <th>Amount</th>
                        <th>Account</th>
                        <th>To</th>
                        <th>Category</th>
                        <th>Notes</th>
                        <th>Row</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchTransactionRows.map((row, index) => (
                        <tr key={row.rowId}>
                          <td>{index + 1}</td>
                          <td>
                            <input
                              type="date"
                              value={row.date}
                              onChange={(event) => updateBatchTransactionRow(row.rowId, { date: event.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              value={row.title}
                              onChange={(event) => updateBatchTransactionRow(row.rowId, { title: event.target.value })}
                              placeholder="Title"
                            />
                          </td>
                          <td>
                            <select
                              value={row.direction}
                              onChange={(event) => updateBatchTransactionRow(row.rowId, { direction: event.target.value })}
                            >
                              {lookups.ruleDirections.map((direction) => (
                                <option key={direction} value={direction.toLowerCase()}>{direction}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <select
                              value={row.status}
                              onChange={(event) => updateBatchTransactionRow(row.rowId, { status: event.target.value })}
                            >
                              {lookups.statuses.map((status) => (
                                <option key={status} value={status.toLowerCase()}>{status}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={row.amount}
                              onChange={(event) => updateBatchTransactionRow(row.rowId, { amount: event.target.value })}
                              placeholder="0.00"
                            />
                          </td>
                          <td>
                            <select
                              value={row.accountId}
                              onChange={(event) => updateBatchTransactionRow(row.rowId, { accountId: Number(event.target.value) })}
                            >
                              <option value="">Select account</option>
                              {activeCashAccounts.map((account) => (
                                <option key={account.id} value={account.id}>{account.name}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            {row.direction === 'transfer' ? (
                              <select
                                value={row.toAccountId}
                                onChange={(event) => updateBatchTransactionRow(row.rowId, { toAccountId: Number(event.target.value) })}
                              >
                                <option value="">Select destination</option>
                                {activeCashAccounts.filter((account) => account.id !== row.accountId).map((account) => (
                                  <option key={account.id} value={account.id}>{account.name}</option>
                                ))}
                              </select>
                            ) : (
                              <span className="table-secondary">—</span>
                            )}
                          </td>
                          <td>
                            <CategoryPicker
                              value={row.category}
                              onChange={(category) => updateBatchTransactionRow(row.rowId, { category })}
                              options={categoryOptions}
                              placeholder="Category"
                            />
                          </td>
                          <td>
                            <input
                              value={row.notes}
                              onChange={(event) => updateBatchTransactionRow(row.rowId, { notes: event.target.value })}
                              placeholder="Optional"
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="link-button danger"
                              onClick={() => removeBatchTransactionRow(row.rowId)}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="form-actions">
                  <button type="button" className="soft-button" onClick={addBatchTransactionRow}>
                    Add row
                  </button>
                  <button type="button" className="soft-button" onClick={resetBatchTransactionEditor}>
                    Clear rows
                  </button>
                  <button type="submit" className="primary-button" disabled={busy}>
                    {filledBatchRowCount > 0 ? `Save ${filledBatchRowCount} entered row${filledBatchRowCount === 1 ? '' : 's'}` : 'Save entered rows'}
                  </button>
                </div>
              </form>
            )}
          </SectionCard>

          <SectionCard title="Ledger view" kicker="Projected + actual transactions">
            <div className="ledger-toolbar">
              <label className="check-cell ledger-select-all">
                <input
                  type="checkbox"
                  checked={allVisibleLedgerSelected}
                  disabled={!selectableLedgerEntries.length}
                  onChange={toggleAllVisibleLedgerEntries}
                />
                <span>{selectedLedgerEntries.length} selected</span>
              </label>
              <div className="ledger-bulk-actions">
                <select
                  value={bulkLedgerStatus}
                  onChange={(event) => setBulkLedgerStatus(event.target.value)}
                  disabled={!selectedLedgerEntries.length || busy}
                >
                  <option value="actual">Actual</option>
                  <option value="cleared">Cleared</option>
                </select>
                <button
                  type="button"
                  className="soft-button"
                  onClick={applyBulkLedgerStatus}
                  disabled={!selectedLedgerEntries.length || busy}
                >
                  Apply status
                </button>
                {selectedLedgerEntries.length ? (
                  <button type="button" className="link-button" onClick={() => setSelectedLedgerEntryIds([])}>
                    Clear selection
                  </button>
                ) : null}
              </div>
            </div>
            <div className="table-wrap ledger-table-wrap">
              <table className="data-table ledger-table">
                <thead>
                  <tr>
                    <th aria-label="Select transaction">
                      <input
                        type="checkbox"
                        checked={allVisibleLedgerSelected}
                        disabled={!selectableLedgerEntries.length}
                        onChange={toggleAllVisibleLedgerEntries}
                      />
                    </th>
                    <th><SortHeaderButton label="Date" sortKey="date" activeSort={ledgerSort} onSort={setLedgerSortKey} /></th>
                    <th><SortHeaderButton label="Item" sortKey="title" activeSort={ledgerSort} onSort={setLedgerSortKey} /></th>
                    <th><SortHeaderButton label="Flow" sortKey="amount" activeSort={ledgerSort} onSort={setLedgerSortKey} /></th>
                    <th><SortHeaderButton label="Account" sortKey="account" activeSort={ledgerSort} onSort={setLedgerSortKey} /></th>
                    <th><SortHeaderButton label="Status" sortKey="status" activeSort={ledgerSort} onSort={setLedgerSortKey} /></th>
                    <th><SortHeaderButton label="After" sortKey="after" activeSort={ledgerSort} onSort={setLedgerSortKey} /></th>
                    <th><SortHeaderButton label="Total cash" sortKey="total" activeSort={ledgerSort} onSort={setLedgerSortKey} /></th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedVisibleEntries.map((entry) => {
                    const isSelectable = isSelectableLedgerEntry(entry);
                    const selectionId = getLedgerSelectionId(entry);
                    return (
                    <tr key={entry.id}>
                      <td>
                        {isSelectable ? (
                          <input
                            type="checkbox"
                            checked={selectedLedgerEntryIds.includes(selectionId)}
                            onChange={() => toggleLedgerEntrySelection(entry)}
                          />
                        ) : null}
                      </td>
                      <td>{formatDateLabel(entry.date)}</td>
                      <td>
                        <div className="table-primary">{entry.title}</div>
                        <div className="table-secondary">{entry.category || entry.sourceType}</div>
                      </td>
                      <td>
                        <div className="flow-cell">
                          <span className={directionClassName(entry.direction)}>
                            {entry.direction === 'opening' ? 'Start' : entry.direction}
                          </span>
                          <strong>{formatCurrency(entry.amount)}</strong>
                        </div>
                      </td>
                      <td>
                        <div className="table-primary">{entry.account?.name || 'Unassigned'}</div>
                        {entry.toAccount ? <div className="table-secondary">to {entry.toAccount.name}</div> : null}
                      </td>
                      <td><span className={statusClassName(entry.status)}>{entry.status}</span></td>
                      <td>{entry.accountBalanceAfter !== null ? formatCurrency(entry.accountBalanceAfter) : '—'}</td>
                      <td>{formatCurrency(entry.totalBalanceAfter)}</td>
                      <td>
                        <div className="card-row-actions">
                          {entry.sourceType === 'manual' ? (
                            <>
                              <button type="button" className="link-button" onClick={() => editTransaction(entry)}>Edit</button>
                              <button type="button" className="link-button danger" onClick={() => removeTransaction(entry.id)}>Delete</button>
                            </>
                          ) : entry.sourceType === 'opening' ? (
                            <span className="table-secondary">Starting balance</span>
                          ) : (
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => editTransaction(entry)}
                            >
                              Edit
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              {!sortedVisibleEntries.length ? (
                <div className="empty-state">
                  No transactions match this date range and filter yet.
                </div>
              ) : null}
            </div>
          </SectionCard>
        </div>
      ) : null}

      {hasActiveHousehold && activeView === 'recurring' ? (
        <div className="content-grid split">
          <SectionCard
            title={editingRuleId ? 'Edit recurring rule' : 'Add recurring rule'}
            kicker="Auto-generated future cash flow"
            actions={editingRuleId ? (
              <button type="button" className="soft-button" onClick={resetRuleEditor}>Cancel edit</button>
            ) : null}
          >
            <form className="form-grid" onSubmit={saveRule}>
              <Field label="Title">
                <input
                  value={ruleDraft.title}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, title: event.target.value }))}
                  placeholder="Payroll, rent, loan payment..."
                />
              </Field>
              <Field label="Direction">
                <select
                  value={ruleDraft.direction}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, direction: event.target.value }))}
                >
                  {lookups.ruleDirections.map((direction) => (
                    <option key={direction} value={direction.toLowerCase()}>{direction}</option>
                  ))}
                </select>
              </Field>
              <Field label="Amount">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={ruleDraft.amount}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, amount: event.target.value }))}
                />
              </Field>
              <Field label={ruleDraft.direction === 'transfer' ? 'From account' : 'Account'}>
                <select
                  value={ruleDraft.accountId}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, accountId: Number(event.target.value) }))}
                >
                  <option value="">Select account</option>
                  {activeCashAccounts.map((account) => (
                    <option key={account.id} value={account.id}>{account.name}</option>
                  ))}
                </select>
              </Field>
              {ruleDraft.direction === 'transfer' ? (
                <Field label="To account">
                  <select
                    value={ruleDraft.toAccountId}
                    onChange={(event) => setRuleDraft((current) => ({ ...current, toAccountId: Number(event.target.value) }))}
                  >
                    <option value="">Select destination</option>
                    {activeCashAccounts.filter((account) => account.id !== ruleDraft.accountId).map((account) => (
                      <option key={account.id} value={account.id}>{account.name}</option>
                    ))}
                  </select>
                </Field>
              ) : null}
              <Field label="Category">
                <CategoryPicker
                  value={ruleDraft.category}
                  onChange={(category) => setRuleDraft((current) => ({ ...current, category }))}
                  options={categoryOptions}
                />
              </Field>
              <Field label="Every">
                <div className="inline-group">
                  <input
                    type="number"
                    min="1"
                    value={ruleDraft.frequencyInterval}
                    onChange={(event) => setRuleDraft((current) => ({ ...current, frequencyInterval: event.target.value }))}
                  />
                  <select
                    value={ruleDraft.frequencyUnit}
                    onChange={(event) => setRuleDraft((current) => ({ ...current, frequencyUnit: event.target.value }))}
                  >
                    {lookups.frequencyUnits.map((unit) => (
                      <option key={unit} value={unit.toLowerCase()}>{unit.toLowerCase()}</option>
                    ))}
                  </select>
                </div>
              </Field>
              {ruleDraft.frequencyUnit === 'week' ? (
                <Field label="Weekday">
                  <select
                    value={ruleDraft.weekday}
                    onChange={(event) => setRuleDraft((current) => ({ ...current, weekday: event.target.value }))}
                  >
                    {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => (
                      <option key={day} value={index}>{day}</option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {ruleDraft.frequencyUnit === 'month' ? (
                <Field label="Day of month">
                  <input
                    type="number"
                    min="1"
                    max="31"
                    value={ruleDraft.monthDay}
                    onChange={(event) => setRuleDraft((current) => ({ ...current, monthDay: event.target.value }))}
                  />
                </Field>
              ) : null}
              <Field label="Start date">
                <input
                  type="date"
                  value={ruleDraft.startsOn}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, startsOn: event.target.value }))}
                />
              </Field>
              <Field label="End date">
                <input
                  type="date"
                  value={ruleDraft.endsOn}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, endsOn: event.target.value }))}
                />
              </Field>
              <Field label="Number of payments" hint="Leave blank to keep going indefinitely.">
                <input
                  type="number"
                  min="1"
                  value={ruleDraft.maxOccurrences}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, maxOccurrences: event.target.value }))}
                />
              </Field>
              <Field label="Rule status">
                <select
                  value={ruleDraft.status}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, status: event.target.value }))}
                >
                  <option value="active">active</option>
                  <option value="paused">paused</option>
                </select>
              </Field>
              <Field label="Notes">
                <textarea
                  rows="3"
                  value={ruleDraft.notes}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, notes: event.target.value }))}
                />
              </Field>
              <div className="form-actions">
                <button type="submit" className="primary-button" disabled={busy}>
                  {editingRuleId ? 'Update recurring rule' : 'Save recurring rule'}
                </button>
                <button type="button" className="soft-button" onClick={resetRuleEditor}>
                  Reset
                </button>
              </div>
            </form>
          </SectionCard>

          <SectionCard title="Recurring schedule" kicker="Projection engine">
            <div className="rule-list">
              {data.recurringRules.map((rule) => {
                const preview = getRulePreview(rule, data.recurringOverrides, data.transactions, 3650, 1);
                return (
                  <article key={rule.id} className={`rule-card${rule.status === 'paused' ? ' paused' : ''}`}>
                    <div className="rule-head">
                      <div>
                        <h3>{rule.title}</h3>
                        <p>{describeRecurringRule(rule, accountMap)}</p>
                      </div>
                      <div className="rule-price">{formatCurrency(rule.amount)}</div>
                    </div>
                    <div className="rule-meta">
                      <span className={directionClassName(rule.direction)}>{rule.direction}</span>
                      <span className={rule.status === 'active' ? 'pill success' : 'pill muted'}>{rule.status}</span>
                      {rule.category ? <span className="pill">{rule.category}</span> : null}
                      {preview[0] ? (
                        <span className="pill muted">
                          Next {formatDateLabel(preview[0].date)} - {formatCurrency(preview[0].amount)}
                        </span>
                      ) : null}
                    </div>
                    <div className="card-row-actions">
                      <button type="button" className="soft-button" onClick={() => openRecurringOverrideModal(rule)}>
                        Edit
                      </button>
                      <button type="button" className="soft-button" onClick={() => editRule(rule)}>
                        Edit rule details
                      </button>
                      <button type="button" className="link-button danger" onClick={() => removeRule(rule.id)}>
                        Delete
                      </button>
                    </div>
                  </article>
                );
              })}
              {!data.recurringRules.length ? (
                <div className="empty-state">
                  No recurring rules yet. Add payroll, rent, debt payments, utilities, or transfers so future months fill in automatically.
                </div>
              ) : null}
            </div>
          </SectionCard>

          {overrideDraft?.__legacyPanel ? (
          <SectionCard
            title="Occurrence overrides"
            kicker="One-off changes that do not touch the base rule"
            actions={overrideDraft ? (
              <button type="button" className="soft-button" onClick={resetOverrideEditor}>Close</button>
            ) : null}
          >
            {overrideDraft ? (
              <form className="form-grid" onSubmit={saveOverride}>
                <div className="inline-note">
                  Editing <strong>{overrideDraft.ruleTitle}</strong> for <strong>{formatDateLabel(overrideDraft.occurrenceDate)}</strong>.
                </div>
                <Field label="Action">
                  <select
                    value={overrideDraft.action}
                    onChange={(event) => setOverrideDraft((current) => ({ ...current, action: event.target.value }))}
                  >
                    <option value="modify">Modify this occurrence</option>
                    <option value="skip">Skip this occurrence</option>
                  </select>
                </Field>
                {overrideDraft.action === 'modify' ? (
                  <>
                    <Field label="Title">
                      <input
                        value={overrideDraft.title}
                        onChange={(event) => setOverrideDraft((current) => ({ ...current, title: event.target.value }))}
                      />
                    </Field>
                    <Field label="Amount">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={overrideDraft.amount}
                        onChange={(event) => setOverrideDraft((current) => ({ ...current, amount: event.target.value }))}
                      />
                    </Field>
                    <Field label={overrideDraft.direction === 'transfer' ? 'From account' : 'Account'}>
                      <select
                        value={overrideDraft.accountId}
                        onChange={(event) => setOverrideDraft((current) => ({ ...current, accountId: Number(event.target.value) }))}
                      >
                        {activeCashAccounts.map((account) => (
                          <option key={account.id} value={account.id}>{account.name}</option>
                        ))}
                      </select>
                    </Field>
                    {overrideDraft.direction === 'transfer' ? (
                      <Field label="To account">
                        <select
                          value={overrideDraft.toAccountId}
                          onChange={(event) => setOverrideDraft((current) => ({ ...current, toAccountId: Number(event.target.value) }))}
                        >
                          {activeCashAccounts.filter((account) => account.id !== overrideDraft.accountId).map((account) => (
                            <option key={account.id} value={account.id}>{account.name}</option>
                          ))}
                        </select>
                      </Field>
                    ) : null}
                    <Field label="Status">
                      <select
                        value={overrideDraft.status}
                        onChange={(event) => setOverrideDraft((current) => ({ ...current, status: event.target.value }))}
                      >
                        {lookups.statuses.map((status) => (
                          <option key={status} value={status.toLowerCase()}>{status}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Category">
                      <CategoryPicker
                        value={overrideDraft.category}
                        onChange={(category) => setOverrideDraft((current) => ({ ...current, category }))}
                        options={categoryOptions}
                      />
                    </Field>
                    <Field label="Notes">
                      <textarea
                        rows="3"
                        value={overrideDraft.notes}
                        onChange={(event) => setOverrideDraft((current) => ({ ...current, notes: event.target.value }))}
                      />
                    </Field>
                  </>
                ) : (
                  <div className="inline-note">
                    This one occurrence will be skipped, but future generated transactions will continue normally.
                  </div>
                )}
                <div className="form-actions">
                  <button type="submit" className="primary-button" disabled={busy}>
                    Save override
                  </button>
                  {overrideDraft.id ? (
                    <button type="button" className="link-button danger" onClick={() => removeOverride(overrideDraft.id)}>
                      Delete override
                    </button>
                  ) : null}
                </div>
              </form>
            ) : null}
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Rule</th>
                    <th>Action</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recurringOverrides.map((override) => {
                    const rule = data.recurringRules.find((item) => item.id === override.ruleId);
                    if (!rule) return null;
                    return (
                      <tr key={override.id}>
                        <td>{formatDateLabel(override.occurrenceDate)}</td>
                        <td>{rule.title}</td>
                        <td><span className="pill">{override.action}</span></td>
                        <td>{override.amount !== null && override.amount !== undefined ? formatCurrency(override.amount) : '—'}</td>
                        <td>{override.status ? <span className={statusClassName(override.status)}>{override.status}</span> : '—'}</td>
                        <td>
                          <div className="card-row-actions">
                            <button type="button" className="link-button" onClick={() => openOverride(null, rule, override)}>
                              Edit
                            </button>
                            <button type="button" className="link-button danger" onClick={() => removeOverride(override.id)}>
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!data.recurringOverrides.length ? (
                <div className="empty-state">No one-off overrides saved yet.</div>
              ) : null}
            </div>
          </SectionCard>
          ) : null}
        </div>
      ) : null}

      {hasActiveHousehold && activeView === 'accounts' ? (
        <div className="content-grid split">
          <SectionCard
            title={editingAccountId ? 'Edit account' : 'Add account'}
            kicker="Cash account setup"
            actions={editingAccountId ? (
              <button type="button" className="soft-button" onClick={resetAccountEditor}>Cancel edit</button>
            ) : null}
          >
            <form className="form-grid" onSubmit={saveAccount}>
              <Field label="Name">
                <input
                  value={accountDraft.name}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Main checking, joint savings, cash envelope..."
                />
              </Field>
              <Field label="Institution">
                <input
                  value={accountDraft.institution}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, institution: event.target.value }))}
                  placeholder="Bank name or where the cash lives"
                />
              </Field>
              <Field label="Type">
                <select
                  value={accountDraft.accountType}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, accountType: event.target.value }))}
                >
                  {lookups.cashAccountTypes.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </Field>
              <Field label="Opening balance">
                <input
                  type="number"
                  step="0.01"
                  value={accountDraft.openingBalance}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, openingBalance: event.target.value }))}
                />
              </Field>
              <Field label="Opening balance date">
                <input
                  type="date"
                  value={accountDraft.openingBalanceDate}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, openingBalanceDate: event.target.value }))}
                />
              </Field>
              <Field label="Warning balance">
                <input
                  type="number"
                  step="0.01"
                  value={accountDraft.warningBalance}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, warningBalance: event.target.value }))}
                />
              </Field>
              <Field label="Minimum floor" hint="Crossing this floor is treated as a higher-severity warning.">
                <input
                  type="number"
                  step="0.01"
                  value={accountDraft.minimumBalance}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, minimumBalance: event.target.value }))}
                />
              </Field>
              <Field label="Display color">
                <div className="color-input">
                  <input
                    type="color"
                    value={accountDraft.color}
                    onChange={(event) => setAccountDraft((current) => ({ ...current, color: event.target.value }))}
                  />
                  <input
                    value={accountDraft.color}
                    onChange={(event) => setAccountDraft((current) => ({ ...current, color: event.target.value }))}
                  />
                </div>
              </Field>
              <Field label="Sort order">
                <input
                  type="number"
                  min="0"
                  value={accountDraft.sortOrder}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, sortOrder: event.target.value }))}
                />
              </Field>
              <Field label="Notes">
                <textarea
                  rows="3"
                  value={accountDraft.notes}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, notes: event.target.value }))}
                />
              </Field>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={accountDraft.isActive}
                  onChange={(event) => setAccountDraft((current) => ({ ...current, isActive: event.target.checked }))}
                />
                <span>Include this account in active cash forecasting.</span>
              </label>
              <div className="form-actions">
                <button type="submit" className="primary-button" disabled={busy}>
                  {editingAccountId ? 'Update account' : 'Save account'}
                </button>
                <button type="button" className="soft-button" onClick={resetAccountEditor}>
                  Reset
                </button>
              </div>
            </form>
          </SectionCard>

          <SectionCard title="Account details" kicker="Cash health">
            {selectedAccount ? (
              <div className="account-detail-stack">
                <div className="account-detail-header">
                  <div className="account-card-head">
                    <span className="account-dot" style={{ backgroundColor: selectedAccount.color }} />
                    <div>
                      <h3>{selectedAccount.name}</h3>
                      <p>{selectedAccount.institution || selectedAccount.accountType}</p>
                    </div>
                  </div>
                  <div className="card-row-actions">
                    <button type="button" className="soft-button" onClick={() => editAccount(selectedAccount)}>
                      Edit
                    </button>
                    <button type="button" className="link-button danger" onClick={() => removeAccount(selectedAccount.id)}>
                      Delete
                    </button>
                  </div>
                </div>

                {(() => {
                  const summary = projection.accountSummaries.find((item) => item.id === selectedAccount.id);
                  const latestReconciliation = data.reconciliations
                    .filter((item) => item.accountId === selectedAccount.id)
                    .sort((left, right) => right.statementEndingDate.localeCompare(left.statementEndingDate))[0];
                  return (
                    <>
                      <div className="metric-grid compact">
                        <MetricCard
                          label="Range ending balance"
                          value={formatCurrency(summary?.endBalance ?? selectedAccount.openingBalance)}
                          meta={summary ? `Lowest ${formatCurrency(summary.minBalance)} on ${formatDateLabel(summary.minBalanceDate)}` : `Opening ${formatCurrency(selectedAccount.openingBalance)}`}
                          tone="cool"
                        />
                        <MetricCard label="Warning balance" value={formatCurrency(selectedAccount.warningBalance ?? lookups.cashWarningThreshold)} meta="Low-balance warning line" tone="sand" />
                        <MetricCard label="Minimum floor" value={formatCurrency(selectedAccount.minimumBalance ?? 0)} meta="Higher severity if crossed" tone="rose" />
                        <MetricCard label="Last reconciliation" value={latestReconciliation ? formatDateLabel(latestReconciliation.statementEndingDate) : 'None'} meta={latestReconciliation ? formatCurrency(latestReconciliation.closingBalance) : 'No saved statement yet'} tone="teal" />
                      </div>
                      <div className="inline-note">
                        Opening {formatCurrency(selectedAccount.openingBalance)} on {formatDateLabel(selectedAccount.openingBalanceDate)}. {selectedAccount.isActive ? 'This account is active in cash forecasting.' : 'This account is archived from active cash forecasting.'}
                      </div>
                    </>
                  );
                })()}

                <div className="panel-mini-head">
                  <strong>Account roster</strong>
                  <span>Select an account to inspect or edit it.</span>
                </div>
                <div className="account-card-grid">
                  {cashAccounts.map((account) => {
                    const summary = projection.accountSummaries.find((item) => item.id === account.id);
                    return (
                      <article
                        key={account.id}
                        className={`account-card${!account.isActive ? ' paused' : ''}${selectedAccountId === account.id ? ' selected' : ''}`}
                        onClick={() => setSelectedAccountId(account.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelectedAccountId(account.id);
                          }
                        }}
                      >
                        <div className="account-card-head">
                          <span className="account-dot" style={{ backgroundColor: account.color }} />
                          <div>
                            <h3>{account.name}</h3>
                            <p>{account.institution || account.accountType}</p>
                          </div>
                        </div>
                        <div className="account-balance">
                          {formatCurrency(summary?.endBalance ?? account.openingBalance)}
                        </div>
                        <div className="account-meta">
                          <span>Opening {formatCurrency(account.openingBalance)} on {formatDateLabel(account.openingBalanceDate)}</span>
                          <span>{account.isActive ? 'Active' : 'Archived'}</span>
                        </div>
                      </article>
                    );
                  })}
                  {!cashAccounts.length ? (
                    <div className="empty-state">Create your first cash account to start building a cash forecast.</div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="empty-state">Create your first account to start building a cash forecast.</div>
            )}
          </SectionCard>
        </div>
      ) : null}

      {hasActiveHousehold && activeView === 'loans' ? (
        <div className="content-grid">
          <div className="entry-mode-toggle loan-mode-toggle app-loan-toggle">
            <button
              type="button"
              className={`soft-button${loanTab === 'manager' ? ' active' : ''}`}
              onClick={() => setLoanTab('manager')}
            >
              Loan Manager
            </button>
            <button
              type="button"
              className={`soft-button${loanTab === 'payoff' ? ' active' : ''}`}
              onClick={() => setLoanTab('payoff')}
            >
              Payoff Calculator
            </button>
          </div>
          {loanTab === 'manager' ? (
            <LegacyLoanManager />
          ) : (
            <DebtPayoffCalculator
              rows={debtPayoffRows}
              setRows={setDebtPayoffRows}
              loading={debtPayoffLoading}
              onReloadLoans={refreshDebtPayoffLoanRows}
              extras={debtPayoffExtras}
              setExtras={setDebtPayoffExtras}
              fixedTotalPayment={debtPayoffFixedTotal}
              setFixedTotalPayment={setDebtPayoffFixedTotal}
              method={debtPayoffMethod}
              setMethod={setDebtPayoffMethod}
            />
          )}
        </div>
      ) : null}

      {hasActiveHousehold && activeView === 'budgets' ? (
        <div className="content-grid">
          <SectionCard
            title="Budget planner"
            kicker="Ongoing monthly budget with month-specific review"
            actions={(
              <div className="form-actions">
                <input
                  type="month"
                  value={budgetMonth}
                  onChange={(event) => {
                    setBudgetMonth(event.target.value);
                  }}
                />
                <select value={budgetSaveScope} onChange={(event) => setBudgetSaveScope(event.target.value)}>
                  <option value="default">Save ongoing</option>
                  <option value="month">Save this month only</option>
                </select>
                <button type="button" className="soft-button" onClick={() => setBudgetPlannerRows(buildBudgetPlannerRows({ summaries: budgetInsights.summaries }))}>
                  Reset edits
                </button>
                <button type="button" className="primary-button" disabled={busy} onClick={saveBudgetPlanner}>
                  Save budget
                </button>
              </div>
            )}
          >
            <div className="metric-grid budget-metric-grid">
              <SplitMetricCard
                label="Income"
                leftLabel="Budgeted"
                leftValue={formatCurrency(budgetInsights.totals.budgetedIncome)}
                rightLabel="Projected"
                rightValue={formatCurrency(budgetInsights.totals.projectedIncome)}
                meta={formatMonthLabel(`${budgetMonth}-01`)}
                tone="cool"
              />
              <SplitMetricCard
                label="Expenses"
                leftLabel="Budgeted"
                leftValue={formatCurrency(budgetInsights.totals.budgetedExpenses)}
                rightLabel="Projected"
                rightValue={formatCurrency(budgetInsights.totals.projectedExpenses)}
                meta="Transfers ignored"
                tone="sand"
              />
              <SplitMetricCard
                label="Remaining Money"
                leftLabel="Budgeted"
                leftValue={formatCurrency(budgetInsights.totals.budgetedRemaining)}
                rightLabel="Projected"
                rightValue={formatCurrency(budgetInsights.totals.projectedRemaining)}
                meta={`Actual remaining ${formatCurrency(budgetInsights.totals.actualRemaining)}`}
                tone={budgetInsights.totals.projectedRemaining < 0 ? 'rose' : 'teal'}
              />
              <SplitMetricCard
                label="Actuals Posted"
                leftLabel="Income"
                leftValue={formatCurrency(budgetInsights.totals.actualIncome)}
                rightLabel="Expenses"
                rightValue={formatCurrency(budgetInsights.totals.actualExpenses)}
                meta="Actual + cleared only"
                tone={budgetInsights.totals.actualRemaining < 0 ? 'rose' : 'teal'}
              />
              <SplitMetricCard
                label="Review"
                leftLabel="Warnings"
                leftValue={String(budgetInsights.totals.warnings)}
                rightLabel="Unbudgeted"
                rightValue={formatCurrency(budgetInsights.totals.unbudgetedExpenses)}
                meta={budgetInsights.totals.warnings ? 'Click to review budget warnings' : 'No projected budget issues'}
                tone={budgetInsights.totals.warnings || budgetInsights.totals.unbudgetedExpenses ? 'rose' : 'cool'}
                onClick={() => setShowBudgetWarnings((current) => !current)}
              />
            </div>
            <div className="inline-note">
              Rows appear automatically from income and expense categories used in this month plus saved ongoing budgets. Save ongoing to update future months, or save this month only to create an override for {formatMonthLabel(`${budgetMonth}-01`)}.
            </div>
            <div className="planner-add-row">
              <select value={budgetPlannerDirection} onChange={(event) => setBudgetPlannerDirection(event.target.value)}>
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </select>
              <CategoryPicker
                value={budgetPlannerCategory}
                onChange={setBudgetPlannerCategory}
                options={categoryOptions}
                placeholder="Add a planned category with no activity yet"
              />
              <button type="button" className="soft-button" onClick={addBudgetPlannerCategory}>
                Add planned category
              </button>
            </div>
            {showBudgetWarnings ? (
              budgetInsights.warnings.length ? (
                <div className="warning-list">
                  {budgetInsights.warnings.map((warning) => (
                    <div key={`${warning.direction}-${warning.category}`} className="warning-item overdraft">
                      <strong>{warning.direction === 'income' ? 'Income' : 'Expense'}: {warning.category}</strong>
                      <span>{formatCurrency(warning.totalProjected)} projected against {formatCurrency(warning.amount)}</span>
                      <span>{describeBudgetStatus(warning)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">No budget warnings for this month.</div>
              )
            ) : null}
            <div className="table-wrap">
              <table className="data-table budget-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Category</th>
                    <th>Budget</th>
                    <th>Actual</th>
                    <th>Projected Total</th>
                    <th>Variance</th>
                    <th>Status</th>
                    <th>Source</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {budgetPlannerRows.map((row) => {
                    const summary = budgetInsights.summaries.find((item) => (
                      item.direction === row.direction
                      && item.category.trim().toLowerCase() === row.category.trim().toLowerCase()
                    ));
                    const amountValue = parseCurrencyInput(row.amount);
                    const remaining = summary ? summary.remaining : amountValue;
                    const statusLabel = summary
                      ? summary.status
                      : amountValue > 0
                        ? 'planned'
                        : 'no-activity';
                    const sourceLabel = summary?.scope === 'month'
                      ? 'Month override'
                      : summary?.scope === 'default'
                        ? 'Ongoing'
                        : 'Activity';
                    return (
                      <tr key={row.rowId}>
                        <td>
                          <span className={row.direction === 'income' ? 'pill income' : 'pill danger'}>{row.direction}</span>
                        </td>
                        <td>
                          <div className="budget-category-cell">
                            <strong>{row.category}</strong>
                            <select
                              value={row.mode}
                              onChange={(event) => updateBudgetPlannerRow(row.rowId, { mode: event.target.value })}
                            >
                              {lookups.budgetModes.map((mode) => (
                                <option key={mode} value={mode.toLowerCase()}>{mode}</option>
                              ))}
                            </select>
                          </div>
                        </td>
                      <td>
                        <input
                          className="budget-amount-input"
                          type="text"
                          inputMode="decimal"
                          value={row.amount}
                          onFocus={(event) => event.target.select()}
                          onChange={(event) => updateBudgetPlannerRow(row.rowId, {
                            amount: event.target.value,
                          })}
                          onBlur={() => updateBudgetPlannerRow(row.rowId, {
                            amount: formatCurrencyInput(row.amount),
                          })}
                          placeholder="$0.00"
                        />
                      </td>
                      <td>{formatCurrency(summary?.actual ?? 0)}</td>
                      <td>{formatCurrency(summary?.totalProjected ?? 0)}</td>
                      <td>{amountValue > 0 || summary ? formatCurrency(remaining) : '—'}</td>
                      <td>
                        <span className={budgetStatusClassName(summary)}>
                          {statusLabel}
                        </span>
                      </td>
                      <td>{sourceLabel}</td>
                      <td>
                        <input
                          value={row.notes}
                          onChange={(event) => updateBudgetPlannerRow(row.rowId, { notes: event.target.value })}
                          placeholder="Optional"
                        />
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              {!budgetPlannerRows.length ? (
                <div className="empty-state">No budget activity or saved budget lines are available for this month yet.</div>
              ) : null}
            </div>
          </SectionCard>
        </div>
      ) : null}

      {hasActiveHousehold && activeView === 'reconcile' ? (
        <div className="content-grid split">
          <SectionCard title="Reconcile account" kicker="Tie your ledger to a statement balance">
            <form className="form-grid" onSubmit={saveReconciliation}>
              <Field label="Cash account">
                <select
                  value={reconciliationDraft.accountId}
                  onChange={(event) => {
                    const accountId = Number(event.target.value);
                    const latest = data.reconciliations
                      .filter((item) => item.accountId === accountId)
                      .sort((left, right) => right.statementEndingDate.localeCompare(left.statementEndingDate))[0];
                    setReconciliationDraft((current) => ({
                      ...current,
                      accountId,
                      openingBalance: latest ? String(latest.closingBalance) : '0.00',
                      transactionIds: [],
                    }));
                  }}
                >
                  <option value="">Select account</option>
                  {cashAccounts.map((account) => (
                    <option key={account.id} value={account.id}>{account.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Statement ending date">
                <input
                  type="date"
                  value={reconciliationDraft.statementEndingDate}
                  onChange={(event) => setReconciliationDraft((current) => ({ ...current, statementEndingDate: event.target.value }))}
                />
              </Field>
              <Field label="Opening balance">
                <input
                  type="number"
                  step="0.01"
                  value={reconciliationDraft.openingBalance}
                  onChange={(event) => setReconciliationDraft((current) => ({ ...current, openingBalance: event.target.value }))}
                />
              </Field>
              <Field label="Statement closing balance">
                <input
                  type="number"
                  step="0.01"
                  value={reconciliationDraft.closingBalance}
                  onChange={(event) => setReconciliationDraft((current) => ({ ...current, closingBalance: event.target.value }))}
                />
              </Field>
              <Field label="Notes">
                <textarea
                  rows="2"
                  value={reconciliationDraft.notes}
                  onChange={(event) => setReconciliationDraft((current) => ({ ...current, notes: event.target.value }))}
                />
              </Field>
              <div className="mini-metric-grid">
                <div className="mini-metric">
                  <span>Cleared delta</span>
                  <strong>{formatCurrency(reconciliationClearedDelta)}</strong>
                </div>
                <div className="mini-metric">
                  <span>Expected closing</span>
                  <strong>{formatCurrency(Number(reconciliationDraft.openingBalance || 0) + reconciliationClearedDelta)}</strong>
                </div>
                <div className="mini-metric">
                  <span>Difference</span>
                  <strong>{formatCurrency(reconciliationDifference)}</strong>
                </div>
              </div>
              <div className="form-actions">
                <button type="submit" className="primary-button" disabled={busy || !reconciliationDraft.accountId}>
                  Save reconciliation
                </button>
                <button type="button" className="soft-button" onClick={resetReconciliationEditor}>
                  Reset
                </button>
              </div>
            </form>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Clear</th>
                    <th>Date</th>
                    <th>Item</th>
                    <th>Flow</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliationCandidates.map((transaction) => (
                    <tr key={transaction.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={reconciliationDraft.transactionIds.includes(transaction.id)}
                          onChange={() => toggleReconciliationTransaction(transaction.id)}
                        />
                      </td>
                      <td>{formatDateLabel(transaction.date)}</td>
                      <td>
                        <div className="table-primary">{transaction.title}</div>
                        <div className="table-secondary">{transaction.category || 'Uncategorized'}</div>
                      </td>
                      <td>{formatCurrency(getTransactionSignedAmountForAccount(transaction, Number(reconciliationDraft.accountId)))}</td>
                      <td><span className={statusClassName(transaction.status)}>{transaction.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!reconciliationCandidates.length ? (
                <div className="empty-state">No unreconciled actual transactions fall within this statement window.</div>
              ) : null}
            </div>
          </SectionCard>

          <SectionCard title="Reconciliation history" kicker="Saved statement tie-outs">
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Account</th>
                    <th>Opening</th>
                    <th>Closing</th>
                    <th>Difference</th>
                    <th>Transactions</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.reconciliations.map((reconciliation) => (
                    <tr key={reconciliation.id}>
                      <td>{formatDateLabel(reconciliation.statementEndingDate)}</td>
                      <td>{accountMap[reconciliation.accountId]?.name || 'Unknown account'}</td>
                      <td>{formatCurrency(reconciliation.openingBalance)}</td>
                      <td>{formatCurrency(reconciliation.closingBalance)}</td>
                      <td>{formatCurrency(reconciliation.difference)}</td>
                      <td>{reconciliation.transactionIds.length}</td>
                      <td>
                        <button type="button" className="link-button danger" onClick={() => removeReconciliation(reconciliation.id)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.reconciliations.length ? (
                <div className="empty-state">No saved reconciliations yet.</div>
              ) : null}
            </div>
          </SectionCard>
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <section className={`settings-modal panel${settingsTab === 'admin-households' ? ' settings-modal-wide' : ''}`}>
            <div className="panel-head">
              <div>
                <div className="kicker">Workspace Settings</div>
                <h2 id="settings-title">Settings</h2>
              </div>
              <button type="button" className="soft-button" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>

            <div className="entry-mode-toggle settings-tabs">
              <button
                type="button"
                className={`soft-button${settingsTab === 'profile' ? ' active' : ''}`}
                onClick={() => setSettingsTab('profile')}
              >
                Profile
              </button>
              <button
                type="button"
                className={`soft-button${settingsTab === 'households' ? ' active' : ''}`}
                onClick={() => setSettingsTab('households')}
              >
                Households
              </button>
              {isAdmin ? (
                <>
                  <button
                    type="button"
                    className={`soft-button${settingsTab === 'defaults' ? ' active' : ''}`}
                    onClick={() => setSettingsTab('defaults')}
                  >
                    Defaults
                  </button>
                  <button
                    type="button"
                    className={`soft-button${settingsTab === 'users' ? ' active' : ''}`}
                    onClick={() => setSettingsTab('users')}
                  >
                    Users
                  </button>
                  <button
                    type="button"
                    className={`soft-button${settingsTab === 'admin-households' ? ' active' : ''}`}
                    onClick={() => setSettingsTab('admin-households')}
                  >
                    Admin Households
                  </button>
                </>
              ) : null}
            </div>

            {settingsMessage.message ? (
              <div className={`banner ${settingsMessage.type === 'error' ? 'error' : 'success'}`}>
                {settingsMessage.message}
              </div>
            ) : null}

            {settingsTab === 'profile' ? (
              <div className="settings-section">
                <div className="mini-metric-grid">
                  <div className="mini-metric">
                    <span>Signed in as</span>
                    <strong>{session.user.username}</strong>
                  </div>
                  <div className="mini-metric">
                    <span>Role</span>
                    <strong>{session.user.role}</strong>
                  </div>
                </div>
                <form className="form-grid" onSubmit={saveProfileDetails}>
                  <Field label="First name">
                    <input
                      value={profileDraft.firstName}
                      onChange={(event) => setProfileDraft((current) => ({ ...current, firstName: event.target.value }))}
                      autoComplete="given-name"
                    />
                  </Field>
                  <Field label="Last name">
                    <input
                      value={profileDraft.lastName}
                      onChange={(event) => setProfileDraft((current) => ({ ...current, lastName: event.target.value }))}
                      autoComplete="family-name"
                    />
                  </Field>
                  <Field label="Phone number">
                    <input
                      value={profileDraft.phone}
                      onChange={(event) => setProfileDraft((current) => ({ ...current, phone: event.target.value }))}
                      autoComplete="tel"
                    />
                  </Field>
                  <Field label="Gender">
                    <select
                      value={profileDraft.gender}
                      onChange={(event) => setProfileDraft((current) => ({ ...current, gender: event.target.value }))}
                    >
                      {GENDER_OPTIONS.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Annual household income">
                    <select
                      value={profileDraft.annualHouseholdIncome}
                      onChange={(event) => setProfileDraft((current) => ({ ...current, annualHouseholdIncome: event.target.value }))}
                    >
                      <option value="">Select income range</option>
                      {INCOME_BRACKETS.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  </Field>
                  <div className="form-actions">
                    <button type="submit" className="primary-button" disabled={settingsBusy}>
                      Save profile
                    </button>
                  </div>
                </form>

                <form className="form-grid" onSubmit={changeOwnPassword}>
                  <Field label="Current password">
                    <input
                      type="password"
                      value={profileDraft.currentPassword}
                      onChange={(event) => setProfileDraft((current) => ({ ...current, currentPassword: event.target.value }))}
                      autoComplete="current-password"
                    />
                  </Field>
                  <Field label="New password" hint={`Minimum ${PASSWORD_MIN_LENGTH} characters.`}>
                    <input
                      type="password"
                      value={profileDraft.newPassword}
                      onChange={(event) => setProfileDraft((current) => ({ ...current, newPassword: event.target.value }))}
                      autoComplete="new-password"
                    />
                  </Field>
                  <Field label="Confirm new password">
                    <input
                      type="password"
                      value={profileDraft.confirmPassword}
                      onChange={(event) => setProfileDraft((current) => ({ ...current, confirmPassword: event.target.value }))}
                      autoComplete="new-password"
                    />
                  </Field>
                  <div className="form-actions">
                    <button type="submit" className="primary-button" disabled={settingsBusy}>
                      Update password
                    </button>
                    <button type="button" className="soft-button" onClick={resetProfileDraft}>
                      Reset form
                    </button>
                  </div>
                </form>
              </div>
            ) : null}

            {settingsTab === 'households' ? (
              <div className="settings-section">
                <div className="mini-metric-grid">
                  <div className="mini-metric">
                    <span>Active household</span>
                    <strong>{data.activeHousehold?.name || 'None selected'}</strong>
                  </div>
                  <div className="mini-metric">
                    <span>Your access</span>
                    <strong>{data.activeHousehold?.role || 'No household'}</strong>
                  </div>
                </div>

                {data.activeHousehold ? (
                  <div className="form-actions">
                    <button
                      type="button"
                      className="soft-button"
                      onClick={() => leaveHousehold(data.activeHousehold)}
                      disabled={settingsBusy}
                    >
                      Leave household
                    </button>
                    {canManageActiveHousehold ? (
                      <button
                        type="button"
                        className="soft-button danger-button"
                        onClick={() => openArchiveHouseholdConfirm(data.activeHousehold)}
                        disabled={settingsBusy}
                      >
                        Delete household
                      </button>
                    ) : null}
                    {isAdmin ? (
                      <button type="button" className="soft-button" onClick={() => setSettingsTab('admin-households')}>
                        Open admin household view
                      </button>
                    ) : null}
                  </div>
                ) : null}

                <form className="form-grid" onSubmit={createHouseholdFromSettings}>
                  <Field label="Create household">
                    <input
                      value={householdDraft.name}
                      onChange={(event) => setHouseholdDraft({ name: event.target.value })}
                      placeholder="My Household"
                    />
                  </Field>
                  <div className="form-actions">
                    <button type="submit" className="primary-button" disabled={settingsBusy}>
                      Create household
                    </button>
                  </div>
                </form>

                {data.households.length ? (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Household</th>
                          <th>Your role</th>
                          <th>Access</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.households.map((household) => (
                          <tr key={household.id}>
                            <td>
                              <div className="table-primary">{household.name}</div>
                              {data.activeHousehold?.id === household.id ? <div className="table-secondary">Current</div> : null}
                            </td>
                            <td>{household.role}</td>
                            <td>{household.canEdit ? 'Edit' : 'View only'}</td>
                            <td>
                              <div className="settings-user-actions">
                                {data.activeHousehold?.id === household.id ? (
                                  <span className="table-secondary">Selected</span>
                                ) : (
                                  <button type="button" className="soft-button" onClick={() => switchActiveHousehold(household.id)}>
                                    Switch
                                  </button>
                                )}
                                <button type="button" className="soft-button" onClick={() => leaveHousehold(household)} disabled={settingsBusy}>
                                  Leave
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                {data.activeHousehold ? (
                  <>
                    {(canManageActiveHousehold || isAdmin) ? (
                      <form className="form-grid" onSubmit={renameActiveHousehold}>
                        <Field label="Rename active household">
                          <input
                            value={householdRenameDraft}
                            onChange={(event) => setHouseholdRenameDraft(event.target.value)}
                          />
                        </Field>
                        <div className="form-actions">
                          <button type="submit" className="primary-button" disabled={settingsBusy}>
                            Save household
                          </button>
                        </div>
                      </form>
                    ) : null}

                    {(canManageActiveHousehold || isAdmin) ? (
                      <form className="form-grid" onSubmit={createInviteLink}>
                        <Field label="Invite role">
                          <select
                            value={householdInviteRole}
                            onChange={(event) => setHouseholdInviteRole(event.target.value)}
                          >
                            {HOUSEHOLD_ROLES.map((role) => (
                              <option key={role} value={role}>{role}</option>
                            ))}
                          </select>
                        </Field>
                        <div className="form-actions">
                          <button type="submit" className="primary-button" disabled={settingsBusy}>
                            Create invite link
                          </button>
                        </div>
                        {latestInviteLink ? (
                          <Field label="Latest invite link">
                            <div className="inline-group">
                              <input value={latestInviteLink} readOnly />
                              <button
                                type="button"
                                className="soft-button"
                                onClick={() => navigator.clipboard?.writeText(latestInviteLink)}
                              >
                                Copy
                              </button>
                            </div>
                          </Field>
                        ) : null}
                      </form>
                    ) : null}

                    {isAdmin ? (
                      <form className="form-grid" onSubmit={addExistingUserToHousehold}>
                        <Field label="Assign existing user">
                          <select
                            value={householdAssignmentDraft.userId}
                            onChange={(event) => setHouseholdAssignmentDraft((current) => ({ ...current, userId: event.target.value }))}
                          >
                            <option value="">Select user</option>
                            {settingsUsers
                              .filter((user) => !householdMembers.some((member) => member.userId === user.id))
                              .map((user) => (
                                <option key={user.id} value={user.id}>{user.username}</option>
                              ))}
                          </select>
                        </Field>
                        <Field label="Role">
                          <select
                            value={householdAssignmentDraft.role}
                            onChange={(event) => setHouseholdAssignmentDraft((current) => ({ ...current, role: event.target.value }))}
                          >
                            {HOUSEHOLD_ROLES.map((role) => (
                              <option key={role} value={role}>{role}</option>
                            ))}
                          </select>
                        </Field>
                        <div className="form-actions">
                          <button type="submit" className="primary-button" disabled={settingsBusy || !householdAssignmentDraft.userId}>
                            Assign user
                          </button>
                        </div>
                      </form>
                    ) : null}

                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Member</th>
                            <th>App role</th>
                            <th>Household role</th>
                            <th>Status</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {householdMembers.map((member) => (
                            <tr key={member.id}>
                              <td>
                                <div className="table-primary">{member.username}</div>
                                {member.userId === session.user.id ? <div className="table-secondary">You</div> : null}
                              </td>
                              <td>{member.appRole}</td>
                              <td>
                                {(canManageActiveHousehold || isAdmin) ? (
                                  <select
                                    value={member.role}
                                    onChange={(event) => updateMemberRole(member.id, event.target.value)}
                                  >
                                    {HOUSEHOLD_ROLES.map((role) => (
                                      <option key={role} value={role}>{role}</option>
                                    ))}
                                  </select>
                                ) : (
                                  member.role
                                )}
                              </td>
                              <td>{member.disabled ? 'Disabled' : 'Active'}</td>
                              <td>
                                {(canManageActiveHousehold || isAdmin) ? (
                                  <button type="button" className="link-button danger" onClick={() => removeMember(member)}>
                                    Remove
                                  </button>
                                ) : (
                                  <span className="table-secondary">Read only</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!householdMembers.length ? (
                        <div className="empty-state">No household members yet.</div>
                      ) : null}
                    </div>

                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Pending invites</th>
                            <th>Role</th>
                            <th>Created by</th>
                            <th>Expires</th>
                          </tr>
                        </thead>
                        <tbody>
                          {householdInvites.map((invite) => (
                            <tr key={invite.id}>
                              <td>Invite #{invite.id}</td>
                              <td>{invite.role}</td>
                              <td>{invite.createdByUsername || 'Unknown'}</td>
                              <td>{formatDateLabel(invite.expiresAt.slice(0, 10))}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!householdInvites.length ? (
                        <div className="empty-state">No pending invites.</div>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}

            {settingsTab === 'admin-households' && isAdmin ? (
              <div className="settings-section">
                <div className="form-grid">
                  <Field label="Search households">
                    <input
                      value={adminHouseholdSearch}
                      onChange={(event) => setAdminHouseholdSearch(event.target.value)}
                      placeholder="Search household, owner, or status"
                    />
                  </Field>
                </div>

                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th><button type="button" className="link-button" onClick={() => setAdminHouseholdSortKey('name')}>Household</button></th>
                        <th><button type="button" className="link-button" onClick={() => setAdminHouseholdSortKey('ownerUsername')}>Owner</button></th>
                        <th>Status</th>
                        <th><button type="button" className="link-button" onClick={() => setAdminHouseholdSortKey('createdAt')}>Created</button></th>
                        <th><button type="button" className="link-button" onClick={() => setAdminHouseholdSortKey('lastActivityAt')}>Last Used</button></th>
                        <th>Members</th>
                        <th>Accounts</th>
                        <th>Transactions</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAdminHouseholds.map((household) => (
                        <tr key={household.id}>
                          <td>
                            <div className="table-primary">{household.name}</div>
                            {adminSelectedHouseholdId === household.id ? <div className="table-secondary">Selected</div> : null}
                          </td>
                          <td>
                            <div className="table-primary">{household.ownerUsername || 'Unknown'}</div>
                            <div className="table-secondary">{[household.ownerFirstName, household.ownerLastName].filter(Boolean).join(' ') || 'No profile name'}</div>
                          </td>
                          <td><span className={`pill ${household.status === 'archived' ? 'muted' : household.status === 'abandoned' ? 'warning' : 'success'}`}>{household.status}</span></td>
                          <td>{formatDateLabel(household.createdAt.slice(0, 10))}</td>
                          <td>{formatDateLabel((household.lastActivityAt || household.updatedAt || household.createdAt).slice(0, 10))}</td>
                          <td>{household.memberCount}</td>
                          <td>{household.accountCount}</td>
                          <td>{household.transactionCount}</td>
                          <td>
                            <div className="settings-user-actions">
                              <button
                                type="button"
                                className="soft-button"
                                onClick={async () => {
                                  setAdminSelectedHouseholdId(household.id);
                                  setHouseholdRenameDraft(household.name);
                                  await refreshActiveHouseholdMembers(household.id);
                                }}
                              >
                                Edit
                              </button>
                              {!household.isCurrentUserMember && household.status !== 'archived' ? (
                                <button type="button" className="soft-button" onClick={() => addCurrentAdminToHousehold(household.id)}>
                                  Add Self
                                </button>
                              ) : null}
                              {household.isCurrentUserMember ? (
                                <button
                                  type="button"
                                  className="soft-button"
                                  onClick={() => removeCurrentAdminFromHousehold(household)}
                                >
                                  Remove Self
                                </button>
                              ) : null}
                              {household.status === 'archived' ? (
                                <button type="button" className="soft-button" onClick={() => restoreArchivedHousehold(household.id)}>
                                  Restore
                                </button>
                              ) : (
                                <button type="button" className="soft-button danger-button" onClick={() => openArchiveHouseholdConfirm(household)}>
                                  Archive
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!filteredAdminHouseholds.length ? (
                    <div className="empty-state">No households match the current search.</div>
                  ) : null}
                </div>

                {adminSelectedHousehold ? (
                  <>
                    <div className="mini-metric-grid">
                      <div className="mini-metric">
                        <span>Editing household</span>
                        <strong>{adminSelectedHousehold.name}</strong>
                      </div>
                      <div className="mini-metric">
                        <span>Status</span>
                        <strong>{adminSelectedHousehold.status}</strong>
                      </div>
                      <div className="mini-metric">
                        <span>{adminSelectedHousehold.status === 'archived' ? 'Delete after' : 'Last used'}</span>
                        <strong>
                          {formatDateLabel(
                            (
                              adminSelectedHousehold.status === 'archived'
                                ? adminSelectedHousehold.purgeAfter
                                : adminSelectedHousehold.lastActivityAt || adminSelectedHousehold.updatedAt || adminSelectedHousehold.createdAt
                            )?.slice(0, 10) || getTodayKey(),
                          )}
                        </strong>
                      </div>
                    </div>

                    {adminSelectedHousehold.status !== 'archived' ? (
                      <>
                        <form className="form-grid" onSubmit={renameActiveHousehold}>
                          <Field label="Rename household">
                            <input
                              value={householdRenameDraft}
                              onChange={(event) => setHouseholdRenameDraft(event.target.value)}
                            />
                          </Field>
                          <div className="form-actions">
                            <button type="submit" className="primary-button" disabled={settingsBusy}>
                              Save household
                            </button>
                          </div>
                        </form>

                        <form className="form-grid" onSubmit={createInviteLink}>
                          <Field label="Invite role">
                            <select value={householdInviteRole} onChange={(event) => setHouseholdInviteRole(event.target.value)}>
                              {HOUSEHOLD_ROLES.map((role) => (
                                <option key={role} value={role}>{role}</option>
                              ))}
                            </select>
                          </Field>
                          <div className="form-actions">
                            <button type="submit" className="primary-button" disabled={settingsBusy}>
                              Create invite link
                            </button>
                          </div>
                          {latestInviteLink ? (
                            <Field label="Latest invite link">
                              <div className="inline-group">
                                <input value={latestInviteLink} readOnly />
                                <button
                                  type="button"
                                  className="soft-button"
                                  onClick={() => navigator.clipboard?.writeText(latestInviteLink)}
                                >
                                  Copy
                                </button>
                              </div>
                            </Field>
                          ) : null}
                        </form>

                        <form className="form-grid" onSubmit={addExistingUserToHousehold}>
                          <Field label="Assign existing user">
                            <select
                              value={householdAssignmentDraft.userId}
                              onChange={(event) => setHouseholdAssignmentDraft((current) => ({ ...current, userId: event.target.value }))}
                            >
                              <option value="">Select user</option>
                              {settingsUsers
                                .filter((user) => !householdMembers.some((member) => member.userId === user.id))
                                .map((user) => (
                                  <option key={user.id} value={user.id}>{user.username}</option>
                                ))}
                            </select>
                          </Field>
                          <Field label="Role">
                            <select
                              value={householdAssignmentDraft.role}
                              onChange={(event) => setHouseholdAssignmentDraft((current) => ({ ...current, role: event.target.value }))}
                            >
                              {HOUSEHOLD_ROLES.map((role) => (
                                <option key={role} value={role}>{role}</option>
                              ))}
                            </select>
                          </Field>
                          <div className="form-actions">
                            <button type="submit" className="primary-button" disabled={settingsBusy || !householdAssignmentDraft.userId}>
                              Assign user
                            </button>
                          </div>
                        </form>
                      </>
                    ) : null}

                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Member</th>
                            <th>Name</th>
                            <th>Role</th>
                            <th>Phone</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {householdMembers.map((member) => (
                            <tr key={member.id}>
                              <td>{member.username}</td>
                              <td>{[member.firstName, member.lastName].filter(Boolean).join(' ') || 'No profile name'}</td>
                              <td>
                                {adminSelectedHousehold.status === 'archived' ? member.role : (
                                  <select value={member.role} onChange={(event) => updateMemberRole(member.id, event.target.value)}>
                                    {HOUSEHOLD_ROLES.map((role) => (
                                      <option key={role} value={role}>{role}</option>
                                    ))}
                                  </select>
                                )}
                              </td>
                              <td>{member.phone || '—'}</td>
                              <td>
                                {adminSelectedHousehold.status === 'archived' ? '—' : (
                                  <button type="button" className="link-button danger" onClick={() => removeMember(member)}>
                                    Remove
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}

            {settingsTab === 'defaults' && isAdmin ? (
              <form className="settings-section" onSubmit={saveAdminSettings}>
                <div className="inline-note">
                  These defaults are used for new cash accounts and category suggestions.
                </div>
                <div className="form-grid">
                  <Field label="Default cash warning">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={adminSettingsDraft.cashWarningThreshold}
                      onChange={(event) => setAdminSettingsDraft((current) => ({ ...current, cashWarningThreshold: event.target.value }))}
                    />
                  </Field>
                  <Field label="Cash account types" hint="Comma-separated.">
                    <textarea
                      rows="3"
                      value={adminSettingsDraft.cashAccountTypes}
                      onChange={(event) => setAdminSettingsDraft((current) => ({ ...current, cashAccountTypes: event.target.value }))}
                    />
                  </Field>
                  <Field label="Category suggestions" hint="Comma-separated.">
                    <textarea
                      rows="4"
                      value={adminSettingsDraft.categorySuggestions}
                      onChange={(event) => setAdminSettingsDraft((current) => ({ ...current, categorySuggestions: event.target.value }))}
                    />
                  </Field>
                </div>
                <div className="form-actions">
                  <button type="submit" className="primary-button" disabled={settingsBusy}>
                    Save defaults
                  </button>
                  <button
                    type="button"
                    className="soft-button"
                    onClick={() => setAdminSettingsDraft(settingsDraftFromLookups(lookups))}
                  >
                    Reset form
                  </button>
                </div>
              </form>
            ) : null}

            {settingsTab === 'users' && isAdmin ? (
              <div className="settings-section">
                <form className="form-grid user-admin-form" onSubmit={saveSettingsUser}>
                  <Field label="Username">
                    <input
                      value={userDraft.username}
                      onChange={(event) => setUserDraft((current) => ({ ...current, username: event.target.value }))}
                    />
                  </Field>
                  <Field label="Role">
                    <select
                      value={userDraft.role}
                      onChange={(event) => setUserDraft((current) => ({ ...current, role: event.target.value }))}
                    >
                      {USER_ROLES.map((role) => (
                        <option key={role} value={role}>{role}</option>
                      ))}
                    </select>
                  </Field>
                  {!editingUserId ? (
                    <>
                      <Field label={`Password (min ${PASSWORD_MIN_LENGTH})`}>
                        <input
                          type="password"
                          value={userDraft.password}
                          onChange={(event) => setUserDraft((current) => ({ ...current, password: event.target.value }))}
                        />
                      </Field>
                      <Field label="Confirm password">
                        <input
                          type="password"
                          value={userDraft.confirmPassword}
                          onChange={(event) => setUserDraft((current) => ({ ...current, confirmPassword: event.target.value }))}
                        />
                      </Field>
                    </>
                  ) : null}
                  <div className="form-actions user-form-actions">
                    <span className="table-secondary">Active admins: {activeAdminCount}</span>
                    <button type="submit" className="primary-button" disabled={settingsBusy}>
                      {editingUserId ? 'Update user' : 'Create user'}
                    </button>
                    {editingUserId ? (
                      <button type="button" className="soft-button" onClick={resetUserDraft}>
                        Cancel edit
                      </button>
                    ) : null}
                  </div>
                </form>

                <div className="table-wrap">
                  <table className="data-table settings-users-table">
                    <thead>
                      <tr>
                        <th>Username</th>
                        <th>Role</th>
                        <th>Status</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...settingsUsers].sort((left, right) => left.username.localeCompare(right.username)).map((user) => (
                        <tr key={user.id}>
                          <td>
                            <div className="table-primary">{user.username}</div>
                            {user.id === session.user.id ? <div className="table-secondary">Current user</div> : null}
                          </td>
                          <td>{user.role}</td>
                          <td>
                            <span className={user.disabled ? 'pill muted' : 'pill success'}>
                              {user.disabled ? 'Disabled' : 'Active'}
                            </span>
                          </td>
                          <td>
                            <div className="settings-user-actions">
                              <button type="button" className="soft-button" onClick={() => editSettingsUser(user)}>
                                Edit
                              </button>
                              <button type="button" className="soft-button" onClick={() => toggleSettingsUserDisabled(user)}>
                                {user.disabled ? 'Enable' : 'Disable'}
                              </button>
                              <button type="button" className="soft-button" onClick={() => startUserPasswordReset(user)}>
                                Reset Password
                              </button>
                              <button type="button" className="soft-button danger-button" onClick={() => deleteSettingsUser(user)}>
                                Delete
                              </button>
                            </div>
                            {resetPasswordDraft.userId === user.id ? (
                              <div className="reset-password-row">
                                <input
                                  type="password"
                                  placeholder="New password"
                                  value={resetPasswordDraft.password}
                                  onChange={(event) => setResetPasswordDraft((current) => ({ ...current, password: event.target.value }))}
                                />
                                <input
                                  type="password"
                                  placeholder="Confirm"
                                  value={resetPasswordDraft.confirmPassword}
                                  onChange={(event) => setResetPasswordDraft((current) => ({ ...current, confirmPassword: event.target.value }))}
                                />
                                <button type="button" className="primary-button" onClick={() => resetSettingsUserPassword(user)}>
                                  Save
                                </button>
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() => setResetPasswordDraft({ userId: null, password: '', confirmPassword: '' })}
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!settingsUsers.length ? (
                    <div className="empty-state">No users loaded yet.</div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {archiveConfirm.open ? (
        <div className="modal-backdrop modal-backdrop-nested" role="dialog" aria-modal="true" aria-labelledby="archive-household-title">
          <section className="confirm-modal panel">
            <div className="panel-head">
              <div>
                <div className="kicker">Household Deletion</div>
                <h2 id="archive-household-title">Delete {archiveConfirm.householdName}</h2>
              </div>
              <button
                type="button"
                className="soft-button"
                onClick={() => setArchiveConfirm({ open: false, checked: false, householdId: null, householdName: '' })}
                disabled={settingsBusy}
              >
                Close
              </button>
            </div>
            <div className="warning-item overdraft">
              <strong>This household will be removed from all member views immediately.</strong>
              <span>Its data will stay archived for 30 days for admin recovery, then it will be permanently deleted and cannot be restored.</span>
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={archiveConfirm.checked}
                onChange={(event) => setArchiveConfirm((current) => ({ ...current, checked: event.target.checked }))}
              />
              <span>I understand this household and all of its data will be unrecoverable after the 30 day archive window.</span>
            </label>
            <div className="form-actions">
              <button
                type="button"
                className="primary-button danger-button"
                onClick={confirmArchiveHousehold}
                disabled={settingsBusy || !archiveConfirm.checked}
              >
                {settingsBusy ? 'Deleting...' : 'Confirm delete'}
              </button>
              <button
                type="button"
                className="soft-button"
                onClick={() => setArchiveConfirm({ open: false, checked: false, householdId: null, householdName: '' })}
                disabled={settingsBusy}
              >
                Cancel
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {recurringModalRule ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="recurring-override-title">
          <section className="settings-modal panel settings-modal-wide">
            <div className="panel-head">
              <div>
                <div className="kicker">Recurring Overrides</div>
                <h2 id="recurring-override-title">{recurringModalRule.title}</h2>
                <p className="auth-copy">{describeRecurringRule(recurringModalRule, accountMap)}</p>
              </div>
              <button type="button" className="soft-button" onClick={closeRecurringOverrideModal}>
                Close
              </button>
            </div>
            <div className="table-wrap">
              <table className="data-table recurring-override-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Base amount</th>
                    <th>Override amount</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {recurringOverrideRows.map((row) => {
                    const changed = Math.abs(parseCurrencyInput(row.amount) - parseCurrencyInput(row.originalAmount)) >= 0.005;
                    return (
                      <tr key={row.rowId}>
                        <td>
                          <div className="table-primary">{formatDateLabel(row.occurrenceDate)}</div>
                          {row.overrideId ? <div className="table-secondary">Saved override</div> : null}
                        </td>
                        <td>{formatCurrency(parseCurrencyInput(row.originalAmount))}</td>
                        <td>
                          <input
                            value={row.amount}
                            onChange={(event) => updateRecurringOverrideRow(row.rowId, { amount: event.target.value })}
                            onBlur={() => updateRecurringOverrideRow(row.rowId, { amount: formatCurrencyInput(row.amount) })}
                          />
                        </td>
                        <td>
                          <span className={changed ? 'pill warning' : 'pill muted'}>
                            {changed ? 'override' : 'base rule'}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => updateRecurringOverrideRow(row.rowId, { amount: row.originalAmount })}
                          >
                            Reset
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!recurringOverrideRows.length ? (
                <div className="empty-state">No future transactions are available for this rule.</div>
              ) : null}
            </div>
            <div className="form-actions">
              <button type="button" className="primary-button" onClick={saveRecurringOverrideRows} disabled={busy || !recurringOverrideRows.length}>
                Save overrides
              </button>
              <button
                type="button"
                className="soft-button"
                onClick={() => {
                  closeRecurringOverrideModal();
                  editRule(recurringModalRule);
                }}
              >
                Edit rule details
              </button>
              <button type="button" className="soft-button" onClick={closeRecurringOverrideModal}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      ) : null}

    </div>
  );
}
