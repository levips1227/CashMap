const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactCurrencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

const monthFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

const shortDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function toNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function formatCurrency(value) {
  return currencyFormatter.format(Number.isFinite(value) ? value : 0);
}

export function formatCurrencyCompact(value) {
  return compactCurrencyFormatter.format(Number.isFinite(value) ? value : 0);
}

export function formatDateLabel(dayKey) {
  return dateFormatter.format(toUtcDate(dayKey));
}

export function formatShortDate(dayKey) {
  return shortDateFormatter.format(toUtcDate(dayKey));
}

export function formatMonthLabel(dayKey) {
  return monthFormatter.format(toUtcDate(dayKey));
}

export function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function getDefaultDateRange() {
  const today = getTodayKey();
  const date = toUtcDate(today);
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return {
    startDate: fromUtcDate(start),
    endDate: fromUtcDate(end),
  };
}

export function toUtcDate(dayKey) {
  return new Date(`${dayKey}T00:00:00Z`);
}

export function fromUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(dayKey, amount) {
  const date = toUtcDate(dayKey);
  date.setUTCDate(date.getUTCDate() + amount);
  return fromUtcDate(date);
}

export function addMonths(dayKey, amount, targetDay = null) {
  const source = toUtcDate(dayKey);
  const day = targetDay ?? source.getUTCDate();
  const base = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + amount, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(day, lastDay));
  return fromUtcDate(base);
}

export function getMonthKey(dayKey) {
  return String(dayKey || '').slice(0, 7);
}

export function getMonthBounds(monthKey) {
  const startDate = `${monthKey}-01`;
  const start = toUtcDate(startDate);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return {
    startDate,
    endDate: fromUtcDate(end),
  };
}

function compareDayKeys(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function entrySequenceRank(entry) {
  if (entry.direction === 'opening' || entry.sourceType === 'opening') return 0;
  if (entry.sourceType === 'manual') return 1;
  if (entry.sourceType === 'generated') return 2;
  return 3;
}

function statusMatches(status, filter) {
  if (filter === 'all') return true;
  if (filter === 'projected') return status === 'projected';
  if (filter === 'actual') return status === 'actual';
  if (filter === 'cleared') return status === 'cleared';
  if (filter === 'actual-cleared') return status === 'actual' || status === 'cleared';
  return true;
}

function buildOccurrenceIdentity(entry) {
  return [
    entry.date,
    String(entry.title || '').trim().toLowerCase(),
    entry.direction,
    roundMoney(Number(entry.amount) || 0).toFixed(2),
    entry.accountId || '',
    entry.toAccountId || '',
  ].join('|');
}

function buildManualMatchSet(transactions) {
  const matchSet = new Set();
  for (const transaction of transactions) {
    matchSet.add(buildOccurrenceIdentity(transaction));
    if (transaction.recurringRuleId && transaction.occurrenceKey) {
      matchSet.add(`rule:${transaction.recurringRuleId}:${transaction.occurrenceKey}`);
    }
  }
  return matchSet;
}

function createOverrideMap(recurringOverrides) {
  const map = new Map();
  for (const item of recurringOverrides) {
    map.set(`${item.ruleId}:${item.occurrenceDate}`, item);
  }
  return map;
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => {
    const dateComparison = compareDayKeys(left.date, right.date);
    if (dateComparison !== 0) return dateComparison;
    const rankComparison = entrySequenceRank(left) - entrySequenceRank(right);
    if (rankComparison !== 0) return rankComparison;
    return String(left.id).localeCompare(String(right.id), undefined, { numeric: true });
  });
}

function firstWeeklyOccurrence(rule) {
  const startDate = toUtcDate(rule.startsOn);
  const targetWeekday = Number.isInteger(rule.weekday) ? rule.weekday : startDate.getUTCDay();
  const currentWeekday = startDate.getUTCDay();
  const delta = (targetWeekday - currentWeekday + 7) % 7;
  startDate.setUTCDate(startDate.getUTCDate() + delta);
  return fromUtcDate(startDate);
}

function firstMonthlyOccurrence(rule) {
  const start = toUtcDate(rule.startsOn);
  const preferredDay = Number.isInteger(rule.monthDay) ? rule.monthDay : start.getUTCDate();
  const currentMonthCandidate = addMonths(rule.startsOn, 0, preferredDay);
  if (compareDayKeys(currentMonthCandidate, rule.startsOn) >= 0) {
    return currentMonthCandidate;
  }
  return addMonths(rule.startsOn, rule.frequencyInterval, preferredDay);
}

function getFirstOccurrence(rule) {
  if (rule.frequencyUnit === 'day') return rule.startsOn;
  if (rule.frequencyUnit === 'week') return firstWeeklyOccurrence(rule);
  return firstMonthlyOccurrence(rule);
}

function getNextOccurrence(dayKey, rule) {
  if (rule.frequencyUnit === 'day') {
    return addDays(dayKey, rule.frequencyInterval);
  }
  if (rule.frequencyUnit === 'week') {
    return addDays(dayKey, rule.frequencyInterval * 7);
  }
  const preferredDay = Number.isInteger(rule.monthDay)
    ? rule.monthDay
    : toUtcDate(rule.startsOn).getUTCDate();
  return addMonths(dayKey, rule.frequencyInterval, preferredDay);
}

function expandRecurringRules(recurringRules, recurringOverrides, transactions, endDate) {
  const overrideMap = createOverrideMap(recurringOverrides);
  const manualMatchSet = buildManualMatchSet(transactions);
  const generated = [];

  for (const rule of recurringRules) {
    if (rule.status !== 'active') continue;
    let occurrenceDate = getFirstOccurrence(rule);
    let occurrenceIndex = 0;

    for (let guard = 0; guard < 2500; guard += 1) {
      if (compareDayKeys(occurrenceDate, endDate) > 0) break;
      if (rule.endsOn && compareDayKeys(occurrenceDate, rule.endsOn) > 0) break;
      occurrenceIndex += 1;
      if (rule.maxOccurrences && occurrenceIndex > rule.maxOccurrences) break;

      const overrideKey = `${rule.id}:${occurrenceDate}`;
      const override = overrideMap.get(overrideKey);
      if (!override || override.action !== 'skip') {
        const occurrence = {
          id: `generated-${rule.id}-${occurrenceDate}`,
          date: occurrenceDate,
          title: override?.action === 'modify' ? override.title : rule.title,
          amount: override?.action === 'modify' ? override.amount : rule.amount,
          direction: rule.direction,
          status: override?.action === 'modify' ? override.status : 'projected',
          accountId: override?.action === 'modify' ? override.accountId : rule.accountId,
          toAccountId: override?.action === 'modify' ? override.toAccountId : rule.toAccountId,
          category: override?.action === 'modify' ? override.category : rule.category,
          notes: override?.action === 'modify' ? override.notes : rule.notes,
          recurringRuleId: rule.id,
          occurrenceKey: `${rule.id}:${occurrenceDate}`,
          sourceType: 'generated',
          isGenerated: true,
          overrideApplied: !!override,
        };

        const dedupeKey = buildOccurrenceIdentity(occurrence);
        const recurringMatchKey = `rule:${rule.id}:${occurrence.occurrenceKey}`;
        if (!manualMatchSet.has(dedupeKey) && !manualMatchSet.has(recurringMatchKey)) {
          generated.push(occurrence);
        }
      }

      occurrenceDate = getNextOccurrence(occurrenceDate, rule);
    }
  }

  return generated;
}

function buildOpeningEntries(accounts) {
  return accounts.map((account) => ({
    id: `opening-${account.id}`,
    date: account.openingBalanceDate,
    title: `${account.name} starting balance`,
    amount: roundMoney(account.openingBalance),
    direction: 'opening',
    status: 'actual',
    accountId: account.id,
    toAccountId: null,
    category: 'Starting Balance',
    notes: account.notes,
    recurringRuleId: null,
    occurrenceKey: `opening:${account.id}:${account.openingBalanceDate}`,
    sourceType: 'opening',
    isGenerated: false,
  }));
}

function applyEntryToBalances(balances, entry) {
  if (entry.direction === 'opening' || entry.direction === 'income') {
    balances[entry.accountId] = roundMoney((balances[entry.accountId] || 0) + entry.amount);
    return;
  }
  if (entry.direction === 'expense') {
    balances[entry.accountId] = roundMoney((balances[entry.accountId] || 0) - entry.amount);
    return;
  }
  if (entry.direction === 'transfer') {
    balances[entry.accountId] = roundMoney((balances[entry.accountId] || 0) - entry.amount);
    balances[entry.toAccountId] = roundMoney((balances[entry.toAccountId] || 0) + entry.amount);
  }
}

function totalBalanceForAccounts(accounts, balances) {
  return roundMoney(accounts.reduce((sum, account) => sum + (balances[account.id] || 0), 0));
}

function buildSnapshot(accounts, balances, date) {
  const point = {
    date,
    label: formatShortDate(date),
    total: totalBalanceForAccounts(accounts, balances),
    balances: {},
  };
  for (const account of accounts) {
    const balance = roundMoney(balances[account.id] || 0);
    point.balances[account.id] = balance;
    point[`account-${account.id}`] = balance;
  }
  return point;
}

function updateMinBalance(trackers, accountId, date, balance) {
  const existing = trackers[accountId];
  if (!existing || balance < existing.amount) {
    trackers[accountId] = { amount: balance, date };
  }
}

export function buildProjection({
  accounts,
  transactions,
  recurringRules,
  recurringOverrides,
  startDate,
  endDate,
  statusFilter = 'all',
  accountFilter = 'all',
  warningThreshold = 150,
}) {
  const cashAccounts = accounts.filter((account) => (account.trackingType || 'cash') !== 'loan');
  const accountMap = Object.fromEntries(cashAccounts.map((account) => [account.id, account]));
  const manualEntries = transactions.map((transaction) => ({
    ...transaction,
    sourceType: 'manual',
    isGenerated: false,
  }));
  const generatedEntries = expandRecurringRules(recurringRules, recurringOverrides, manualEntries, endDate);
  const ledger = sortEntries([
    ...buildOpeningEntries(cashAccounts),
    ...manualEntries,
    ...generatedEntries,
  ]).filter((entry) => compareDayKeys(entry.date, endDate) <= 0);

  const balances = Object.fromEntries(cashAccounts.map((account) => [account.id, 0]));
  const minBalanceByAccount = {};
  let rangeStartSnapshot = null;
  const snapshotsByDate = new Map();
  const entriesInRange = [];

  for (const entry of ledger) {
    if (entry.direction !== 'opening' && !statusMatches(entry.status, statusFilter)) {
      continue;
    }

    if (compareDayKeys(entry.date, startDate) < 0) {
      applyEntryToBalances(balances, entry);
      if (entry.accountId) {
        updateMinBalance(minBalanceByAccount, entry.accountId, entry.date, balances[entry.accountId] || 0);
      }
      if (entry.toAccountId) {
        updateMinBalance(minBalanceByAccount, entry.toAccountId, entry.date, balances[entry.toAccountId] || 0);
      }
      continue;
    }

    if (!rangeStartSnapshot) {
      rangeStartSnapshot = buildSnapshot(cashAccounts, balances, startDate);
      snapshotsByDate.set(startDate, rangeStartSnapshot);
      for (const account of cashAccounts) {
        updateMinBalance(minBalanceByAccount, account.id, startDate, rangeStartSnapshot.balances[account.id] || 0);
      }
    }

    applyEntryToBalances(balances, entry);
    const totalAfter = totalBalanceForAccounts(cashAccounts, balances);
    const enrichedEntry = {
      ...entry,
      account: accountMap[entry.accountId] || null,
      toAccount: entry.toAccountId ? accountMap[entry.toAccountId] || null : null,
      accountBalanceAfter: entry.accountId ? roundMoney(balances[entry.accountId] || 0) : null,
      toAccountBalanceAfter: entry.toAccountId ? roundMoney(balances[entry.toAccountId] || 0) : null,
      totalBalanceAfter: totalAfter,
    };
    entriesInRange.push(enrichedEntry);
    snapshotsByDate.set(entry.date, buildSnapshot(accounts, balances, entry.date));
    if (entry.accountId) {
      updateMinBalance(minBalanceByAccount, entry.accountId, entry.date, balances[entry.accountId] || 0);
    }
    if (entry.toAccountId) {
      updateMinBalance(minBalanceByAccount, entry.toAccountId, entry.date, balances[entry.toAccountId] || 0);
    }
  }

  if (!rangeStartSnapshot) {
    rangeStartSnapshot = buildSnapshot(cashAccounts, balances, startDate);
    snapshotsByDate.set(startDate, rangeStartSnapshot);
    for (const account of cashAccounts) {
      updateMinBalance(minBalanceByAccount, account.id, startDate, rangeStartSnapshot.balances[account.id] || 0);
    }
  }

  const chartSeries = [];
  let cursor = startDate;
  let currentSnapshot = rangeStartSnapshot;
  while (compareDayKeys(cursor, endDate) <= 0) {
    if (snapshotsByDate.has(cursor)) {
      currentSnapshot = snapshotsByDate.get(cursor);
    } else {
      currentSnapshot = {
        ...currentSnapshot,
        date: cursor,
        label: formatShortDate(cursor),
      };
    }
    chartSeries.push({
      ...currentSnapshot,
      date: cursor,
      label: formatShortDate(cursor),
    });
    cursor = addDays(cursor, 1);
  }

  const visibleEntries = entriesInRange.filter((entry) => {
    if (accountFilter === 'all') return true;
    return entry.accountId === accountFilter || entry.toAccountId === accountFilter;
  });
  const visibleBalances = { ...rangeStartSnapshot.balances };
  const visibleEntriesWithBalances = sortEntries(visibleEntries).map((entry) => {
    applyEntryToBalances(visibleBalances, entry);
    return {
      ...entry,
      accountBalanceAfter: entry.accountId ? roundMoney(visibleBalances[entry.accountId] || 0) : null,
      toAccountBalanceAfter: entry.toAccountId ? roundMoney(visibleBalances[entry.toAccountId] || 0) : null,
      totalBalanceAfter: totalBalanceForAccounts(cashAccounts, visibleBalances),
    };
  });

  const totals = {
    income: 0,
    expenses: 0,
    projectedExpenses: 0,
    projectedIncome: 0,
    actualExpenses: 0,
    actualIncome: 0,
  };

  for (const entry of entriesInRange) {
    if (entry.direction === 'income') {
      totals.income += entry.amount;
      if (entry.status === 'projected') totals.projectedIncome += entry.amount;
      if (entry.status === 'actual' || entry.status === 'cleared') totals.actualIncome += entry.amount;
    }
    if (entry.direction === 'expense') {
      totals.expenses += entry.amount;
      if (entry.status === 'projected') totals.projectedExpenses += entry.amount;
      if (entry.status === 'actual' || entry.status === 'cleared') totals.actualExpenses += entry.amount;
    }
  }

  totals.income = roundMoney(totals.income);
  totals.expenses = roundMoney(totals.expenses);
  totals.projectedExpenses = roundMoney(totals.projectedExpenses);
  totals.projectedIncome = roundMoney(totals.projectedIncome);
  totals.actualExpenses = roundMoney(totals.actualExpenses);
  totals.actualIncome = roundMoney(totals.actualIncome);

  const accountSummaries = cashAccounts.map((account) => {
    const startBalance = rangeStartSnapshot.balances[account.id] || 0;
    const endBalance = chartSeries.length ? chartSeries[chartSeries.length - 1].balances[account.id] || 0 : startBalance;
    const minBalance = minBalanceByAccount[account.id] || { amount: startBalance, date: startDate };
    const minimumBalance = toNumber(account.minimumBalance, 0);
    const warningBalanceForAccount = toNumber(account.warningBalance, warningThreshold);
    return {
      ...account,
      startBalance: roundMoney(startBalance),
      endBalance: roundMoney(endBalance),
      delta: roundMoney(endBalance - startBalance),
      minBalance: roundMoney(minBalance.amount),
      minBalanceDate: minBalance.date,
      needsAttention: minBalance.amount < minimumBalance,
      lowCash: minBalance.amount >= minimumBalance && minBalance.amount < warningBalanceForAccount,
      warningBalance: warningBalanceForAccount,
      minimumBalance,
    };
  });

  const warnings = accountSummaries
    .filter((account) => account.needsAttention || account.lowCash)
    .sort((left, right) => left.minBalance - right.minBalance)
    .map((account) => ({
      accountId: account.id,
      accountName: account.name,
      minBalance: account.minBalance,
      minBalanceDate: account.minBalanceDate,
      severity: account.needsAttention ? 'below-floor' : 'low-cash',
      minimumBalance: account.minimumBalance,
      warningBalance: account.warningBalance,
    }));

  return {
    chartSeries,
    allEntries: entriesInRange,
    visibleEntries: visibleEntriesWithBalances,
    rangeStartSnapshot,
    rangeEndSnapshot: chartSeries.length ? chartSeries[chartSeries.length - 1] : rangeStartSnapshot,
    totals,
    accountSummaries,
    warnings,
  };
}

export function buildBudgetInsights({ budgets, entries, monthKey }) {
  const monthlyBudgets = budgets.filter((budget) => budget.month === monthKey);
  const relevantEntries = entries.filter((entry) => (
    entry.date.startsWith(monthKey)
    && entry.direction !== 'opening'
    && entry.category
  ));

  const totalsByBucket = new Map();
  relevantEntries.forEach((entry) => {
    const bucketKey = `${entry.direction}|${String(entry.category || '').trim().toLowerCase()}`;
    const existing = totalsByBucket.get(bucketKey) || {
      actual: 0,
      projected: 0,
      total: 0,
      category: entry.category,
      direction: entry.direction,
    };
    if (entry.status === 'projected') {
      existing.projected = roundMoney(existing.projected + entry.amount);
    } else {
      existing.actual = roundMoney(existing.actual + entry.amount);
    }
    existing.total = roundMoney(existing.total + entry.amount);
    totalsByBucket.set(bucketKey, existing);
  });

  const summaries = monthlyBudgets.map((budget) => {
    const bucketKey = `${budget.direction}|${budget.category.trim().toLowerCase()}`;
    const totals = totalsByBucket.get(bucketKey) || { actual: 0, projected: 0, total: 0 };
    const limitRemaining = roundMoney(budget.amount - totals.total);
    const goalRemaining = roundMoney(Math.max(0, budget.amount - totals.total));
    const isLimit = budget.mode === 'limit';
    const isExpense = budget.direction === 'expense';
    const overBudget = isLimit && isExpense && totals.total > budget.amount;
    const goalMet = !isLimit && totals.total >= budget.amount;
    const progressPercent = budget.amount > 0 ? Math.min(999, roundMoney((totals.total / budget.amount) * 100)) : 0;
    return {
      ...budget,
      actual: totals.actual,
      projectedOnly: totals.projected,
      totalProjected: totals.total,
      remaining: isLimit ? limitRemaining : goalRemaining,
      overBudget,
      goalMet,
      progressPercent,
      status: overBudget ? 'over' : goalMet ? 'met' : isLimit ? 'on-track' : 'in-progress',
    };
  });

  const warnings = summaries.filter((summary) => summary.overBudget);
  const totals = {
    budgeted: roundMoney(monthlyBudgets.reduce((sum, budget) => sum + budget.amount, 0)),
    actual: roundMoney(summaries.reduce((sum, summary) => sum + summary.actual, 0)),
    projected: roundMoney(summaries.reduce((sum, summary) => sum + summary.totalProjected, 0)),
    warnings: warnings.length,
  };

  return {
    summaries,
    warnings,
    totals,
  };
}

export function describeRecurringRule(rule, accountMap) {
  const everyText = `Every ${rule.frequencyInterval} ${rule.frequencyUnit}${rule.frequencyInterval === 1 ? '' : 's'}`;
  const parts = [everyText];

  if (rule.frequencyUnit === 'week' && Number.isInteger(rule.weekday)) {
    const weekdayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][rule.weekday];
    parts.push(`on ${weekdayName}`);
  }

  if (rule.frequencyUnit === 'month' && Number.isInteger(rule.monthDay)) {
    parts.push(`on day ${rule.monthDay}`);
  }

  if (rule.maxOccurrences) {
    parts.push(`for ${rule.maxOccurrences} payments`);
  } else if (rule.endsOn) {
    parts.push(`through ${formatDateLabel(rule.endsOn)}`);
  } else {
    parts.push('until you stop it');
  }

  if (rule.direction === 'transfer') {
    const from = accountMap[rule.accountId]?.name || 'Source account';
    const to = accountMap[rule.toAccountId]?.name || 'Destination account';
    parts.push(`from ${from} to ${to}`);
  } else {
    const account = accountMap[rule.accountId]?.name || 'Selected account';
    parts.push(`for ${account}`);
  }

  return parts.join(' ');
}

export function getRulePreview(rule, recurringOverrides, transactions, daysAhead = 180) {
  const endDate = addDays(getTodayKey(), daysAhead);
  return expandRecurringRules([rule], recurringOverrides, transactions, endDate).slice(0, 6);
}
