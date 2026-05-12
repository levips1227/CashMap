import fs from 'fs';
import path from 'path';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function sortBy(items, ...selectors) {
  return [...items].sort((left, right) => {
    for (const selector of selectors) {
      const leftValue = selector(left);
      const rightValue = selector(right);
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
    }
    return 0;
  });
}

function createEmptyState() {
  return {
    users: [],
    accounts: [],
    transactions: [],
    recurringRules: [],
    recurringOverrides: [],
    budgets: [],
    reconciliations: [],
    loanPayments: [],
    loanDraws: [],
    adminSettings: {},
    legacyLoanState: null,
    counters: {
      users: 1,
      accounts: 1,
      transactions: 1,
      recurringRules: 1,
      recurringOverrides: 1,
      budgets: 1,
      reconciliations: 1,
      loanPayments: 1,
      loanDraws: 1,
    },
  };
}

function loadState(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return createEmptyState();
  }
  try {
    const raw = fs.readFileSync(dbPath, 'utf8');
    if (!raw.trim()) return createEmptyState();
    const parsed = JSON.parse(raw);
    const base = createEmptyState();
    return {
      ...base,
      ...parsed,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      recurringRules: Array.isArray(parsed.recurringRules) ? parsed.recurringRules : [],
      recurringOverrides: Array.isArray(parsed.recurringOverrides) ? parsed.recurringOverrides : [],
      budgets: Array.isArray(parsed.budgets) ? parsed.budgets : [],
      reconciliations: Array.isArray(parsed.reconciliations) ? parsed.reconciliations : [],
      loanPayments: Array.isArray(parsed.loanPayments) ? parsed.loanPayments : [],
      loanDraws: Array.isArray(parsed.loanDraws) ? parsed.loanDraws : [],
      adminSettings: parsed.adminSettings && typeof parsed.adminSettings === 'object' ? parsed.adminSettings : {},
      legacyLoanState: parsed.legacyLoanState && typeof parsed.legacyLoanState === 'object' ? parsed.legacyLoanState : null,
      counters: {
        ...base.counters,
        ...(parsed.counters || {}),
      },
    };
  } catch (error) {
    console.warn('Failed to read data store, starting with a clean state.', error);
    return createEmptyState();
  }
}

function persist(db) {
  fs.writeFileSync(db.path, JSON.stringify(db.state, null, 2));
}

function nextId(db, key) {
  const next = db.state.counters[key] || 1;
  db.state.counters[key] = next + 1;
  return next;
}

function requireCollection(db, name) {
  if (!Array.isArray(db.state[name])) {
    db.state[name] = [];
  }
  return db.state[name];
}

export function initDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = {
    path: dbPath,
    state: loadState(dbPath),
  };
  persist(db);
  return db;
}

export function listUsers(db) {
  return sortBy(requireCollection(db, 'users'), (user) => user.username_lower)
    .map((user) => ({
      id: user.id,
      username: user.username,
      role: user.role,
      disabled: !!user.disabled,
      createdAt: user.created_at,
    }));
}

export function getUserById(db, id) {
  return requireCollection(db, 'users').find((user) => user.id === Number(id)) || null;
}

export function getUserByUsernameLower(db, usernameLower) {
  return requireCollection(db, 'users').find((user) => user.username_lower === usernameLower) || null;
}

export function createUser(db, { username, usernameLower, passwordHash, role, disabled = 0 }) {
  const user = {
    id: nextId(db, 'users'),
    username,
    username_lower: usernameLower,
    password_hash: passwordHash,
    role,
    disabled: disabled ? 1 : 0,
    created_at: nowIso(),
  };
  requireCollection(db, 'users').push(user);
  persist(db);
  return clone(user);
}

export function updateUser(db, { id, username, usernameLower, role, disabled }) {
  const user = getUserById(db, id);
  if (!user) return null;
  user.username = username;
  user.username_lower = usernameLower;
  user.role = role;
  user.disabled = disabled ? 1 : 0;
  persist(db);
  return clone(user);
}

export function setUserPassword(db, { id, passwordHash }) {
  const user = getUserById(db, id);
  if (!user) return null;
  user.password_hash = passwordHash;
  persist(db);
  return clone(user);
}

export function deleteUser(db, id) {
  db.state.users = requireCollection(db, 'users').filter((user) => user.id !== Number(id));
  persist(db);
}

export function countActiveAdmins(db, excludeId = null) {
  return requireCollection(db, 'users').filter((user) => {
    if (excludeId !== null && user.id === excludeId) return false;
    return user.role === 'Admin' && !user.disabled;
  }).length;
}

export function getAdminSettings(db, defaults = {}) {
  const stored = db.state.adminSettings && typeof db.state.adminSettings === 'object'
    ? db.state.adminSettings
    : {};
  return clone({
    ...defaults,
    ...stored,
  });
}

export function updateAdminSettings(db, settings, defaults = {}) {
  db.state.adminSettings = {
    ...defaults,
    ...settings,
  };
  persist(db);
  return getAdminSettings(db, defaults);
}

export function getLegacyLoanState(db, defaultState) {
  if (!db.state.legacyLoanState || typeof db.state.legacyLoanState !== 'object') {
    db.state.legacyLoanState = clone(defaultState);
    persist(db);
  }
  return clone(db.state.legacyLoanState);
}

export function saveLegacyLoanState(db, state) {
  db.state.legacyLoanState = clone(state);
  persist(db);
  return clone(db.state.legacyLoanState);
}

export function listAccounts(db) {
  return sortBy(
    requireCollection(db, 'accounts'),
    (account) => account.sortOrder,
    (account) => account.name.toLowerCase(),
    (account) => account.id,
  ).map(clone);
}

export function getAccountById(db, id) {
  const account = requireCollection(db, 'accounts').find((item) => item.id === Number(id));
  return account ? clone(account) : null;
}

export function createAccount(db, account) {
  const now = nowIso();
  const record = {
    id: nextId(db, 'accounts'),
    ...clone(account),
    createdAt: now,
    updatedAt: now,
  };
  requireCollection(db, 'accounts').push(record);
  persist(db);
  return clone(record);
}

export function updateAccount(db, id, account) {
  const existing = requireCollection(db, 'accounts').find((item) => item.id === Number(id));
  if (!existing) return null;
  Object.assign(existing, clone(account), { updatedAt: nowIso() });
  persist(db);
  return clone(existing);
}

export function getAccountUsage(db, id) {
  const numericId = Number(id);
  return {
    transactions: requireCollection(db, 'transactions').filter((item) => item.accountId === numericId || item.toAccountId === numericId).length,
    recurringRules: requireCollection(db, 'recurringRules').filter((item) => item.accountId === numericId || item.toAccountId === numericId).length,
    recurringOverrides: requireCollection(db, 'recurringOverrides').filter((item) => item.accountId === numericId || item.toAccountId === numericId).length,
    reconciliations: requireCollection(db, 'reconciliations').filter((item) => item.accountId === numericId).length,
    loanPayments: requireCollection(db, 'loanPayments').filter((item) => item.accountId === numericId).length,
    loanDraws: requireCollection(db, 'loanDraws').filter((item) => item.accountId === numericId).length,
  };
}

export function deleteAccount(db, id) {
  db.state.accounts = requireCollection(db, 'accounts').filter((item) => item.id !== Number(id));
  persist(db);
}

export function listTransactions(db) {
  return sortBy(
    requireCollection(db, 'transactions'),
    (transaction) => transaction.date,
    (transaction) => transaction.createdAt,
    (transaction) => transaction.id,
  ).map(clone);
}

export function getTransactionById(db, id) {
  const transaction = requireCollection(db, 'transactions').find((item) => item.id === Number(id));
  return transaction ? clone(transaction) : null;
}

export function createTransaction(db, transaction) {
  const now = nowIso();
  const record = {
    id: nextId(db, 'transactions'),
    ...clone(transaction),
    createdAt: now,
    updatedAt: now,
  };
  requireCollection(db, 'transactions').push(record);
  persist(db);
  return clone(record);
}

export function updateTransaction(db, id, transaction) {
  const existing = requireCollection(db, 'transactions').find((item) => item.id === Number(id));
  if (!existing) return null;
  Object.assign(existing, clone(transaction), { updatedAt: nowIso() });
  persist(db);
  return clone(existing);
}

export function deleteTransaction(db, id) {
  db.state.transactions = requireCollection(db, 'transactions').filter((item) => item.id !== Number(id));
  persist(db);
}

export function listRecurringRules(db) {
  return sortBy(
    requireCollection(db, 'recurringRules'),
    (rule) => (rule.status === 'active' ? 0 : 1),
    (rule) => rule.startsOn,
    (rule) => rule.title.toLowerCase(),
    (rule) => rule.id,
  ).map(clone);
}

export function getRecurringRuleById(db, id) {
  const rule = requireCollection(db, 'recurringRules').find((item) => item.id === Number(id));
  return rule ? clone(rule) : null;
}

export function createRecurringRule(db, rule) {
  const now = nowIso();
  const record = {
    id: nextId(db, 'recurringRules'),
    ...clone(rule),
    createdAt: now,
    updatedAt: now,
  };
  requireCollection(db, 'recurringRules').push(record);
  persist(db);
  return clone(record);
}

export function updateRecurringRule(db, id, rule) {
  const existing = requireCollection(db, 'recurringRules').find((item) => item.id === Number(id));
  if (!existing) return null;
  Object.assign(existing, clone(rule), { updatedAt: nowIso() });
  persist(db);
  return clone(existing);
}

export function deleteRecurringRule(db, id) {
  const numericId = Number(id);
  db.state.recurringRules = requireCollection(db, 'recurringRules').filter((item) => item.id !== numericId);
  db.state.recurringOverrides = requireCollection(db, 'recurringOverrides').filter((item) => item.ruleId !== numericId);
  db.state.transactions = requireCollection(db, 'transactions').map((transaction) => (
    transaction.recurringRuleId === numericId
      ? { ...transaction, recurringRuleId: null }
      : transaction
  ));
  persist(db);
}

export function listRecurringOverrides(db) {
  return sortBy(
    requireCollection(db, 'recurringOverrides'),
    (override) => override.occurrenceDate,
    (override) => override.ruleId,
    (override) => override.id,
  ).map(clone);
}

export function getRecurringOverrideById(db, id) {
  const override = requireCollection(db, 'recurringOverrides').find((item) => item.id === Number(id));
  return override ? clone(override) : null;
}

export function upsertRecurringOverride(db, overrideInput) {
  const overrides = requireCollection(db, 'recurringOverrides');
  const existing = overrides.find((item) => (
    item.ruleId === overrideInput.ruleId && item.occurrenceDate === overrideInput.occurrenceDate
  ));
  const now = nowIso();
  if (existing) {
    Object.assign(existing, clone(overrideInput), { updatedAt: now });
    persist(db);
    return clone(existing);
  }
  const record = {
    id: nextId(db, 'recurringOverrides'),
    ...clone(overrideInput),
    createdAt: now,
    updatedAt: now,
  };
  overrides.push(record);
  persist(db);
  return clone(record);
}

export function deleteRecurringOverride(db, id) {
  db.state.recurringOverrides = requireCollection(db, 'recurringOverrides').filter((item) => item.id !== Number(id));
  persist(db);
}

export function listBudgets(db) {
  return sortBy(
    requireCollection(db, 'budgets'),
    (budget) => (budget.scope === 'month' ? 1 : 0),
    (budget) => budget.month || '',
    (budget) => budget.direction || '',
    (budget) => budget.category.toLowerCase(),
    (budget) => budget.id,
  ).map(clone);
}

export function getBudgetById(db, id) {
  const budget = requireCollection(db, 'budgets').find((item) => item.id === Number(id));
  return budget ? clone(budget) : null;
}

export function createBudget(db, budget) {
  const now = nowIso();
  const record = {
    id: nextId(db, 'budgets'),
    ...clone(budget),
    createdAt: now,
    updatedAt: now,
  };
  requireCollection(db, 'budgets').push(record);
  persist(db);
  return clone(record);
}

export function updateBudget(db, id, budget) {
  const existing = requireCollection(db, 'budgets').find((item) => item.id === Number(id));
  if (!existing) return null;
  Object.assign(existing, clone(budget), { updatedAt: nowIso() });
  persist(db);
  return clone(existing);
}

export function deleteBudget(db, id) {
  db.state.budgets = requireCollection(db, 'budgets').filter((item) => item.id !== Number(id));
  persist(db);
}

export function listReconciliations(db) {
  return sortBy(
    requireCollection(db, 'reconciliations'),
    (reconciliation) => reconciliation.statementEndingDate,
    (reconciliation) => reconciliation.accountId,
    (reconciliation) => reconciliation.id,
  ).map(clone);
}

export function getReconciliationById(db, id) {
  const reconciliation = requireCollection(db, 'reconciliations').find((item) => item.id === Number(id));
  return reconciliation ? clone(reconciliation) : null;
}

export function createReconciliation(db, reconciliation) {
  const now = nowIso();
  const record = {
    id: nextId(db, 'reconciliations'),
    ...clone(reconciliation),
    createdAt: now,
    updatedAt: now,
  };
  requireCollection(db, 'reconciliations').push(record);
  persist(db);
  return clone(record);
}

export function updateReconciliation(db, id, reconciliation) {
  const existing = requireCollection(db, 'reconciliations').find((item) => item.id === Number(id));
  if (!existing) return null;
  Object.assign(existing, clone(reconciliation), { updatedAt: nowIso() });
  persist(db);
  return clone(existing);
}

export function deleteReconciliation(db, id) {
  db.state.reconciliations = requireCollection(db, 'reconciliations').filter((item) => item.id !== Number(id));
  persist(db);
}

export function listLoanPayments(db) {
  return sortBy(
    requireCollection(db, 'loanPayments'),
    (payment) => payment.paymentDate,
    (payment) => payment.id,
  ).map(clone);
}

export function getLoanPaymentById(db, id) {
  const payment = requireCollection(db, 'loanPayments').find((item) => item.id === Number(id));
  return payment ? clone(payment) : null;
}

export function createLoanPayment(db, payment) {
  const now = nowIso();
  const record = {
    id: nextId(db, 'loanPayments'),
    ...clone(payment),
    postedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  requireCollection(db, 'loanPayments').push(record);
  persist(db);
  return clone(record);
}

export function updateLoanPayment(db, id, payment) {
  const existing = requireCollection(db, 'loanPayments').find((item) => item.id === Number(id));
  if (!existing) return null;
  Object.assign(existing, clone(payment), { updatedAt: nowIso() });
  persist(db);
  return clone(existing);
}

export function deleteLoanPayment(db, id) {
  db.state.loanPayments = requireCollection(db, 'loanPayments').filter((item) => item.id !== Number(id));
  persist(db);
}

export function listLoanDraws(db) {
  return sortBy(
    requireCollection(db, 'loanDraws'),
    (draw) => draw.drawDate,
    (draw) => draw.id,
  ).map(clone);
}

export function getLoanDrawById(db, id) {
  const draw = requireCollection(db, 'loanDraws').find((item) => item.id === Number(id));
  return draw ? clone(draw) : null;
}

export function createLoanDraw(db, draw) {
  const now = nowIso();
  const record = {
    id: nextId(db, 'loanDraws'),
    ...clone(draw),
    createdAt: now,
    updatedAt: now,
  };
  requireCollection(db, 'loanDraws').push(record);
  persist(db);
  return clone(record);
}

export function deleteLoanDraw(db, id) {
  db.state.loanDraws = requireCollection(db, 'loanDraws').filter((item) => item.id !== Number(id));
  persist(db);
}
