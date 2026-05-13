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
    households: [],
    householdMembers: [],
    householdInvites: [],
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
    legacyLoanStates: {},
    counters: {
      users: 1,
      households: 1,
      householdMembers: 1,
      householdInvites: 1,
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
      households: Array.isArray(parsed.households) ? parsed.households : [],
      householdMembers: Array.isArray(parsed.householdMembers) ? parsed.householdMembers : [],
      householdInvites: Array.isArray(parsed.householdInvites) ? parsed.householdInvites : [],
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
      legacyLoanStates: parsed.legacyLoanStates && typeof parsed.legacyLoanStates === 'object' ? parsed.legacyLoanStates : {},
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
      firstName: user.first_name || '',
      lastName: user.last_name || '',
      phone: user.phone || '',
      gender: user.gender || 'Prefer not to say',
      annualHouseholdIncome: user.annual_household_income || '',
      role: user.role,
      disabled: !!user.disabled,
      createdAt: user.created_at,
      activeHouseholdId: user.active_household_id ?? null,
    }));
}

export function getUserById(db, id) {
  return requireCollection(db, 'users').find((user) => user.id === Number(id)) || null;
}

export function getUserByUsernameLower(db, usernameLower) {
  return requireCollection(db, 'users').find((user) => user.username_lower === usernameLower) || null;
}

export function createUser(db, {
  username,
  usernameLower,
  passwordHash,
  role,
  firstName = '',
  lastName = '',
  phone = '',
  gender = 'Prefer not to say',
  annualHouseholdIncome = '',
  disabled = 0,
  activeHouseholdId = null,
}) {
  const user = {
    id: nextId(db, 'users'),
    username,
    username_lower: usernameLower,
    password_hash: passwordHash,
    first_name: firstName,
    last_name: lastName,
    phone,
    gender,
    annual_household_income: annualHouseholdIncome,
    role,
    disabled: disabled ? 1 : 0,
    created_at: nowIso(),
    active_household_id: activeHouseholdId === null ? null : Number(activeHouseholdId),
  };
  requireCollection(db, 'users').push(user);
  persist(db);
  return clone(user);
}

export function updateUser(db, {
  id,
  username,
  usernameLower,
  firstName,
  lastName,
  phone,
  gender,
  annualHouseholdIncome,
  role,
  disabled,
  activeHouseholdId,
}) {
  const user = getUserById(db, id);
  if (!user) return null;
  user.username = username;
  user.username_lower = usernameLower;
  if (firstName !== undefined) user.first_name = firstName;
  if (lastName !== undefined) user.last_name = lastName;
  if (phone !== undefined) user.phone = phone;
  if (gender !== undefined) user.gender = gender;
  if (annualHouseholdIncome !== undefined) user.annual_household_income = annualHouseholdIncome;
  user.role = role;
  user.disabled = disabled ? 1 : 0;
  if (activeHouseholdId !== undefined) {
    user.active_household_id = activeHouseholdId === null ? null : Number(activeHouseholdId);
  }
  persist(db);
  return clone(user);
}

export function setUserActiveHousehold(db, { id, householdId }) {
  const user = getUserById(db, id);
  if (!user) return null;
  user.active_household_id = householdId === null ? null : Number(householdId);
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
  const numericId = Number(id);
  db.state.users = requireCollection(db, 'users').filter((user) => user.id !== numericId);
  db.state.householdMembers = requireCollection(db, 'householdMembers').filter((member) => member.userId !== numericId);
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

export function listHouseholds(db) {
  return sortBy(
    requireCollection(db, 'households'),
    (household) => household.name.toLowerCase(),
    (household) => household.id,
  ).map(clone);
}

export function getHouseholdById(db, id) {
  const household = requireCollection(db, 'households').find((item) => item.id === Number(id));
  return household ? clone(household) : null;
}

export function createHousehold(db, household) {
  const now = nowIso();
  const record = {
    id: nextId(db, 'households'),
    ...clone(household),
    archivedAt: household.archivedAt ?? null,
    archivedByUserId: household.archivedByUserId ?? null,
    purgeAfter: household.purgeAfter ?? null,
    lastActivityAt: household.lastActivityAt ?? now,
    createdAt: now,
    updatedAt: now,
  };
  requireCollection(db, 'households').push(record);
  persist(db);
  return clone(record);
}

export function updateHousehold(db, id, household) {
  const existing = requireCollection(db, 'households').find((item) => item.id === Number(id));
  if (!existing) return null;
  Object.assign(existing, clone(household), { updatedAt: nowIso() });
  persist(db);
  return clone(existing);
}

export function touchHouseholdActivity(db, id, activityAt = nowIso()) {
  const existing = requireCollection(db, 'households').find((item) => item.id === Number(id));
  if (!existing || existing.archivedAt) return existing ? clone(existing) : null;
  existing.lastActivityAt = activityAt;
  existing.updatedAt = nowIso();
  persist(db);
  return clone(existing);
}

export function archiveHousehold(db, id, archive) {
  const existing = requireCollection(db, 'households').find((item) => item.id === Number(id));
  if (!existing) return null;
  existing.archivedAt = archive.archivedAt ?? nowIso();
  existing.archivedByUserId = archive.archivedByUserId ?? null;
  existing.purgeAfter = archive.purgeAfter ?? null;
  existing.updatedAt = nowIso();
  persist(db);
  return clone(existing);
}

export function restoreHousehold(db, id) {
  const existing = requireCollection(db, 'households').find((item) => item.id === Number(id));
  if (!existing) return null;
  existing.archivedAt = null;
  existing.archivedByUserId = null;
  existing.purgeAfter = null;
  existing.updatedAt = nowIso();
  persist(db);
  return clone(existing);
}

export function purgeHousehold(db, id) {
  const numericId = Number(id);
  db.state.households = requireCollection(db, 'households').filter((item) => item.id !== numericId);
  db.state.householdMembers = requireCollection(db, 'householdMembers').filter((item) => item.householdId !== numericId);
  db.state.householdInvites = requireCollection(db, 'householdInvites').filter((item) => item.householdId !== numericId);
  db.state.accounts = requireCollection(db, 'accounts').filter((item) => item.householdId !== numericId);
  db.state.transactions = requireCollection(db, 'transactions').filter((item) => item.householdId !== numericId);
  db.state.recurringRules = requireCollection(db, 'recurringRules').filter((item) => item.householdId !== numericId);
  db.state.recurringOverrides = requireCollection(db, 'recurringOverrides').filter((item) => item.householdId !== numericId);
  db.state.budgets = requireCollection(db, 'budgets').filter((item) => item.householdId !== numericId);
  db.state.reconciliations = requireCollection(db, 'reconciliations').filter((item) => item.householdId !== numericId);
  db.state.loanPayments = requireCollection(db, 'loanPayments').filter((item) => item.householdId !== numericId);
  db.state.loanDraws = requireCollection(db, 'loanDraws').filter((item) => item.householdId !== numericId);
  if (db.state.legacyLoanStates && typeof db.state.legacyLoanStates === 'object') {
    delete db.state.legacyLoanStates[String(numericId)];
  }
  requireCollection(db, 'users').forEach((user) => {
    if (user.active_household_id === numericId) {
      user.active_household_id = null;
    }
  });
  persist(db);
}

export function listHouseholdMembers(db, householdId = null) {
  const members = requireCollection(db, 'householdMembers')
    .filter((member) => householdId === null || member.householdId === Number(householdId));
  return sortBy(
    members,
    (member) => member.householdId,
    (member) => member.role,
    (member) => member.userId,
    (member) => member.id,
  ).map(clone);
}

export function listHouseholdMembershipsForUser(db, userId) {
  return listHouseholdMembers(db).filter((member) => member.userId === Number(userId));
}

export function getHouseholdMemberById(db, id) {
  const member = requireCollection(db, 'householdMembers').find((item) => item.id === Number(id));
  return member ? clone(member) : null;
}

export function getHouseholdMembership(db, householdId, userId) {
  const member = requireCollection(db, 'householdMembers').find((item) => (
    item.householdId === Number(householdId) && item.userId === Number(userId)
  ));
  return member ? clone(member) : null;
}

export function createHouseholdMember(db, member) {
  const now = nowIso();
  const record = {
    id: nextId(db, 'householdMembers'),
    ...clone(member),
    createdAt: now,
    updatedAt: now,
  };
  requireCollection(db, 'householdMembers').push(record);
  persist(db);
  return clone(record);
}

export function updateHouseholdMember(db, id, member) {
  const existing = requireCollection(db, 'householdMembers').find((item) => item.id === Number(id));
  if (!existing) return null;
  Object.assign(existing, clone(member), { updatedAt: nowIso() });
  persist(db);
  return clone(existing);
}

export function deleteHouseholdMember(db, id) {
  db.state.householdMembers = requireCollection(db, 'householdMembers').filter((item) => item.id !== Number(id));
  persist(db);
}

export function countHouseholdOwners(db, householdId, excludeMemberId = null) {
  return requireCollection(db, 'householdMembers').filter((member) => {
    if (member.householdId !== Number(householdId)) return false;
    if (excludeMemberId !== null && member.id === Number(excludeMemberId)) return false;
    return member.role === 'Owner';
  }).length;
}

export function listHouseholdInvites(db, householdId = null) {
  const invites = requireCollection(db, 'householdInvites')
    .filter((invite) => householdId === null || invite.householdId === Number(householdId));
  return sortBy(
    invites,
    (invite) => invite.usedAt ? 1 : 0,
    (invite) => invite.expiresAt,
    (invite) => invite.id,
  ).map(clone);
}

export function getHouseholdInviteById(db, id) {
  const invite = requireCollection(db, 'householdInvites').find((item) => item.id === Number(id));
  return invite ? clone(invite) : null;
}

export function getHouseholdInviteByTokenHash(db, tokenHash) {
  const invite = requireCollection(db, 'householdInvites').find((item) => item.tokenHash === tokenHash);
  return invite ? clone(invite) : null;
}

export function createHouseholdInvite(db, invite) {
  const now = nowIso();
  const record = {
    id: nextId(db, 'householdInvites'),
    ...clone(invite),
    createdAt: now,
    updatedAt: now,
  };
  requireCollection(db, 'householdInvites').push(record);
  persist(db);
  return clone(record);
}

export function updateHouseholdInvite(db, id, invite) {
  const existing = requireCollection(db, 'householdInvites').find((item) => item.id === Number(id));
  if (!existing) return null;
  Object.assign(existing, clone(invite), { updatedAt: nowIso() });
  persist(db);
  return clone(existing);
}

export function deleteHouseholdInvite(db, id) {
  db.state.householdInvites = requireCollection(db, 'householdInvites').filter((item) => item.id !== Number(id));
  persist(db);
}

export function getLegacyLoanState(db, householdId, defaultState) {
  if (!db.state.legacyLoanStates || typeof db.state.legacyLoanStates !== 'object') {
    db.state.legacyLoanStates = {};
  }
  const key = String(householdId);
  if (!db.state.legacyLoanStates[key] || typeof db.state.legacyLoanStates[key] !== 'object') {
    db.state.legacyLoanStates[key] = clone(defaultState);
    persist(db);
  }
  return clone(db.state.legacyLoanStates[key]);
}

export function saveLegacyLoanState(db, householdId, state) {
  if (!db.state.legacyLoanStates || typeof db.state.legacyLoanStates !== 'object') {
    db.state.legacyLoanStates = {};
  }
  db.state.legacyLoanStates[String(householdId)] = clone(state);
  persist(db);
  return clone(db.state.legacyLoanStates[String(householdId)]);
}

function withHouseholdFilter(items, householdId = null) {
  if (householdId === null || householdId === undefined) return items;
  return items.filter((item) => item.householdId === Number(householdId));
}

export function listAccounts(db, householdId = null) {
  return sortBy(
    withHouseholdFilter(requireCollection(db, 'accounts'), householdId),
    (account) => account.sortOrder,
    (account) => account.name.toLowerCase(),
    (account) => account.id,
  ).map(clone);
}

export function getAccountById(db, id, householdId = null) {
  const account = withHouseholdFilter(requireCollection(db, 'accounts'), householdId)
    .find((item) => item.id === Number(id));
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

export function getAccountUsage(db, id, householdId = null) {
  const numericId = Number(id);
  const byHousehold = (collectionName) => withHouseholdFilter(requireCollection(db, collectionName), householdId);
  return {
    transactions: byHousehold('transactions').filter((item) => item.accountId === numericId || item.toAccountId === numericId).length,
    recurringRules: byHousehold('recurringRules').filter((item) => item.accountId === numericId || item.toAccountId === numericId).length,
    recurringOverrides: byHousehold('recurringOverrides').filter((item) => item.accountId === numericId || item.toAccountId === numericId).length,
    reconciliations: byHousehold('reconciliations').filter((item) => item.accountId === numericId).length,
    loanPayments: byHousehold('loanPayments').filter((item) => item.accountId === numericId).length,
    loanDraws: byHousehold('loanDraws').filter((item) => item.accountId === numericId).length,
  };
}

export function deleteAccount(db, id) {
  db.state.accounts = requireCollection(db, 'accounts').filter((item) => item.id !== Number(id));
  persist(db);
}

export function listTransactions(db, householdId = null) {
  return sortBy(
    withHouseholdFilter(requireCollection(db, 'transactions'), householdId),
    (transaction) => transaction.date,
    (transaction) => transaction.createdAt,
    (transaction) => transaction.id,
  ).map(clone);
}

export function getTransactionById(db, id, householdId = null) {
  const transaction = withHouseholdFilter(requireCollection(db, 'transactions'), householdId)
    .find((item) => item.id === Number(id));
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

export function listRecurringRules(db, householdId = null) {
  return sortBy(
    withHouseholdFilter(requireCollection(db, 'recurringRules'), householdId),
    (rule) => (rule.status === 'active' ? 0 : 1),
    (rule) => rule.startsOn,
    (rule) => rule.title.toLowerCase(),
    (rule) => rule.id,
  ).map(clone);
}

export function getRecurringRuleById(db, id, householdId = null) {
  const rule = withHouseholdFilter(requireCollection(db, 'recurringRules'), householdId)
    .find((item) => item.id === Number(id));
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

export function listRecurringOverrides(db, householdId = null) {
  return sortBy(
    withHouseholdFilter(requireCollection(db, 'recurringOverrides'), householdId),
    (override) => override.occurrenceDate,
    (override) => override.ruleId,
    (override) => override.id,
  ).map(clone);
}

export function getRecurringOverrideById(db, id, householdId = null) {
  const override = withHouseholdFilter(requireCollection(db, 'recurringOverrides'), householdId)
    .find((item) => item.id === Number(id));
  return override ? clone(override) : null;
}

export function upsertRecurringOverride(db, overrideInput) {
  const overrides = requireCollection(db, 'recurringOverrides');
  const existing = overrides.find((item) => (
    item.ruleId === overrideInput.ruleId
    && item.occurrenceDate === overrideInput.occurrenceDate
    && item.householdId === overrideInput.householdId
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

export function listBudgets(db, householdId = null) {
  return sortBy(
    withHouseholdFilter(requireCollection(db, 'budgets'), householdId),
    (budget) => (budget.scope === 'month' ? 1 : 0),
    (budget) => budget.month || '',
    (budget) => budget.direction || '',
    (budget) => budget.category.toLowerCase(),
    (budget) => budget.id,
  ).map(clone);
}

export function getBudgetById(db, id, householdId = null) {
  const budget = withHouseholdFilter(requireCollection(db, 'budgets'), householdId)
    .find((item) => item.id === Number(id));
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

export function listReconciliations(db, householdId = null) {
  return sortBy(
    withHouseholdFilter(requireCollection(db, 'reconciliations'), householdId),
    (reconciliation) => reconciliation.statementEndingDate,
    (reconciliation) => reconciliation.accountId,
    (reconciliation) => reconciliation.id,
  ).map(clone);
}

export function getReconciliationById(db, id, householdId = null) {
  const reconciliation = withHouseholdFilter(requireCollection(db, 'reconciliations'), householdId)
    .find((item) => item.id === Number(id));
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

export function listLoanPayments(db, householdId = null) {
  return sortBy(
    withHouseholdFilter(requireCollection(db, 'loanPayments'), householdId),
    (payment) => payment.paymentDate,
    (payment) => payment.id,
  ).map(clone);
}

export function getLoanPaymentById(db, id, householdId = null) {
  const payment = withHouseholdFilter(requireCollection(db, 'loanPayments'), householdId)
    .find((item) => item.id === Number(id));
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

export function listLoanDraws(db, householdId = null) {
  return sortBy(
    withHouseholdFilter(requireCollection(db, 'loanDraws'), householdId),
    (draw) => draw.drawDate,
    (draw) => draw.id,
  ).map(clone);
}

export function getLoanDrawById(db, id, householdId = null) {
  const draw = withHouseholdFilter(requireCollection(db, 'loanDraws'), householdId)
    .find((item) => item.id === Number(id));
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

export function updateLoanDraw(db, id, draw) {
  const existing = requireCollection(db, 'loanDraws').find((item) => item.id === Number(id));
  if (!existing) return null;
  Object.assign(existing, clone(draw), { updatedAt: nowIso() });
  persist(db);
  return clone(existing);
}

export function deleteLoanDraw(db, id) {
  db.state.loanDraws = requireCollection(db, 'loanDraws').filter((item) => item.id !== Number(id));
  persist(db);
}
