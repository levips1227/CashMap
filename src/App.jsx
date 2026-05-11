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
    'Savings',
    'Subscription',
    'Medical',
    'Travel',
    'Shopping',
    'Other',
  ],
  accountColorPalette: ['#155eef', '#0891b2', '#0f766e', '#7c3aed', '#b45309', '#dc2626'],
};

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

function buildBudgetPlannerRows({ categories, budgets, month }) {
  const expenseBudgets = budgets.filter((budget) => budget.month === month && budget.direction === 'expense');
  const budgetMap = new Map(expenseBudgets.map((budget) => [budget.category.trim().toLowerCase(), budget]));
  const allCategoryKeys = new Set([
    ...categories.map((category) => category.trim().toLowerCase()),
    ...expenseBudgets.map((budget) => budget.category.trim().toLowerCase()),
  ]);

  return [...allCategoryKeys]
    .map((key) => {
      const existing = budgetMap.get(key);
      const category = existing?.category || categories.find((item) => item.trim().toLowerCase() === key) || key;
      return {
        rowId: `budget-${month}-${key}`,
        id: existing?.id ?? null,
        category,
        enabled: Boolean(existing),
        amount: existing ? String(existing.amount) : '',
        mode: existing?.mode || 'limit',
        notes: existing?.notes || '',
      };
    })
    .sort((left, right) => left.category.localeCompare(right.category));
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
  if (summary.status === 'met') return 'Goal already met in this month.';
  if (summary.mode === 'goal') return `${formatCurrency(summary.remaining)} still needed to reach the goal.`;
  return `${formatCurrency(summary.remaining)} remaining before the limit.`;
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

function MetricCard({ label, value, meta, tone = 'cool' }) {
  return (
    <article className={`metric-card ${tone}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {meta ? <div className="metric-meta">{meta}</div> : null}
    </article>
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

function LoginView({ busy, error, onSubmit }) {
  const [username, setUsername] = useState('Admin');
  const [password, setPassword] = useState('change-me-please');

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="kicker">Budget Projection</div>
        <h1>Forecast cash across accounts before the month happens.</h1>
        <p className="auth-copy">
          Track each account balance, generate recurring expenses forward, and plan transfers before anything overdrafts.
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
        <div className="dev-note">
          Local default: <code>Admin</code> / <code>change-me-please</code>
        </div>
      </section>
    </main>
  );
}

export default function App() {
  const [session, setSession] = useState({ status: 'loading', user: null });
  const [data, setData] = useState({
    lookups: DEFAULT_LOOKUPS,
    accounts: [],
    transactions: [],
    recurringRules: [],
    recurringOverrides: [],
    budgets: [],
    reconciliations: [],
  });
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
  const [budgetMonth, setBudgetMonth] = useState(getMonthKey(getTodayKey()));
  const [budgetPlannerRows, setBudgetPlannerRows] = useState([]);
  const [budgetPlannerCategory, setBudgetPlannerCategory] = useState('');
  const [reconciliationDraft, setReconciliationDraft] = useState(getDefaultReconciliationDraft());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('profile');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState({ type: '', message: '' });
  const [profileDraft, setProfileDraft] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [adminSettingsDraft, setAdminSettingsDraft] = useState(settingsDraftFromLookups(DEFAULT_LOOKUPS));
  const [settingsUsers, setSettingsUsers] = useState([]);
  const [userDraft, setUserDraft] = useState({ username: '', role: 'Standard User', password: '', confirmPassword: '' });
  const [editingUserId, setEditingUserId] = useState(null);
  const [resetPasswordDraft, setResetPasswordDraft] = useState({ userId: null, password: '', confirmPassword: '' });
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState({ type: '', message: '' });

  useEffect(() => {
    loadWorkspace();
  }, []);

  const lookups = data.lookups || DEFAULT_LOOKUPS;
  const isAdmin = session.user?.role === 'Admin';
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
  const budgetRange = getMonthBounds(budgetMonth);
  const budgetProjection = buildProjection({
    accounts: data.accounts,
    transactions: data.transactions,
    recurringRules: data.recurringRules,
    recurringOverrides: data.recurringOverrides,
    startDate: budgetRange.startDate,
    endDate: budgetRange.endDate,
    statusFilter: 'all',
    accountFilter: 'all',
    warningThreshold: lookups.cashWarningThreshold,
  });
  const budgetInsights = buildBudgetInsights({
    budgets: data.budgets,
    entries: budgetProjection.allEntries,
    monthKey: budgetMonth,
  });
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
      categories: categoryOptions,
      budgets: data.budgets,
      month: budgetMonth,
    }));
  }, [budgetMonth, categoryOptions, data.budgets]);

  useEffect(() => {
    const visibleIds = new Set(visibleLedgerSelectionKey ? visibleLedgerSelectionKey.split('|') : []);
    setSelectedLedgerEntryIds((current) => {
      const next = current.filter((id) => visibleIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [visibleLedgerSelectionKey]);

  async function loadWorkspace() {
    setBusy(true);
    try {
      const payload = await budgetApi.bootstrap();
      startTransition(() => {
        setSession({ status: 'authenticated', user: payload.user });
        setData({
          lookups: payload.lookups,
          accounts: payload.accounts,
          transactions: payload.transactions,
          recurringRules: payload.recurringRules,
          recurringOverrides: payload.recurringOverrides,
          budgets: payload.budgets,
          reconciliations: payload.reconciliations,
        });
        setAccountDraft(getDefaultAccountDraft(payload.lookups));
        const payloadCashAccounts = payload.accounts.filter((account) => (account.trackingType || 'cash') !== 'loan' && account.isActive);
        setTransactionDraft(getDefaultTransactionDraft(payloadCashAccounts));
        setBatchTransactionRows(getDefaultBatchTransactionRows(payloadCashAccounts));
        setRuleDraft(getDefaultRuleDraft(payloadCashAccounts));
        setReconciliationDraft(getDefaultReconciliationDraft(payloadCashAccounts, payload.reconciliations));
        setSelectedAccountId((current) => current ?? payloadCashAccounts[0]?.id ?? null);
        setBanner({ type: '', message: '' });
      });
    } catch (error) {
      if (error.status === 401) {
        setSession({ status: 'anonymous', user: null });
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
    } catch (error) {
      setBanner({ type: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    setBusy(true);
    try {
      await budgetApi.logout();
      setSession({ status: 'anonymous', user: null });
      setSettingsOpen(false);
      setSettingsUsers([]);
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
    setProfileDraft({ currentPassword: '', newPassword: '', confirmPassword: '' });
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

  async function openSettings(tab = 'profile') {
    const activeTab = isAdmin ? tab : 'profile';
    setSettingsOpen(true);
    setSettingsTab(activeTab);
    setSettingsMessage({ type: '', message: '' });
    setAdminSettingsDraft(settingsDraftFromLookups(lookups));
    resetProfileDraft();
    resetUserDraft();

    if (!isAdmin) return;
    setSettingsBusy(true);
    try {
      const [settingsResponse, usersResponse] = await Promise.all([
        budgetApi.getSettings(),
        budgetApi.listUsers(),
      ]);
      setAdminSettingsDraft(settingsDraftFromLookups({
        ...lookups,
        ...(settingsResponse.settings || {}),
      }));
      setSettingsUsers(usersResponse.users || []);
    } catch (error) {
      setSettingsNotice('error', error.message || 'Could not load settings.');
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
    const key = category.toLowerCase();
    setBudgetPlannerRows((current) => {
      if (current.some((row) => row.category.trim().toLowerCase() === key)) {
        return current;
      }
      return [
        ...current,
        {
          rowId: `budget-${budgetMonth}-${key}`,
          id: null,
          category,
          enabled: true,
          amount: '',
          mode: 'limit',
          notes: '',
        },
      ].sort((left, right) => left.category.localeCompare(right.category));
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
      const payload = budgetPlannerRows.map((row) => ({
        id: row.id,
        month: budgetMonth,
        category: row.category,
        direction: 'expense',
        mode: row.mode,
        amount: Number(row.amount || 0),
        notes: row.notes,
        enabled: row.enabled,
      }));
      const response = await budgetApi.saveBudgetPlanner(payload);
      setSuccess(`Budget planner saved. ${response.summary.created} created, ${response.summary.updated} updated, ${response.summary.deleted} removed.`);
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
      <LoginView
        busy={busy}
        error={banner.type === 'error' ? banner.message : ''}
        onSubmit={handleLogin}
      />
    );
  }

  const chartAccounts = selectedAccountFilter === 'all'
    ? activeCashAccounts.slice(0, 4)
    : activeCashAccounts.filter((account) => account.id === selectedAccountFilter);
  const showsProjectionControls = activeView === 'overview' || activeView === 'transactions';

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero-copy">
          <div className="kicker">Cash flow operating panel</div>
          <h1>Budget Projection</h1>
          <p>
            A running cash forecast across every account, with recurring rules, date-range projection, and override control for one-off changes.
          </p>
        </div>
        <div className="hero-actions">
          <div className="user-chip">
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

      {activeView === 'overview' ? (
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
              meta={projection.warnings.length ? 'Accounts needing cash attention in range' : 'No low-balance warnings in range'}
              tone={projection.warnings.length ? 'rose' : 'cool'}
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
              <div className="empty-state">No overdraft or low-cash warnings in the selected window.</div>
            )}
          </SectionCard>
        </div>
      ) : null}

      {activeView === 'transactions' ? (
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
                  <input
                    list="category-suggestions"
                    value={transactionDraft.category}
                    onChange={(event) => setTransactionDraft((current) => ({ ...current, category: event.target.value }))}
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
                            <input
                              list="category-suggestions"
                              value={row.category}
                              onChange={(event) => updateBatchTransactionRow(row.rowId, { category: event.target.value })}
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

      {activeView === 'recurring' ? (
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
                <input
                  list="category-suggestions"
                  value={ruleDraft.category}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, category: event.target.value }))}
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
                const preview = getRulePreview(rule, data.recurringOverrides, data.transactions);
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
                    </div>
                    {preview.length ? (
                      <div className="preview-list">
                        {preview.map((occurrence) => (
                          <button
                            key={occurrence.id}
                            type="button"
                            className="preview-item"
                            onClick={() => openOverride(occurrence, rule)}
                          >
                            <span>{formatDateLabel(occurrence.date)}</span>
                            <strong>{formatCurrency(occurrence.amount)}</strong>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-mini">No upcoming occurrences in the preview window.</div>
                    )}
                    <div className="card-row-actions">
                      <button type="button" className="soft-button" onClick={() => editRule(rule)}>
                        Edit
                      </button>
                      <button type="button" className="soft-button" onClick={() => openOverride(preview[0] || { ...rule, date: rule.startsOn, recurringRuleId: rule.id }, rule)}>
                        Override occurrence
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
                      <input
                        list="category-suggestions"
                        value={overrideDraft.category}
                        onChange={(event) => setOverrideDraft((current) => ({ ...current, category: event.target.value }))}
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
        </div>
      ) : null}

      {activeView === 'accounts' ? (
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

      {activeView === 'loans' ? (
        <div className="content-grid">
          <LegacyLoanManager />
        </div>
      ) : null}

      {activeView === 'budgets' ? (
        <div className="content-grid">
          <SectionCard
            title="Monthly budget planner"
            kicker="Edit category limits for the month in one pass"
            actions={(
              <div className="form-actions">
                <input
                  type="month"
                  value={budgetMonth}
                  onChange={(event) => {
                    setBudgetMonth(event.target.value);
                  }}
                />
                <button type="button" className="soft-button" onClick={() => setBudgetPlannerRows(buildBudgetPlannerRows({ categories: categoryOptions, budgets: data.budgets, month: budgetMonth }))}>
                  Reset month
                </button>
                <button type="button" className="primary-button" disabled={busy} onClick={saveBudgetPlanner}>
                  Save planner
                </button>
              </div>
            )}
          >
            <div className="metric-grid compact">
              <MetricCard label="Budgeted" value={formatCurrency(budgetInsights.totals.budgeted)} meta={formatMonthLabel(`${budgetMonth}-01`)} tone="cool" />
              <MetricCard label="Actual spent" value={formatCurrency(budgetInsights.totals.actual)} meta="Posted actual + cleared activity" tone="teal" />
              <MetricCard label="Projected total" value={formatCurrency(budgetInsights.totals.projected)} meta="Including future projected items" tone="sand" />
              <MetricCard label="Warnings" value={String(budgetInsights.totals.warnings)} meta={budgetInsights.totals.warnings ? 'Lines projected over limit' : 'No monthly overages projected'} tone={budgetInsights.totals.warnings ? 'rose' : 'cool'} />
            </div>
            <div className="inline-note">
              Budget rows are tied to the same category names used by transactions and recurring rules. Set a monthly amount for the categories you care about, then save the whole month at once.
            </div>
            <div className="planner-add-row">
              <input
                list="category-suggestions"
                value={budgetPlannerCategory}
                onChange={(event) => setBudgetPlannerCategory(event.target.value)}
                placeholder="Add another category to this month"
              />
              <button type="button" className="soft-button" onClick={addBudgetPlannerCategory}>
                Add category
              </button>
            </div>
            {budgetInsights.warnings.length ? (
              <div className="warning-list">
                {budgetInsights.warnings.map((warning) => (
                  <div key={warning.id} className="warning-item overdraft">
                    <strong>{warning.category}</strong>
                    <span>{formatCurrency(warning.totalProjected)} projected against {formatCurrency(warning.amount)}</span>
                    <span>{describeBudgetStatus(warning)}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Use</th>
                    <th>Category</th>
                    <th>Mode</th>
                    <th>Budget</th>
                    <th>Actual</th>
                    <th>Projected</th>
                    <th>Remaining</th>
                    <th>Status</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {budgetPlannerRows.map((row) => {
                    const summary = budgetInsights.summaries.find((item) => item.category.trim().toLowerCase() === row.category.trim().toLowerCase());
                    const amountValue = Number(row.amount || 0);
                    const enabled = row.enabled || amountValue > 0;
                    const remaining = summary ? summary.remaining : amountValue;
                    const statusLabel = summary
                      ? summary.status
                      : enabled && amountValue > 0
                        ? 'planned'
                        : 'inactive';
                    return (
                      <tr key={row.rowId}>
                        <td>
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(event) => updateBudgetPlannerRow(row.rowId, { enabled: event.target.checked })}
                          />
                        </td>
                        <td>{row.category}</td>
                      <td>
                        <select
                          value={row.mode}
                          onChange={(event) => updateBudgetPlannerRow(row.rowId, { mode: event.target.value })}
                        >
                          {lookups.budgetModes.map((mode) => (
                            <option key={mode} value={mode.toLowerCase()}>{mode}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={row.amount}
                          onChange={(event) => updateBudgetPlannerRow(row.rowId, {
                            amount: event.target.value,
                            enabled: event.target.value !== '' ? true : row.enabled,
                          })}
                          placeholder="0.00"
                        />
                      </td>
                      <td>{formatCurrency(summary?.actual ?? 0)}</td>
                      <td>{formatCurrency(summary?.totalProjected ?? 0)}</td>
                      <td>{enabled ? formatCurrency(remaining) : '—'}</td>
                      <td>
                        <span className={`pill ${summary?.overBudget ? 'danger' : summary?.goalMet ? 'success' : enabled ? 'muted' : ''}`}>
                          {statusLabel}
                        </span>
                      </td>
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
                <div className="empty-state">No budget categories are available yet.</div>
              ) : null}
            </div>
          </SectionCard>
        </div>
      ) : null}

      {activeView === 'reconcile' ? (
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
          <section className="settings-modal panel">
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
                </>
              ) : null}
            </div>

            {settingsMessage.message ? (
              <div className={`banner ${settingsMessage.type === 'error' ? 'error' : 'success'}`}>
                {settingsMessage.message}
              </div>
            ) : null}

            {settingsTab === 'profile' ? (
              <form className="settings-section" onSubmit={changeOwnPassword}>
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
                <div className="form-grid">
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
                </div>
                <div className="form-actions">
                  <button type="submit" className="primary-button" disabled={settingsBusy}>
                    Update password
                  </button>
                  <button type="button" className="soft-button" onClick={resetProfileDraft}>
                    Clear
                  </button>
                </div>
              </form>
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

      <datalist id="category-suggestions">
        {categoryOptions.map((category) => (
          <option key={category} value={category} />
        ))}
      </datalist>
    </div>
  );
}
