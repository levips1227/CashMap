import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initDb,
  listAccounts,
  getAccountById,
  createAccount,
  updateAccount,
  getAccountUsage,
  deleteAccount,
  listTransactions,
  getTransactionById,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  listRecurringRules,
  getRecurringRuleById,
  createRecurringRule,
  updateRecurringRule,
  deleteRecurringRule,
  listRecurringOverrides,
  getRecurringOverrideById,
  upsertRecurringOverride,
  deleteRecurringOverride,
  listBudgets,
  getBudgetById,
  createBudget,
  updateBudget,
  deleteBudget,
  listReconciliations,
  getReconciliationById,
  createReconciliation,
  updateReconciliation,
  deleteReconciliation,
  listLoanPayments,
  getLoanPaymentById,
  createLoanPayment,
  updateLoanPayment,
  deleteLoanPayment,
  listLoanDraws,
  getLoanDrawById,
  createLoanDraw,
  updateLoanDraw,
  deleteLoanDraw,
  listUsers,
  getUserById,
  getUserByUsernameLower,
  createUser,
  updateUser,
  setUserActiveHousehold,
  setUserPassword,
  deleteUser,
  countActiveAdmins,
  getAdminSettings,
  updateAdminSettings,
  listHouseholds,
  getHouseholdById,
  createHousehold,
  updateHousehold,
  touchHouseholdActivity,
  archiveHousehold,
  restoreHousehold,
  purgeHousehold,
  listHouseholdMembers,
  listHouseholdMembershipsForUser,
  getHouseholdMemberById,
  getHouseholdMembership,
  createHouseholdMember,
  updateHouseholdMember,
  deleteHouseholdMember,
  countHouseholdOwners,
  listHouseholdInvites,
  getHouseholdInviteByTokenHash,
  createHouseholdInvite,
  updateHouseholdInvite,
  getLegacyLoanState,
  saveLegacyLoanState,
} from './db.js';
import { accountColorPalette, defaultAdminSettings } from './defaultState.js';
import {
  defaultAdminSettings as legacyLoanAdminDefaults,
  defaultState as legacyLoanDefaultState,
} from './legacyLoanDefaultState.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'budget-app.json');
const JWT_SECRET = process.env.JWT_SECRET || '';
const FALLBACK_JWT_SECRET = JWT_SECRET || 'dev-insecure-change-me';
const NODE_ENV = process.env.NODE_ENV || 'development';
const PASSWORD_MIN_LENGTH = 8;
const HOUSEHOLD_ROLES = ['Owner', 'Member', 'Viewer'];
const GENDER_OPTIONS = ['Male', 'Female', 'Nonbinary', 'Other', 'Prefer not to say'];
const INCOME_BRACKETS = Array.from({ length: 10 }, (_, index) => {
  const start = index * 20000;
  const end = start + 19999;
  return `$${start.toLocaleString()} - $${end.toLocaleString()}`;
}).concat('$200,000+');
const HOUSEHOLD_INVITE_TTL_DAYS = 7;
const HOUSEHOLD_ARCHIVE_RETENTION_DAYS = 30;
const HOUSEHOLD_ABANDONED_DAYS = 180;
const RESET_ADMIN_ON_START = process.env.RESET_ADMIN_ON_START === 'true';
const COOKIE_SECURE = process.env.COOKIE_SECURE === undefined
  ? NODE_ENV === 'production'
  : process.env.COOKIE_SECURE === 'true';

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const db = initDb(DB_PATH);

function normalizeUsername(name) {
  return (name || '').trim().replace(/\s+/g, ' ');
}

function sanitizeUser(user) {
  return {
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
  };
}

function createInviteToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashInviteToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function validationError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function assert(condition, message) {
  if (!condition) {
    throw validationError(message);
  }
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function normalizeRequiredText(value, fieldName) {
  const normalized = normalizeText(value);
  assert(normalized.length > 0, `${fieldName} is required.`);
  return normalized;
}

function normalizeOptionalDate(value) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeDate(value, 'Date');
}

function normalizeDate(value, fieldName) {
  const normalized = normalizeText(value);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(normalized), `${fieldName} must use YYYY-MM-DD.`);
  return normalized;
}

function normalizeMoney(value, fieldName) {
  const amount = Number(value);
  assert(Number.isFinite(amount), `${fieldName} must be a valid number.`);
  return roundMoney(amount);
}

function normalizePositiveMoney(value, fieldName) {
  const amount = normalizeMoney(value, fieldName);
  assert(amount >= 0, `${fieldName} must be zero or greater.`);
  return amount;
}

function normalizeInteger(value, fieldName, { min = null, max = null, nullable = false } = {}) {
  if (nullable && (value === undefined || value === null || value === '')) return null;
  const normalized = Number(value);
  assert(Number.isInteger(normalized), `${fieldName} must be a whole number.`);
  if (min !== null) assert(normalized >= min, `${fieldName} must be at least ${min}.`);
  if (max !== null) assert(normalized <= max, `${fieldName} must be at most ${max}.`);
  return normalized;
}

function normalizeBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return defaultValue;
}

function normalizeDirection(value) {
  const direction = normalizeRequiredText(value, 'Direction').toLowerCase();
  assert(['income', 'expense', 'transfer'].includes(direction), 'Direction must be income, expense, or transfer.');
  return direction;
}

function normalizeStatus(value) {
  const status = normalizeRequiredText(value, 'Status').toLowerCase();
  assert(['projected', 'actual', 'cleared'].includes(status), 'Status must be projected, actual, or cleared.');
  return status;
}

function normalizeMonthKey(value, fieldName = 'Month') {
  const normalized = normalizeRequiredText(value, fieldName);
  assert(/^\d{4}-\d{2}$/.test(normalized), `${fieldName} must use YYYY-MM.`);
  return normalized;
}

function normalizeFrequencyUnit(value) {
  const unit = normalizeRequiredText(value, 'Frequency unit').toLowerCase();
  assert(['day', 'week', 'month'].includes(unit), 'Frequency unit must be day, week, or month.');
  return unit;
}

function normalizeRuleStatus(value) {
  const status = normalizeRequiredText(value, 'Rule status').toLowerCase();
  assert(['active', 'paused'].includes(status), 'Rule status must be active or paused.');
  return status;
}

function normalizeAccountType(value) {
  const type = normalizeText(value, 'Checking');
  return type || 'Checking';
}

function normalizeTrackingType(value) {
  const type = normalizeText(value, 'cash').toLowerCase();
  assert(['cash', 'loan'].includes(type), 'Tracking type must be cash or loan.');
  return type;
}

function normalizeLoanPaymentFrequency(value) {
  const frequency = normalizeText(value, 'Monthly');
  assert(['Monthly', 'Biweekly', 'Weekly', 'Quarterly', 'Annual'].includes(frequency), 'Loan payment frequency is not supported.');
  return frequency;
}

function normalizeStringList(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : String(value || '')
      .split(',')
      .map((item) => item.trim());
  const seen = new Set();
  const list = [];
  for (const item of source) {
    const text = normalizeText(item);
    const key = text.toLowerCase();
    if (text && !seen.has(key)) {
      seen.add(key);
      list.push(text);
    }
  }
  return list.length ? list : fallback;
}

function normalizeAdminSettingsPayload(body, existing = defaultAdminSettings) {
  const cashWarningThreshold = normalizeMoney(
    body?.cashWarningThreshold ?? existing.cashWarningThreshold ?? defaultAdminSettings.cashWarningThreshold,
    'Default cash warning threshold',
  );
  assert(cashWarningThreshold >= 0, 'Default cash warning threshold must be zero or more.');
  const loanPaymentFrequencies = normalizeStringList(
    body?.loanPaymentFrequencies ?? existing.loanPaymentFrequencies,
    defaultAdminSettings.loanPaymentFrequencies,
  ).filter((frequency) => ['Monthly', 'Biweekly', 'Weekly', 'Quarterly', 'Annual'].includes(frequency));
  return {
    ...existing,
    cashWarningThreshold,
    cashAccountTypes: normalizeStringList(body?.cashAccountTypes ?? existing.cashAccountTypes, defaultAdminSettings.cashAccountTypes),
    loanAccountTypes: normalizeStringList(body?.loanAccountTypes ?? existing.loanAccountTypes, defaultAdminSettings.loanAccountTypes),
    loanPaymentFrequencies: loanPaymentFrequencies.length ? loanPaymentFrequencies : defaultAdminSettings.loanPaymentFrequencies,
    categorySuggestions: normalizeStringList(
      body?.categorySuggestions ?? existing.categorySuggestions,
      defaultAdminSettings.categorySuggestions,
    ),
  };
}

function normalizeBudgetDirection(value) {
  const direction = normalizeRequiredText(value, 'Budget direction').toLowerCase();
  assert(['expense', 'income'].includes(direction), 'Budget direction must be expense or income.');
  return direction;
}

function normalizeBudgetMode(value) {
  const mode = normalizeRequiredText(value, 'Budget mode').toLowerCase();
  assert(['limit', 'goal'].includes(mode), 'Budget mode must be limit or goal.');
  return mode;
}

function normalizeBudgetScope(value) {
  const scope = normalizeText(value || 'default').toLowerCase();
  assert(['default', 'month'].includes(scope), 'Budget scope must be default or month.');
  return scope;
}

function normalizeGender(value, fieldName = 'Gender') {
  const gender = normalizeText(value || 'Prefer not to say', 'Prefer not to say');
  assert(GENDER_OPTIONS.includes(gender), `${fieldName} is not supported.`);
  return gender;
}

function normalizeAnnualIncome(value, fieldName = 'Annual household income') {
  const income = normalizeText(value);
  if (!income) return '';
  assert(INCOME_BRACKETS.includes(income), `${fieldName} is not supported.`);
  return income;
}

function normalizePhone(value) {
  return normalizeText(value).replace(/[^\d()+\-\s.]/g, '');
}

function normalizeUserProfilePayload(body, existing = null, { requireNames = true } = {}) {
  const firstNameValue = body?.firstName ?? existing?.first_name ?? existing?.firstName ?? '';
  const lastNameValue = body?.lastName ?? existing?.last_name ?? existing?.lastName ?? '';
  return {
    firstName: requireNames ? normalizeRequiredText(firstNameValue, 'First name') : normalizeText(firstNameValue),
    lastName: requireNames ? normalizeRequiredText(lastNameValue, 'Last name') : normalizeText(lastNameValue),
    phone: normalizePhone(body?.phone ?? existing?.phone ?? ''),
    gender: normalizeGender(body?.gender ?? existing?.gender ?? 'Prefer not to say'),
    annualHouseholdIncome: normalizeAnnualIncome(body?.annualHouseholdIncome ?? existing?.annual_household_income ?? existing?.annualHouseholdIncome ?? ''),
  };
}

function normalizeHouseholdRole(value, fieldName = 'Household role') {
  const role = normalizeRequiredText(value, fieldName);
  assert(HOUSEHOLD_ROLES.includes(role), `${fieldName} must be Owner, Member, or Viewer.`);
  return role;
}

function sendError(res, error) {
  const status = error?.status || 500;
  const message = status === 500 ? 'Unexpected server error.' : error.message;
  if (status === 500) {
    console.error(error);
  }
  return res.status(status).json({ error: message });
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function daysFromNowIso(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function getHouseholdStatus(household) {
  if (household.archivedAt) return 'archived';
  const lastActivityAt = household.lastActivityAt || household.updatedAt || household.createdAt;
  if (lastActivityAt && lastActivityAt < daysAgoIso(HOUSEHOLD_ABANDONED_DAYS)) {
    return 'abandoned';
  }
  return 'active';
}

function purgeExpiredArchivedHouseholds() {
  listHouseholds(db)
    .filter((household) => household.archivedAt && household.purgeAfter && household.purgeAfter < new Date().toISOString())
    .forEach((household) => purgeHousehold(db, household.id));
}

function sanitizeHousehold(household, access = null) {
  return {
    id: household.id,
    name: household.name,
    createdAt: household.createdAt,
    updatedAt: household.updatedAt,
    lastActivityAt: household.lastActivityAt || household.updatedAt || household.createdAt,
    archivedAt: household.archivedAt || null,
    purgeAfter: household.purgeAfter || null,
    status: getHouseholdStatus(household),
    role: access?.role || null,
    canEdit: !!access?.canEdit,
    canManage: !!access?.canManage,
    isAdminSupport: !!access?.isAdmin,
  };
}

function sanitizeHouseholdMember(member) {
  const user = getUserById(db, member.userId);
  if (!user) return null;
  return {
    id: member.id,
    householdId: member.householdId,
    userId: user.id,
    username: user.username,
    firstName: user.first_name || '',
    lastName: user.last_name || '',
    phone: user.phone || '',
    gender: user.gender || 'Prefer not to say',
    annualHouseholdIncome: user.annual_household_income || '',
    appRole: user.role,
    disabled: !!user.disabled,
    role: member.role,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

function sanitizeHouseholdInvite(invite, req = null) {
  const creator = invite.createdByUserId ? getUserById(db, invite.createdByUserId) : null;
  const expired = invite.expiresAt < new Date().toISOString();
  return {
    id: invite.id,
    householdId: invite.householdId,
    role: invite.role,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
    createdByUserId: invite.createdByUserId ?? null,
    createdByUsername: creator?.username || '',
    usedAt: invite.usedAt ?? null,
    usedByUserId: invite.usedByUserId ?? null,
    expired,
    status: invite.usedAt ? 'used' : expired ? 'expired' : 'pending',
    inviteUrl: invite.token && req ? buildInviteUrl(req, invite.token) : undefined,
  };
}

function getHouseholdOwnerUsers(householdId) {
  return listHouseholdMembers(db, householdId)
    .filter((member) => member.role === 'Owner')
    .map((member) => getUserById(db, member.userId))
    .filter(Boolean);
}

function buildHouseholdMetrics(householdId) {
  return {
    memberCount: listHouseholdMembers(db, householdId).length,
    accountCount: listAccounts(db, householdId).length,
    transactionCount: listTransactions(db, householdId).length,
    recurringRuleCount: listRecurringRules(db, householdId).length,
    budgetCount: listBudgets(db, householdId).length,
  };
}

function sanitizeAdminHouseholdRow(household, currentUserId) {
  const owners = getHouseholdOwnerUsers(household.id);
  const primaryOwner = owners[0] || null;
  const membership = getHouseholdMembership(db, household.id, currentUserId);
  const metrics = buildHouseholdMetrics(household.id);
  return {
    ...sanitizeHousehold(household),
    ownerUsername: primaryOwner?.username || '',
    ownerFirstName: primaryOwner?.first_name || '',
    ownerLastName: primaryOwner?.last_name || '',
    ownerNames: owners.map((owner) => owner.username),
    isCurrentUserMember: Boolean(membership),
    currentUserMembershipId: membership?.id ?? null,
    currentUserRole: membership?.role || null,
    ...metrics,
  };
}

function buildInviteUrl(req, token) {
  const protocol = req.protocol || 'http';
  const host = req.get('host') || `localhost:${PORT}`;
  return `${protocol}://${host}/?invite=${encodeURIComponent(token)}`;
}

function listAccessibleHouseholdsForUser(user) {
  return listHouseholdMembershipsForUser(db, user.id)
    .map((membership) => {
      const household = getHouseholdById(db, membership.householdId);
      if (!household || household.archivedAt) return null;
      return {
        household,
        membership,
        role: membership.role,
        canEdit: membership.role === 'Owner' || membership.role === 'Member',
        canManage: membership.role === 'Owner',
        isAdmin: false,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.household.name.localeCompare(right.household.name) || left.household.id - right.household.id);
}

function getHouseholdAccess(user, householdId) {
  const household = getHouseholdById(db, householdId);
  if (!household) return null;
  if (user.role === 'Admin') {
    const membership = getHouseholdMembership(db, household.id, user.id);
    return {
      household,
      membership,
      role: 'Admin',
      canEdit: true,
      canManage: true,
      isAdmin: true,
    };
  }
  if (household.archivedAt) return null;
  const membership = getHouseholdMembership(db, household.id, user.id);
  if (!membership) return null;
  return {
    household,
    membership,
    role: membership.role,
    canEdit: membership.role === 'Owner' || membership.role === 'Member',
    canManage: membership.role === 'Owner',
    isAdmin: false,
  };
}

function ensureUserActiveHousehold(user) {
  const stored = getUserById(db, user.id);
  if (!stored || stored.disabled) {
    return { user: null, access: null, households: [] };
  }
  const accessible = listAccessibleHouseholdsForUser(stored);
  const preferredId = stored.active_household_id ?? null;
  const preferredHousehold = preferredId
    ? accessible.find((item) => item.household.id === preferredId)?.household || null
    : null;
  let access = preferredHousehold ? getHouseholdAccess(stored, preferredHousehold.id) : null;
  if (!access && accessible.length > 0) {
    const nextHouseholdId = accessible[0].household.id;
    const updated = setUserActiveHousehold(db, { id: stored.id, householdId: nextHouseholdId });
    return {
      user: updated,
      access: getHouseholdAccess(updated, nextHouseholdId),
      households: accessible,
    };
  }
  if (!access && preferredId !== null) {
    const updated = setUserActiveHousehold(db, { id: stored.id, householdId: null });
    return {
      user: updated,
      access: null,
      households: accessible,
    };
  }
  return { user: stored, access, households: accessible };
}

function requireActiveHousehold(req, res, next) {
  if (!req.activeHouseholdAccess?.household) {
    return res.status(400).json({ error: 'Create or join a household before using this part of CashMap.' });
  }
  return next();
}

function requireHouseholdWriteAccess(req, res, next) {
  if (!req.activeHouseholdAccess?.household) {
    return res.status(400).json({ error: 'Create or join a household before using this part of CashMap.' });
  }
  if (!req.activeHouseholdAccess.canEdit) {
    return res.status(403).json({ error: 'This household is view-only for your account.' });
  }
  return next();
}

function assertHouseholdManageAccess(user, householdId) {
  const access = getHouseholdAccess(user, householdId);
  assert(access, 'Household not found or not accessible.');
  assert(access.canManage, 'Only the household owner or an admin can manage members and invites.');
  return access;
}

function assertHouseholdReadAccess(user, householdId) {
  const access = getHouseholdAccess(user, householdId);
  assert(access, 'Household not found or not accessible.');
  return access;
}

function getJwtSecret() {
  return FALLBACK_JWT_SECRET;
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    getJwtSecret(),
    { expiresIn: '7d' },
  );
}

function setSessionCookie(res, user) {
  const token = signToken(user);
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie('session', {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
  });
}

function getUserFromRequest(req) {
  const token = req.cookies?.session;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getJwtSecret());
    const user = getUserById(db, payload.id);
    if (!user || user.disabled) return null;
    return user;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const resolved = ensureUserActiveHousehold(user);
  if (!resolved.user) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = resolved.user;
  req.activeHouseholdAccess = resolved.access;
  req.accessibleHouseholds = resolved.households;
  return next();
}

function requireAdmin(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (user.role !== 'Admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.user = user;
  return next();
}

function ensureDefaultAdmin() {
  const admins = countActiveAdmins(db);
  if (admins > 0 && !RESET_ADMIN_ON_START) return;
  const username = normalizeUsername(process.env.ADMIN_USERNAME || 'Admin');
  const usingDefaultPassword = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || 'change-me-please';
  if (!username || !password || password.length < PASSWORD_MIN_LENGTH) {
    console.warn('Default admin not created: set ADMIN_USERNAME and ADMIN_PASSWORD (min 8 chars).');
    return;
  }
  const passwordHash = bcrypt.hashSync(password, 10);
  const existing = getUserByUsernameLower(db, username.toLowerCase());
  if (existing) {
    setUserPassword(db, { id: existing.id, passwordHash });
    updateUser(db, {
      id: existing.id,
      username,
      usernameLower: username.toLowerCase(),
      role: 'Admin',
      disabled: 0,
    });
  } else {
    createUser(db, {
      username,
      usernameLower: username.toLowerCase(),
      passwordHash,
      role: 'Admin',
      disabled: 0,
    });
  }
  if (usingDefaultPassword) {
    console.warn('Using default admin password. Set ADMIN_PASSWORD before production.');
  }
}

function createOwnedHouseholdForUser(user, name = 'My Household') {
  const household = createHousehold(db, {
    name: normalizeText(name, 'My Household') || 'My Household',
    createdByUserId: user.id,
  });
  createHouseholdMember(db, {
    householdId: household.id,
    userId: user.id,
    role: 'Owner',
  });
  setUserActiveHousehold(db, { id: user.id, householdId: household.id });
  return household;
}

function migrateLegacyDataIntoHouseholds() {
  const existingHouseholds = listHouseholds(db);
  const recordsNeedMigration = [
    ...listAccounts(db),
    ...listTransactions(db),
    ...listRecurringRules(db),
    ...listRecurringOverrides(db),
    ...listBudgets(db),
    ...listReconciliations(db),
    ...listLoanPayments(db),
    ...listLoanDraws(db),
  ].some((record) => !record.householdId);

  const needsLegacyLoanMigration = !!db.state.legacyLoanState && Object.keys(db.state.legacyLoanStates || {}).length === 0;
  if (existingHouseholds.length > 0 && !recordsNeedMigration && !needsLegacyLoanMigration) {
    return;
  }

  let owner = getUserByUsernameLower(db, 'levips1227');
  if (!owner) {
    owner = getUserByUsernameLower(db, 'levips1227'.toLowerCase())
      || getUserByUsernameLower(db, 'admin')
      || getUserById(db, 1)
      || null;
  }
  if (!owner) return;

  let household = existingHouseholds[0] || null;
  if (!household) {
    household = createOwnedHouseholdForUser(owner, 'My Household');
  } else if (!getHouseholdMembership(db, household.id, owner.id)) {
    createHouseholdMember(db, {
      householdId: household.id,
      userId: owner.id,
      role: 'Owner',
    });
    setUserActiveHousehold(db, { id: owner.id, householdId: household.id });
  }

  const householdId = household.id;
  listAccounts(db).forEach((account) => {
    if (!account.householdId) updateAccount(db, account.id, { ...account, householdId });
  });
  listTransactions(db).forEach((transaction) => {
    if (!transaction.householdId) updateTransaction(db, transaction.id, { ...transaction, householdId });
  });
  listRecurringRules(db).forEach((rule) => {
    if (!rule.householdId) updateRecurringRule(db, rule.id, { ...rule, householdId });
  });
  listRecurringOverrides(db).forEach((override) => {
    if (!override.householdId) upsertRecurringOverride(db, { ...override, householdId });
  });
  listBudgets(db).forEach((budget) => {
    if (!budget.householdId) updateBudget(db, budget.id, { ...budget, householdId });
  });
  listReconciliations(db).forEach((reconciliation) => {
    if (!reconciliation.householdId) updateReconciliation(db, reconciliation.id, { ...reconciliation, householdId });
  });
  listLoanPayments(db).forEach((payment) => {
    if (!payment.householdId) updateLoanPayment(db, payment.id, { ...payment, householdId });
  });
  listLoanDraws(db).forEach((draw) => {
    if (!draw.householdId) {
      updateLoanDraw(db, draw.id, { ...draw, householdId });
    }
  });
  if (needsLegacyLoanMigration) {
    saveLegacyLoanState(db, householdId, normalizeLegacyLoanState(db.state.legacyLoanState || {}));
    db.state.legacyLoanState = null;
    fs.writeFileSync(DB_PATH, JSON.stringify(db.state, null, 2));
  }
}

function ensureAccountExists(id, label, householdId) {
  const account = getAccountById(db, id, householdId);
  assert(account, `${label} was not found.`);
  return account;
}

function ensureCashAccountExists(id, label, householdId) {
  const account = ensureAccountExists(id, label, householdId);
  assert(account.trackingType !== 'loan', `${label} must be a cash account.`);
  return account;
}

function normalizeLoanDetailsPayload(body, existing = null) {
  const currentBalance = normalizePositiveMoney(body?.currentBalance ?? existing?.currentBalance ?? 0, 'Current balance');
  const originalPrincipal = normalizePositiveMoney(
    body?.originalPrincipal ?? existing?.originalPrincipal ?? currentBalance,
    'Original principal',
  );
  assert(originalPrincipal >= currentBalance, 'Original principal must be at least the current balance.');
  const termMonths = normalizeInteger(body?.termMonths ?? existing?.termMonths ?? 360, 'Loan term', { min: 1, max: 1200 });
  const aprPercent = normalizeMoney(body?.aprPercent ?? existing?.aprPercent ?? 0, 'APR');
  assert(aprPercent >= 0 && aprPercent <= 100, 'APR must be between 0 and 100.');
  const minimumPayment = normalizePositiveMoney(body?.minimumPayment ?? existing?.minimumPayment ?? 0, 'Minimum payment');
  return {
    loanType: normalizeAccountType(body?.loanType ?? existing?.loanType ?? 'Mortgage'),
    originalPrincipal,
    currentBalance,
    balanceAsOfDate: normalizeDate(body?.balanceAsOfDate ?? existing?.balanceAsOfDate ?? getTodayDateKey(), 'Balance as-of date'),
    aprPercent,
    termMonths,
    paymentFrequency: normalizeLoanPaymentFrequency(body?.paymentFrequency ?? existing?.paymentFrequency ?? 'Monthly'),
    originationDate: normalizeDate(body?.originationDate ?? existing?.originationDate ?? getTodayDateKey(), 'Origination date'),
    nextPaymentDate: normalizeDate(body?.nextPaymentDate ?? existing?.nextPaymentDate ?? getTodayDateKey(), 'Next payment date'),
    escrowMonthly: normalizePositiveMoney(body?.escrowMonthly ?? existing?.escrowMonthly ?? 0, 'Escrow'),
    graceDays: normalizeInteger(body?.graceDays ?? existing?.graceDays ?? 0, 'Grace days', { min: 0, max: 60 }),
    lateFeeFlat: normalizePositiveMoney(body?.lateFeeFlat ?? existing?.lateFeeFlat ?? 0, 'Late fee flat amount'),
    lateFeePct: normalizeMoney(body?.lateFeePct ?? existing?.lateFeePct ?? 4, 'Late fee percentage'),
    minimumPayment,
    fixedPayment: normalizeBoolean(body?.fixedPayment ?? existing?.fixedPayment, true),
    accountNumber: normalizeText(body?.accountNumber ?? existing?.accountNumber),
    borrowerName: normalizeText(body?.borrowerName ?? existing?.borrowerName),
    borrowerAddress: normalizeText(body?.borrowerAddress ?? existing?.borrowerAddress),
    propertyAddress: normalizeText(body?.propertyAddress ?? existing?.propertyAddress),
    servicerName: normalizeText(body?.servicerName ?? existing?.servicerName),
    servicerAddress: normalizeText(body?.servicerAddress ?? existing?.servicerAddress),
    servicerPhone: normalizeText(body?.servicerPhone ?? existing?.servicerPhone),
    servicerWebsite: normalizeText(body?.servicerWebsite ?? existing?.servicerWebsite),
    statementMessage: normalizeText(body?.statementMessage ?? existing?.statementMessage),
  };
}

function getTodayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeAccountPayload(body, existing = null) {
  const trackingType = normalizeTrackingType(body?.trackingType ?? existing?.trackingType ?? 'cash');
  const accountType = normalizeAccountType(
    body?.accountType
    ?? existing?.accountType
    ?? (trackingType === 'loan' ? 'Mortgage' : 'Checking'),
  );
  const color = normalizeText(body?.color ?? existing?.color ?? accountColorPalette[0], accountColorPalette[0]);
  const openingBalanceDate = normalizeDate(body?.openingBalanceDate ?? existing?.openingBalanceDate ?? getTodayDateKey(), 'Opening balance date');
  const openingBalance = normalizeMoney(body?.openingBalance ?? existing?.openingBalance ?? 0, 'Opening balance');
  const warningBalance = normalizeMoney(
    body?.warningBalance ?? existing?.warningBalance ?? defaultAdminSettings.cashWarningThreshold,
    'Warning balance',
  );
  const minimumBalance = normalizeMoney(body?.minimumBalance ?? existing?.minimumBalance ?? 0, 'Minimum balance');
  assert(warningBalance >= minimumBalance, 'Warning balance must be at or above the minimum balance floor.');
  const loanDetails = trackingType === 'loan'
    ? normalizeLoanDetailsPayload(body?.loanDetails, existing?.loanDetails)
    : null;
  return {
    name: normalizeRequiredText(body?.name ?? existing?.name, 'Account name'),
    institution: normalizeText(body?.institution ?? existing?.institution),
    trackingType,
    accountType,
    color: color || accountColorPalette[0],
    openingBalance,
    openingBalanceDate,
    notes: normalizeText(body?.notes ?? existing?.notes),
    sortOrder: normalizeInteger(body?.sortOrder ?? existing?.sortOrder ?? 0, 'Sort order', { min: 0 }),
    isActive: normalizeBoolean(body?.isActive ?? existing?.isActive, true),
    warningBalance,
    minimumBalance,
    loanDetails,
  };
}

function normalizeTransactionPayload(body, householdId, existing = null) {
  const direction = normalizeDirection(body?.direction ?? existing?.direction);
  const accountId = normalizeInteger(body?.accountId ?? existing?.accountId, 'Account', { min: 1 });
  ensureCashAccountExists(accountId, 'Account', householdId);
  const status = normalizeStatus(body?.status ?? existing?.status ?? 'actual');
  let toAccountId = normalizeInteger(body?.toAccountId ?? existing?.toAccountId, 'Destination account', { min: 1, nullable: true });
  if (direction === 'transfer') {
    assert(toAccountId, 'Destination account is required for a transfer.');
    ensureCashAccountExists(toAccountId, 'Destination account', householdId);
    assert(toAccountId !== accountId, 'Transfer destination must be different from the source account.');
  } else {
    toAccountId = null;
  }
  const recurringRuleId = normalizeInteger(body?.recurringRuleId ?? existing?.recurringRuleId, 'Recurring rule', { min: 1, nullable: true });
  if (recurringRuleId) {
    assert(getRecurringRuleById(db, recurringRuleId, householdId), 'Recurring rule was not found.');
  }
  return {
    date: normalizeDate(body?.date ?? existing?.date, 'Transaction date'),
    title: normalizeRequiredText(body?.title ?? existing?.title, 'Transaction title'),
    amount: normalizePositiveMoney(body?.amount ?? existing?.amount, 'Amount'),
    direction,
    status,
    accountId,
    toAccountId,
    category: normalizeText(body?.category ?? existing?.category),
    notes: normalizeText(body?.notes ?? existing?.notes),
    recurringRuleId,
    occurrenceKey: normalizeText(body?.occurrenceKey ?? existing?.occurrenceKey),
    clearedOn: status === 'cleared' ? normalizeOptionalDate(body?.clearedOn ?? existing?.clearedOn) : null,
    reconciliationId: status === 'cleared'
      ? normalizeInteger(body?.reconciliationId ?? existing?.reconciliationId, 'Reconciliation', { min: 1, nullable: true })
      : null,
  };
}

function normalizeRecurringRulePayload(body, householdId, existing = null) {
  const direction = normalizeDirection(body?.direction ?? existing?.direction);
  const accountId = normalizeInteger(body?.accountId ?? existing?.accountId, 'Source account', { min: 1 });
  ensureCashAccountExists(accountId, 'Source account', householdId);
  let toAccountId = normalizeInteger(body?.toAccountId ?? existing?.toAccountId, 'Destination account', { min: 1, nullable: true });
  if (direction === 'transfer') {
    assert(toAccountId, 'Destination account is required for a transfer rule.');
    ensureCashAccountExists(toAccountId, 'Destination account', householdId);
    assert(toAccountId !== accountId, 'Transfer destination must be different from the source account.');
  } else {
    toAccountId = null;
  }
  const frequencyUnit = normalizeFrequencyUnit(body?.frequencyUnit ?? existing?.frequencyUnit);
  const startsOn = normalizeDate(body?.startsOn ?? existing?.startsOn, 'Rule start date');
  const endsOn = normalizeOptionalDate(body?.endsOn ?? existing?.endsOn);
  if (endsOn) {
    assert(endsOn >= startsOn, 'Rule end date must be on or after the start date.');
  }
  let weekday = normalizeInteger(body?.weekday ?? existing?.weekday, 'Weekday', { min: 0, max: 6, nullable: true });
  let monthDay = normalizeInteger(body?.monthDay ?? existing?.monthDay, 'Month day', { min: 1, max: 31, nullable: true });
  if (frequencyUnit === 'week' && weekday === null) {
    weekday = new Date(`${startsOn}T00:00:00Z`).getUTCDay();
  }
  if (frequencyUnit === 'month' && monthDay === null) {
    monthDay = new Date(`${startsOn}T00:00:00Z`).getUTCDate();
  }
  if (frequencyUnit !== 'week') weekday = null;
  if (frequencyUnit !== 'month') monthDay = null;
  return {
    title: normalizeRequiredText(body?.title ?? existing?.title, 'Rule title'),
    amount: normalizePositiveMoney(body?.amount ?? existing?.amount, 'Amount'),
    direction,
    accountId,
    toAccountId,
    category: normalizeText(body?.category ?? existing?.category),
    frequencyUnit,
    frequencyInterval: normalizeInteger(body?.frequencyInterval ?? existing?.frequencyInterval ?? 1, 'Frequency interval', { min: 1, max: 366 }),
    startsOn,
    endsOn,
    maxOccurrences: normalizeInteger(body?.maxOccurrences ?? existing?.maxOccurrences, 'Number of payments', { min: 1, nullable: true }),
    weekday,
    monthDay,
    status: normalizeRuleStatus(body?.status ?? existing?.status ?? 'active'),
    notes: normalizeText(body?.notes ?? existing?.notes),
  };
}

function normalizeRecurringOverridePayload(body, householdId, existing = null) {
  const ruleId = normalizeInteger(body?.ruleId ?? existing?.ruleId, 'Recurring rule', { min: 1 });
  const rule = getRecurringRuleById(db, ruleId, householdId);
  assert(rule, 'Recurring rule was not found.');
  const action = normalizeRequiredText(body?.action ?? existing?.action, 'Override action').toLowerCase();
  assert(['skip', 'modify'].includes(action), 'Override action must be skip or modify.');
  let amount = null;
  let title = null;
  let accountId = null;
  let toAccountId = null;
  let category = null;
  let notes = null;
  let status = null;
  if (action === 'modify') {
    amount = normalizePositiveMoney(body?.amount ?? existing?.amount ?? rule.amount, 'Override amount');
    title = normalizeRequiredText(body?.title ?? existing?.title ?? rule.title, 'Override title');
    accountId = normalizeInteger(body?.accountId ?? existing?.accountId ?? rule.accountId, 'Override account', { min: 1 });
    ensureCashAccountExists(accountId, 'Override account', householdId);
    if (rule.direction === 'transfer') {
      toAccountId = normalizeInteger(body?.toAccountId ?? existing?.toAccountId ?? rule.toAccountId, 'Override destination account', { min: 1 });
      ensureCashAccountExists(toAccountId, 'Override destination account', householdId);
      assert(toAccountId !== accountId, 'Override transfer destination must be different from the source account.');
    }
    category = normalizeText(body?.category ?? existing?.category ?? rule.category);
    notes = normalizeText(body?.notes ?? existing?.notes ?? rule.notes);
    status = normalizeStatus(body?.status ?? existing?.status ?? 'projected');
  }
  return {
    ruleId,
    occurrenceDate: normalizeDate(body?.occurrenceDate ?? existing?.occurrenceDate, 'Occurrence date'),
    action,
    amount,
    title,
    accountId,
    toAccountId,
    category,
    notes,
    status,
  };
}

function normalizeBudgetPayload(body, existing = null) {
  const scope = normalizeBudgetScope(body?.scope ?? existing?.scope ?? 'default');
  return {
    scope,
    month: scope === 'month'
      ? normalizeMonthKey(body?.month ?? existing?.month, 'Budget month')
      : null,
    category: normalizeRequiredText(body?.category ?? existing?.category, 'Budget category'),
    direction: normalizeBudgetDirection(body?.direction ?? existing?.direction ?? 'expense'),
    mode: normalizeBudgetMode(body?.mode ?? existing?.mode ?? 'limit'),
    amount: normalizePositiveMoney(body?.amount ?? existing?.amount, 'Budget amount'),
    notes: normalizeText(body?.notes ?? existing?.notes),
  };
}

function normalizeReconciliationPayload(body, householdId, existing = null) {
  const accountId = normalizeInteger(body?.accountId ?? existing?.accountId, 'Reconciliation account', { min: 1 });
  ensureCashAccountExists(accountId, 'Reconciliation account', householdId);
  const transactionSource = body?.transactionIds ?? existing?.transactionIds;
  const transactionIds = Array.isArray(transactionSource)
    ? [...new Set(transactionSource.map((value) => normalizeInteger(value, 'Transaction id', { min: 1 })))]
    : [];
  return {
    accountId,
    statementEndingDate: normalizeDate(body?.statementEndingDate ?? existing?.statementEndingDate, 'Statement ending date'),
    openingBalance: normalizeMoney(body?.openingBalance ?? existing?.openingBalance ?? 0, 'Opening balance'),
    closingBalance: normalizeMoney(body?.closingBalance ?? existing?.closingBalance ?? 0, 'Closing balance'),
    clearedDelta: normalizeMoney(body?.clearedDelta ?? existing?.clearedDelta ?? 0, 'Cleared delta'),
    difference: normalizeMoney(body?.difference ?? existing?.difference ?? 0, 'Difference'),
    transactionIds,
    notes: normalizeText(body?.notes ?? existing?.notes),
  };
}

function ensureLoanAccountExists(id, label, householdId) {
  const account = ensureAccountExists(id, label, householdId);
  assert(account.trackingType === 'loan', `${label} must be a loan account.`);
  return account;
}

function normalizeLoanPaymentPayload(body, householdId, existing = null) {
  const accountId = normalizeInteger(body?.accountId ?? existing?.accountId, 'Loan account', { min: 1 });
  ensureLoanAccountExists(accountId, 'Loan account', householdId);
  return {
    accountId,
    paymentDate: normalizeDate(body?.paymentDate ?? existing?.paymentDate, 'Payment date'),
    amount: normalizePositiveMoney(body?.amount ?? existing?.amount, 'Payment amount'),
    isScheduledInstallment: normalizeBoolean(body?.isScheduledInstallment ?? existing?.isScheduledInstallment, true),
    method: normalizeText(body?.method ?? existing?.method ?? 'ACH', 'ACH'),
    reference: normalizeText(body?.reference ?? existing?.reference),
    postedBy: normalizeText(body?.postedBy ?? existing?.postedBy ?? 'You', 'You'),
  };
}

function normalizeLoanDrawPayload(body, householdId, existing = null) {
  const accountId = normalizeInteger(body?.accountId ?? existing?.accountId, 'Loan account', { min: 1 });
  ensureLoanAccountExists(accountId, 'Loan account', householdId);
  return {
    accountId,
    drawDate: normalizeDate(body?.drawDate ?? existing?.drawDate, 'Draw date'),
    amount: normalizePositiveMoney(body?.amount ?? existing?.amount, 'Draw amount'),
    notes: normalizeText(body?.notes ?? existing?.notes),
  };
}

function normalizeLegacyLoanState(input) {
  const state = input?.state && typeof input.state === 'object' ? input.state : input;
  const safe = {
    loans: Array.isArray(state?.loans) ? state.loans : legacyLoanDefaultState.loans,
    payments: Array.isArray(state?.payments) ? state.payments : legacyLoanDefaultState.payments,
    draws: Array.isArray(state?.draws) ? state.draws : [],
    selectedId: state?.selectedId ?? legacyLoanDefaultState.selectedId,
    admin: {
      ...legacyLoanAdminDefaults,
      ...(state?.admin && typeof state.admin === 'object' ? state.admin : {}),
    },
  };
  if (!Array.isArray(safe.admin.frequencies)) {
    safe.admin.frequencies = legacyLoanAdminDefaults.frequencies;
  }
  if (safe.loans.length === 0) {
    safe.selectedId = null;
  } else if (!safe.loans.some((loan) => loan.id === safe.selectedId)) {
    safe.selectedId = safe.loans[0].id;
  }
  return safe;
}

function buildBootstrapPayload(user) {
  purgeExpiredArchivedHouseholds();
  const adminSettings = getAdminSettings(db, defaultAdminSettings);
  const resolved = ensureUserActiveHousehold(user);
  const activeHouseholdId = resolved.access?.household?.id ?? null;
  if (activeHouseholdId) {
    touchHouseholdActivity(db, activeHouseholdId);
  }
  const householdCards = resolved.households.map((access) => sanitizeHousehold(access.household, access));
  return {
    user: sanitizeUser(resolved.user || user),
    lookups: {
      ...adminSettings,
      accountColorPalette,
    },
    households: householdCards,
    activeHousehold: resolved.access ? sanitizeHousehold(resolved.access.household, resolved.access) : null,
    accounts: listAccounts(db, activeHouseholdId),
    transactions: listTransactions(db, activeHouseholdId),
    recurringRules: listRecurringRules(db, activeHouseholdId),
    recurringOverrides: listRecurringOverrides(db, activeHouseholdId),
    budgets: listBudgets(db, activeHouseholdId),
    reconciliations: listReconciliations(db, activeHouseholdId),
    loanPayments: listLoanPayments(db, activeHouseholdId),
    loanDraws: listLoanDraws(db, activeHouseholdId),
  };
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

if (!JWT_SECRET) {
  if (NODE_ENV === 'production') {
    console.error('JWT_SECRET not set. Refusing to start in production.');
    process.exit(1);
  }
  console.warn('JWT_SECRET not set. Using insecure default secret.');
}

ensureDefaultAdmin();
migrateLegacyDataIntoHouseholds();
purgeExpiredArchivedHouseholds();

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const resolved = ensureUserActiveHousehold(user);
  return res.json({ user: sanitizeUser(resolved.user || user) });
});

app.post('/api/auth/login', async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password || '';
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const user = getUserByUsernameLower(db, username.toLowerCase());
  if (!user || user.disabled) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  setSessionCookie(res, user);
  const resolved = ensureUserActiveHousehold(user);
  return res.json({ user: sanitizeUser(resolved.user || user) });
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password || '';
    const inviteToken = normalizeText(req.body?.inviteToken);
    const profile = normalizeUserProfilePayload(req.body);
    if (!username) {
      return res.status(400).json({ error: 'Username is required.' });
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
    }
    const exists = getUserByUsernameLower(db, username.toLowerCase());
    if (exists) {
      return res.status(409).json({ error: 'Username already exists.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    let user = createUser(db, {
      username,
      usernameLower: username.toLowerCase(),
      passwordHash,
      firstName: profile.firstName,
      lastName: profile.lastName,
      phone: profile.phone,
      gender: profile.gender,
      annualHouseholdIncome: profile.annualHouseholdIncome,
      role: 'Standard User',
      disabled: 0,
      activeHouseholdId: null,
    });

    if (inviteToken) {
      const invite = getHouseholdInviteByTokenHash(db, hashInviteToken(inviteToken));
      assert(invite, 'Invite link was not found.');
      assert(!invite.usedAt, 'Invite link has already been used.');
      assert(invite.expiresAt >= new Date().toISOString(), 'Invite link has expired.');
      const existingMembership = getHouseholdMembership(db, invite.householdId, user.id);
      if (existingMembership) {
        updateHouseholdMember(db, existingMembership.id, {
          ...existingMembership,
          role: invite.role,
        });
      } else {
        createHouseholdMember(db, {
          householdId: invite.householdId,
          userId: user.id,
          role: invite.role,
        });
      }
      updateHouseholdInvite(db, invite.id, {
        ...invite,
        usedAt: new Date().toISOString(),
        usedByUserId: user.id,
      });
      user = setUserActiveHousehold(db, { id: user.id, householdId: invite.householdId });
    } else {
      createOwnedHouseholdForUser(user, 'My Household');
      user = getUserById(db, user.id);
    }

    setSessionCookie(res, user);
    const resolved = ensureUserActiveHousehold(user);
    return res.status(201).json({ user: sanitizeUser(resolved.user || user) });
  } catch (error) {
    return sendError(res, error);
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/invites/:token', (req, res) => {
  try {
    const token = normalizeRequiredText(req.params.token, 'Invite token');
    const invite = getHouseholdInviteByTokenHash(db, hashInviteToken(token));
    if (!invite) {
      return res.status(404).json({ error: 'Invite link was not found.' });
    }
    if (invite.usedAt) {
      return res.status(410).json({ error: 'Invite link has already been used.' });
    }
    if (invite.expiresAt < new Date().toISOString()) {
      return res.status(410).json({ error: 'Invite link has expired.' });
    }
    const household = getHouseholdById(db, invite.householdId);
    assert(household, 'Household was not found.');
    return res.json({
      invite: {
        householdId: household.id,
        householdName: household.name,
        role: invite.role,
        expiresAt: invite.expiresAt,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
});

app.post('/api/invites/:token/accept', requireAuth, (req, res) => {
  try {
    const token = normalizeRequiredText(req.params.token, 'Invite token');
    const invite = getHouseholdInviteByTokenHash(db, hashInviteToken(token));
    assert(invite, 'Invite link was not found.');
    assert(!invite.usedAt, 'Invite link has already been used.');
    assert(invite.expiresAt >= new Date().toISOString(), 'Invite link has expired.');
    const existingMembership = getHouseholdMembership(db, invite.householdId, req.user.id);
    if (existingMembership) {
      updateHouseholdMember(db, existingMembership.id, {
        ...existingMembership,
        role: invite.role,
      });
    } else {
      createHouseholdMember(db, {
        householdId: invite.householdId,
        userId: req.user.id,
        role: invite.role,
      });
    }
    updateHouseholdInvite(db, invite.id, {
      ...invite,
      usedAt: new Date().toISOString(),
      usedByUserId: req.user.id,
    });
    const user = setUserActiveHousehold(db, { id: req.user.id, householdId: invite.householdId });
    return res.json(buildBootstrapPayload(user));
  } catch (error) {
    return sendError(res, error);
  }
});

app.get('/api/bootstrap', requireAuth, (req, res) => {
  res.json(buildBootstrapPayload(req.user));
});

app.post('/api/households', requireAuth, (req, res) => {
  try {
    const name = normalizeRequiredText(req.body?.name ?? 'My Household', 'Household name');
    const household = createHousehold(db, {
      name,
      createdByUserId: req.user.id,
    });
    createHouseholdMember(db, {
      householdId: household.id,
      userId: req.user.id,
      role: 'Owner',
    });
    const user = setUserActiveHousehold(db, { id: req.user.id, householdId: household.id });
    res.status(201).json({
      household: sanitizeHousehold(household, getHouseholdAccess(user, household.id)),
      user: sanitizeUser(user),
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/households/active', requireAuth, (req, res) => {
  try {
    const householdId = normalizeInteger(req.body?.householdId, 'Household', { min: 1 });
    const membership = getHouseholdMembership(db, householdId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'That household is not available to this user.' });
    }
    const user = setUserActiveHousehold(db, { id: req.user.id, householdId });
    res.json(buildBootstrapPayload(user));
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/api/households/:id', requireAuth, (req, res) => {
  try {
    const householdId = normalizeInteger(req.params.id, 'Household id', { min: 1 });
    assertHouseholdManageAccess(req.user, householdId);
    const existing = getHouseholdById(db, householdId);
    assert(existing, 'Household not found.');
    const household = updateHousehold(db, householdId, {
      ...existing,
      name: normalizeRequiredText(req.body?.name ?? existing.name, 'Household name'),
    });
    res.json({ household: sanitizeHousehold(household, getHouseholdAccess(req.user, householdId)) });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/households/:id/members', requireAuth, (req, res) => {
  try {
    const householdId = normalizeInteger(req.params.id, 'Household id', { min: 1 });
    const access = assertHouseholdReadAccess(req.user, householdId);
    const members = listHouseholdMembers(db, householdId)
      .map(sanitizeHouseholdMember)
      .filter(Boolean);
    const invites = listHouseholdInvites(db, householdId)
      .filter((invite) => !invite.usedAt && invite.expiresAt >= new Date().toISOString())
      .map((invite) => sanitizeHouseholdInvite(invite));
    res.json({
      household: sanitizeHousehold(access.household, access),
      members,
      invites,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/households/:id/invites', requireAuth, (req, res) => {
  try {
    const householdId = normalizeInteger(req.params.id, 'Household id', { min: 1 });
    assertHouseholdManageAccess(req.user, householdId);
    const role = normalizeHouseholdRole(req.body?.role ?? 'Member');
    const token = createInviteToken();
    const expiresAt = new Date(Date.now() + HOUSEHOLD_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const invite = createHouseholdInvite(db, {
      householdId,
      tokenHash: hashInviteToken(token),
      role,
      expiresAt,
      createdByUserId: req.user.id,
      usedAt: null,
      usedByUserId: null,
    });
    res.status(201).json({
      invite: sanitizeHouseholdInvite({ ...invite, token }, req),
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/households/:id/members', requireAuth, (req, res) => {
  try {
    const householdId = normalizeInteger(req.params.id, 'Household id', { min: 1 });
    assert(req.user.role === 'Admin', 'Only an admin can assign existing users to a household directly.');
    assert(getHouseholdById(db, householdId), 'Household not found.');
    const userId = normalizeInteger(req.body?.userId, 'User', { min: 1 });
    const role = normalizeHouseholdRole(req.body?.role ?? 'Member');
    const user = getUserById(db, userId);
    assert(user, 'User not found.');
    const existing = getHouseholdMembership(db, householdId, userId);
    if (existing) {
      const updated = updateHouseholdMember(db, existing.id, {
        ...existing,
        role,
      });
      return res.json({ member: sanitizeHouseholdMember(updated) });
    }
    const member = createHouseholdMember(db, {
      householdId,
      userId,
      role,
    });
    return res.status(201).json({ member: sanitizeHouseholdMember(member) });
  } catch (error) {
    return sendError(res, error);
  }
});

app.post('/api/households/:id/leave', requireAuth, (req, res) => {
  try {
    const householdId = normalizeInteger(req.params.id, 'Household id', { min: 1 });
    const household = getHouseholdById(db, householdId);
    assert(household, 'Household not found.');
    assert(!household.archivedAt, 'Archived households cannot be changed.');
    const membership = getHouseholdMembership(db, householdId, req.user.id);
    assert(membership, 'You are not a member of that household.');
    if (membership.role === 'Owner') {
      assert(countHouseholdOwners(db, householdId, membership.id) > 0, 'Assign another owner or archive the household instead.');
    }
    deleteHouseholdMember(db, membership.id);
    if (req.user.active_household_id === householdId) {
      setUserActiveHousehold(db, { id: req.user.id, householdId: null });
    }
    return res.status(204).end();
  } catch (error) {
    return sendError(res, error);
  }
});

app.post('/api/households/:id/archive', requireAuth, (req, res) => {
  try {
    const householdId = normalizeInteger(req.params.id, 'Household id', { min: 1 });
    const household = getHouseholdById(db, householdId);
    assert(household, 'Household not found.');
    assert(!household.archivedAt, 'Household is already archived.');
    assert(normalizeBoolean(req.body?.confirmArchive, false), 'Archive confirmation is required.');
    assert(normalizeBoolean(req.body?.acknowledgePermanentDelete, false), 'You must acknowledge permanent deletion.');
    if (req.user.role === 'Admin') {
      archiveHousehold(db, householdId, {
        archivedAt: new Date().toISOString(),
        archivedByUserId: req.user.id,
        purgeAfter: daysFromNowIso(HOUSEHOLD_ARCHIVE_RETENTION_DAYS),
      });
    } else {
      const access = assertHouseholdManageAccess(req.user, householdId);
      assert(access.membership?.role === 'Owner', 'Only the household owner can archive this household.');
      assert(countHouseholdOwners(db, householdId) <= 1, 'Archive the household only after ownership is reduced to a single owner.');
      archiveHousehold(db, householdId, {
        archivedAt: new Date().toISOString(),
        archivedByUserId: req.user.id,
        purgeAfter: daysFromNowIso(HOUSEHOLD_ARCHIVE_RETENTION_DAYS),
      });
    }
    listHouseholdMembers(db, householdId).forEach((member) => {
      const user = getUserById(db, member.userId);
      if (user?.active_household_id === householdId) {
        setUserActiveHousehold(db, { id: user.id, householdId: null });
      }
    });
    return res.status(204).end();
  } catch (error) {
    return sendError(res, error);
  }
});

app.put('/api/household-members/:id', requireAuth, (req, res) => {
  try {
    const id = normalizeInteger(req.params.id, 'Member id', { min: 1 });
    const existing = getHouseholdMemberById(db, id);
    assert(existing, 'Household member not found.');
    assertHouseholdManageAccess(req.user, existing.householdId);
    const role = normalizeHouseholdRole(req.body?.role ?? existing.role);
    if (existing.role === 'Owner' && role !== 'Owner') {
      assert(countHouseholdOwners(db, existing.householdId, existing.id) > 0, 'Keep at least one household owner assigned.');
    }
    const updated = updateHouseholdMember(db, id, {
      ...existing,
      role,
    });
    res.json({ member: sanitizeHouseholdMember(updated) });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/household-members/:id', requireAuth, (req, res) => {
  try {
    const id = normalizeInteger(req.params.id, 'Member id', { min: 1 });
    const existing = getHouseholdMemberById(db, id);
    assert(existing, 'Household member not found.');
    assertHouseholdManageAccess(req.user, existing.householdId);
    if (existing.role === 'Owner') {
      assert(countHouseholdOwners(db, existing.householdId, existing.id) > 0, 'Keep at least one household owner assigned.');
    }
    deleteHouseholdMember(db, id);
    if (req.user.id === existing.userId) {
      setUserActiveHousehold(db, { id: existing.userId, householdId: null });
    }
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/admin/households', requireAdmin, (req, res) => {
  try {
    purgeExpiredArchivedHouseholds();
    const households = listHouseholds(db).map((household) => sanitizeAdminHouseholdRow(household, req.user.id));
    return res.json({
      households,
      lookups: {
        genderOptions: GENDER_OPTIONS,
        incomeBrackets: INCOME_BRACKETS,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
});

app.post('/api/admin/households/:id/restore', requireAdmin, (req, res) => {
  try {
    const householdId = normalizeInteger(req.params.id, 'Household id', { min: 1 });
    const household = getHouseholdById(db, householdId);
    assert(household, 'Household not found.');
    assert(household.archivedAt, 'Household is not archived.');
    const restored = restoreHousehold(db, householdId);
    return res.json({ household: sanitizeAdminHouseholdRow(restored, req.user.id) });
  } catch (error) {
    return sendError(res, error);
  }
});

app.get('/api/legacy-loans/state', requireAuth, requireActiveHousehold, (req, res) => {
  res.json({ state: getLegacyLoanState(db, req.activeHouseholdAccess.household.id, legacyLoanDefaultState) });
});

app.put('/api/legacy-loans/state', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const state = normalizeLegacyLoanState(req.body || {});
    res.json({ state: saveLegacyLoanState(db, req.activeHouseholdAccess.household.id, state) });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/accounts', requireAuth, requireActiveHousehold, (req, res) => {
  res.json({ accounts: listAccounts(db, req.activeHouseholdAccess.household.id) });
});

app.post('/api/accounts', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const account = normalizeAccountPayload(req.body);
    res.status(201).json({
      account: createAccount(db, {
        ...account,
        householdId: req.activeHouseholdAccess.household.id,
      }),
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/api/accounts/:id', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const id = normalizeInteger(req.params.id, 'Account id', { min: 1 });
    const householdId = req.activeHouseholdAccess.household.id;
    const existing = getAccountById(db, id, householdId);
    if (!existing) {
      return res.status(404).json({ error: 'Account not found.' });
    }
    const account = normalizeAccountPayload(req.body, existing);
    res.json({ account: updateAccount(db, id, account) });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/accounts/:id', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const id = normalizeInteger(req.params.id, 'Account id', { min: 1 });
    const householdId = req.activeHouseholdAccess.household.id;
    const existing = getAccountById(db, id, householdId);
    if (!existing) {
      return res.status(404).json({ error: 'Account not found.' });
    }
    const usage = getAccountUsage(db, id, householdId);
    if (usage.transactions || usage.recurringRules || usage.recurringOverrides || usage.reconciliations || usage.loanPayments || usage.loanDraws) {
      return res.status(409).json({
        error: 'This account is already referenced. Archive it instead of deleting it.',
      });
    }
    deleteAccount(db, id);
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/transactions', requireAuth, requireActiveHousehold, (req, res) => {
  res.json({ transactions: listTransactions(db, req.activeHouseholdAccess.household.id) });
});

app.post('/api/transactions', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const householdId = req.activeHouseholdAccess.household.id;
    const transaction = normalizeTransactionPayload(req.body, householdId);
    res.status(201).json({ transaction: createTransaction(db, { ...transaction, householdId }) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/transactions/bulk', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    assert(Array.isArray(req.body?.transactions) && req.body.transactions.length > 0, 'At least one transaction is required.');
    const householdId = req.activeHouseholdAccess.household.id;
    const transactions = req.body.transactions.map((item) => normalizeTransactionPayload(item, householdId));
    const created = transactions.map((transaction) => createTransaction(db, { ...transaction, householdId }));
    res.status(201).json({ transactions: created });
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/api/transactions/:id', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const id = normalizeInteger(req.params.id, 'Transaction id', { min: 1 });
    const householdId = req.activeHouseholdAccess.household.id;
    const existing = getTransactionById(db, id, householdId);
    if (!existing) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }
    const transaction = normalizeTransactionPayload(req.body, householdId, existing);
    res.json({ transaction: updateTransaction(db, id, { ...transaction, householdId }) });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/transactions/:id', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const id = normalizeInteger(req.params.id, 'Transaction id', { min: 1 });
    const existing = getTransactionById(db, id, req.activeHouseholdAccess.household.id);
    if (!existing) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }
    deleteTransaction(db, id);
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/recurring-rules', requireAuth, requireActiveHousehold, (req, res) => {
  const householdId = req.activeHouseholdAccess.household.id;
  res.json({
    recurringRules: listRecurringRules(db, householdId),
    recurringOverrides: listRecurringOverrides(db, householdId),
  });
});

app.post('/api/recurring-rules', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const householdId = req.activeHouseholdAccess.household.id;
    const rule = normalizeRecurringRulePayload(req.body, householdId);
    res.status(201).json({ recurringRule: createRecurringRule(db, { ...rule, householdId }) });
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/api/recurring-rules/:id', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const id = normalizeInteger(req.params.id, 'Recurring rule id', { min: 1 });
    const householdId = req.activeHouseholdAccess.household.id;
    const existing = getRecurringRuleById(db, id, householdId);
    if (!existing) {
      return res.status(404).json({ error: 'Recurring rule not found.' });
    }
    const rule = normalizeRecurringRulePayload(req.body, householdId, existing);
    res.json({ recurringRule: updateRecurringRule(db, id, { ...rule, householdId }) });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/recurring-rules/:id', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const id = normalizeInteger(req.params.id, 'Recurring rule id', { min: 1 });
    const existing = getRecurringRuleById(db, id, req.activeHouseholdAccess.household.id);
    if (!existing) {
      return res.status(404).json({ error: 'Recurring rule not found.' });
    }
    deleteRecurringRule(db, id);
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/recurring-overrides', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const householdId = req.activeHouseholdAccess.household.id;
    const override = normalizeRecurringOverridePayload(req.body, householdId);
    res.status(201).json({ recurringOverride: upsertRecurringOverride(db, { ...override, householdId }) });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/recurring-overrides/:id', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const id = normalizeInteger(req.params.id, 'Recurring override id', { min: 1 });
    const existing = getRecurringOverrideById(db, id, req.activeHouseholdAccess.household.id);
    if (!existing) {
      return res.status(404).json({ error: 'Recurring override not found.' });
    }
    deleteRecurringOverride(db, id);
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/budgets', requireAuth, requireActiveHousehold, (req, res) => {
  res.json({ budgets: listBudgets(db, req.activeHouseholdAccess.household.id) });
});

app.post('/api/budgets', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const budget = normalizeBudgetPayload(req.body);
    res.status(201).json({
      budget: createBudget(db, {
        ...budget,
        householdId: req.activeHouseholdAccess.household.id,
      }),
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/budgets/bulk', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    assert(Array.isArray(req.body?.budgets), 'Budget planner payload is required.');
    const summary = { created: 0, updated: 0, deleted: 0 };
    const budgetScope = (budget) => budget.scope || 'default';
    const householdId = req.activeHouseholdAccess.household.id;

    req.body.budgets.forEach((item) => {
      const existing = item?.id ? getBudgetById(db, item.id, householdId) : null;
      const amount = Number(item?.amount || 0);
      const shouldPersist = amount > 0;

      if (!shouldPersist) {
        if (existing) {
          deleteBudget(db, existing.id);
          summary.deleted += 1;
        }
        return;
      }

      const payload = normalizeBudgetPayload({
        scope: item?.scope ?? 'default',
        month: item?.month,
        category: item?.category,
        direction: item?.direction ?? 'expense',
        mode: item?.mode ?? 'limit',
        amount,
        notes: item?.notes ?? '',
      }, existing);

      if (existing) {
        updateBudget(db, existing.id, { ...payload, householdId });
        summary.updated += 1;
      } else {
        const duplicate = listBudgets(db, householdId).find((budget) => (
          budgetScope(budget) === payload.scope
          && (payload.scope !== 'month' || budget.month === payload.month)
          && budget.direction === payload.direction
          && budget.category.trim().toLowerCase() === payload.category.trim().toLowerCase()
        ));
        if (duplicate) {
          updateBudget(db, duplicate.id, { ...payload, householdId });
          summary.updated += 1;
        } else {
          createBudget(db, { ...payload, householdId });
          summary.created += 1;
        }
      }
    });

    res.json({ summary, budgets: listBudgets(db, householdId) });
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/api/budgets/:id', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const id = normalizeInteger(req.params.id, 'Budget id', { min: 1 });
    const householdId = req.activeHouseholdAccess.household.id;
    const existing = getBudgetById(db, id, householdId);
    if (!existing) {
      return res.status(404).json({ error: 'Budget not found.' });
    }
    const budget = normalizeBudgetPayload(req.body, existing);
    res.json({ budget: updateBudget(db, id, { ...budget, householdId }) });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/budgets/:id', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const id = normalizeInteger(req.params.id, 'Budget id', { min: 1 });
    const existing = getBudgetById(db, id, req.activeHouseholdAccess.household.id);
    if (!existing) {
      return res.status(404).json({ error: 'Budget not found.' });
    }
    deleteBudget(db, id);
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/reconciliations', requireAuth, requireActiveHousehold, (req, res) => {
  res.json({ reconciliations: listReconciliations(db, req.activeHouseholdAccess.household.id) });
});

app.post('/api/reconciliations', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const householdId = req.activeHouseholdAccess.household.id;
    const reconciliation = normalizeReconciliationPayload(req.body, householdId);
    assert(Math.abs(reconciliation.difference) <= 0.01, 'Reconciliation difference must be zero before saving.');
    const transactions = reconciliation.transactionIds.map((id) => {
      const transaction = getTransactionById(db, id, householdId);
      assert(transaction, `Transaction ${id} was not found.`);
      const touchesAccount = transaction.accountId === reconciliation.accountId || transaction.toAccountId === reconciliation.accountId;
      assert(touchesAccount, `Transaction ${id} does not belong to the selected account.`);
      assert(transaction.status !== 'projected', 'Projected transactions cannot be reconciled.');
      assert(!transaction.reconciliationId, `Transaction ${id} is already tied to a saved reconciliation.`);
      return transaction;
    });

    const signedDelta = roundMoney(transactions.reduce(
      (sum, transaction) => sum + getTransactionSignedAmountForAccount(transaction, reconciliation.accountId),
      0,
    ));
    assert(Math.abs(signedDelta - reconciliation.clearedDelta) <= 0.01, 'Cleared transaction total does not match the requested reconciliation.');

    const saved = createReconciliation(db, { ...reconciliation, householdId });
    transactions.forEach((transaction) => {
      updateTransaction(db, transaction.id, {
        ...transaction,
        status: 'cleared',
        clearedOn: reconciliation.statementEndingDate,
        reconciliationId: saved.id,
      });
    });
    res.status(201).json({ reconciliation: getReconciliationById(db, saved.id, householdId) });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/reconciliations/:id', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const id = normalizeInteger(req.params.id, 'Reconciliation id', { min: 1 });
    const householdId = req.activeHouseholdAccess.household.id;
    const existing = getReconciliationById(db, id, householdId);
    if (!existing) {
      return res.status(404).json({ error: 'Reconciliation not found.' });
    }
    existing.transactionIds.forEach((transactionId) => {
      const transaction = getTransactionById(db, transactionId, householdId);
      if (!transaction || transaction.reconciliationId !== id) return;
      updateTransaction(db, transaction.id, {
        ...transaction,
        status: transaction.status === 'cleared' ? 'actual' : transaction.status,
        clearedOn: null,
        reconciliationId: null,
      });
    });
    deleteReconciliation(db, id);
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/loan-payments', requireAuth, requireActiveHousehold, (req, res) => {
  res.json({ loanPayments: listLoanPayments(db, req.activeHouseholdAccess.household.id) });
});

app.post('/api/loan-payments', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const householdId = req.activeHouseholdAccess.household.id;
    const payment = normalizeLoanPaymentPayload(req.body, householdId);
    res.status(201).json({ loanPayment: createLoanPayment(db, { ...payment, householdId }) });
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/api/loan-payments/:id', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const id = normalizeInteger(req.params.id, 'Loan payment id', { min: 1 });
    const householdId = req.activeHouseholdAccess.household.id;
    const existing = getLoanPaymentById(db, id, householdId);
    if (!existing) {
      return res.status(404).json({ error: 'Loan payment not found.' });
    }
    const payment = normalizeLoanPaymentPayload(req.body, householdId, existing);
    res.json({ loanPayment: updateLoanPayment(db, id, { ...payment, householdId }) });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/loan-payments/:id', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const id = normalizeInteger(req.params.id, 'Loan payment id', { min: 1 });
    const existing = getLoanPaymentById(db, id, req.activeHouseholdAccess.household.id);
    if (!existing) {
      return res.status(404).json({ error: 'Loan payment not found.' });
    }
    deleteLoanPayment(db, id);
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/loan-draws', requireAuth, requireActiveHousehold, (req, res) => {
  res.json({ loanDraws: listLoanDraws(db, req.activeHouseholdAccess.household.id) });
});

app.post('/api/loan-draws', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const householdId = req.activeHouseholdAccess.household.id;
    const draw = normalizeLoanDrawPayload(req.body, householdId);
    res.status(201).json({ loanDraw: createLoanDraw(db, { ...draw, householdId }) });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/loan-draws/:id', requireAuth, requireHouseholdWriteAccess, (req, res) => {
  try {
    const id = normalizeInteger(req.params.id, 'Loan draw id', { min: 1 });
    const existing = getLoanDrawById(db, id, req.activeHouseholdAccess.household.id);
    if (!existing) {
      return res.status(404).json({ error: 'Loan draw not found.' });
    }
    deleteLoanDraw(db, id);
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/users', requireAdmin, (req, res) => {
  res.json({ users: listUsers(db) });
});

app.get('/api/settings', requireAdmin, (req, res) => {
  res.json({ settings: getAdminSettings(db, defaultAdminSettings) });
});

app.put('/api/settings', requireAdmin, (req, res) => {
  try {
    const existing = getAdminSettings(db, defaultAdminSettings);
    const settings = normalizeAdminSettingsPayload(req.body, existing);
    res.json({ settings: updateAdminSettings(db, settings, defaultAdminSettings) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password || '';
  const role = req.body?.role === 'Admin' ? 'Admin' : 'Standard User';
  const profile = normalizeUserProfilePayload(req.body, {
    firstName: '',
    lastName: '',
    phone: '',
    gender: 'Prefer not to say',
    annualHouseholdIncome: '',
  }, { requireNames: false });
  if (!username) {
    return res.status(400).json({ error: 'Username is required.' });
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
  }
  const exists = getUserByUsernameLower(db, username.toLowerCase());
  if (exists) {
    return res.status(409).json({ error: 'Username already exists.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = createUser(db, {
    username,
    usernameLower: username.toLowerCase(),
    passwordHash,
    firstName: profile.firstName,
    lastName: profile.lastName,
    phone: profile.phone,
    gender: profile.gender,
    annualHouseholdIncome: profile.annualHouseholdIncome,
    role,
    disabled: 0,
  });
  res.status(201).json({ user: sanitizeUser(user) });
});

app.put('/api/users/me/profile', requireAuth, (req, res) => {
  try {
    const existing = getUserById(db, req.user.id);
    assert(existing, 'User not found.');
    const profile = normalizeUserProfilePayload(req.body, existing);
    const updated = updateUser(db, {
      id: existing.id,
      username: existing.username,
      usernameLower: existing.username_lower,
      firstName: profile.firstName,
      lastName: profile.lastName,
      phone: profile.phone,
      gender: profile.gender,
      annualHouseholdIncome: profile.annualHouseholdIncome,
      role: existing.role,
      disabled: !!existing.disabled,
      activeHouseholdId: existing.active_household_id ?? null,
    });
    return res.json({ user: sanitizeUser(updated) });
  } catch (error) {
    return sendError(res, error);
  }
});

app.put('/api/users/me/password', requireAuth, async (req, res) => {
  const currentPassword = req.body?.currentPassword || '';
  const newPassword = req.body?.newPassword || '';
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'All password fields are required.' });
  }
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
  }
  const user = getUserById(db, req.user.id);
  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'Choose a password different from the current one.' });
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  setUserPassword(db, { id: req.user.id, passwordHash });
  return res.json({ ok: true });
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }
  const existing = getUserById(db, id);
  if (!existing) {
    return res.status(404).json({ error: 'User not found.' });
  }
  const username = normalizeUsername(req.body?.username ?? existing.username);
  const profile = normalizeUserProfilePayload(req.body, existing, { requireNames: false });
  const role = req.body?.role === 'Admin'
    ? 'Admin'
    : req.body?.role === 'Standard User'
      ? 'Standard User'
      : existing.role;
  const disabled = typeof req.body?.disabled === 'boolean' ? req.body.disabled : !!existing.disabled;
  if (!username) {
    return res.status(400).json({ error: 'Username is required.' });
  }
  const lower = username.toLowerCase();
  const collision = getUserByUsernameLower(db, lower);
  if (collision && collision.id !== id) {
    return res.status(409).json({ error: 'Username already exists.' });
  }
  if (existing.role === 'Admin' && role !== 'Admin' && countActiveAdmins(db, id) === 0) {
    return res.status(400).json({ error: 'At least one admin must remain.' });
  }
  if (existing.role === 'Admin' && disabled && countActiveAdmins(db, id) === 0) {
    return res.status(400).json({ error: 'Keep at least one admin active.' });
  }
  const updated = updateUser(db, {
    id,
    username,
    usernameLower: lower,
    firstName: profile.firstName,
    lastName: profile.lastName,
    phone: profile.phone,
    gender: profile.gender,
    annualHouseholdIncome: profile.annualHouseholdIncome,
    role,
    disabled,
  });
  if (req.user.id === id) {
    if (updated.disabled) {
      clearSessionCookie(res);
    } else {
      setSessionCookie(res, updated);
    }
  }
  return res.json({ user: sanitizeUser(updated) });
});

app.put('/api/users/:id/password', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const password = req.body?.password || '';
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
  }
  const user = getUserById(db, id);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  setUserPassword(db, { id, passwordHash });
  return res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }
  const existing = getUserById(db, id);
  if (!existing) {
    return res.status(404).json({ error: 'User not found.' });
  }
  if (existing.role === 'Admin' && countActiveAdmins(db, id) === 0) {
    return res.status(400).json({ error: 'Cannot delete the last admin.' });
  }
  const ownershipBlocker = listHouseholdMembershipsForUser(db, id).find((member) => (
    member.role === 'Owner' && countHouseholdOwners(db, member.householdId, member.id) === 0
  ));
  if (ownershipBlocker) {
    return res.status(400).json({ error: 'Assign another household owner before deleting this user.' });
  }
  deleteUser(db, id);
  if (req.user.id === id) {
    clearSessionCookie(res);
  }
  return res.status(204).end();
});

const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
