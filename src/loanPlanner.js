import {
  addDays,
  addMonths,
  addYears,
  computePayoffDate,
  daysBetween,
  fixedPIForLoan,
  parseISO,
  projectWithExtras,
  round2,
  toISODate,
} from './loanEngine';

const PERIODS_PER_YEAR = {
  Monthly: 12,
  Biweekly: 26,
  Weekly: 52,
  Quarterly: 4,
  Annual: 1,
};

function periodsPerYear(frequency) {
  return PERIODS_PER_YEAR[frequency] || 12;
}

function isAmortizedType(type) {
  return ['Mortgage', 'Car Loan', 'Personal Loan', 'Student Loan', 'Other Debt'].includes(type);
}

function nextByFrequency(value, frequency) {
  if (frequency === 'Weekly') return addDays(value, 7);
  if (frequency === 'Biweekly') return addDays(value, 14);
  if (frequency === 'Quarterly') return addMonths(value, 3);
  if (frequency === 'Annual') return addYears(value, 1);
  return addMonths(value, 1);
}

function periodEscrowAmount(paymentFrequency, escrowMonthly) {
  const yearly = periodsPerYear(paymentFrequency);
  return round2(((Number(escrowMonthly) || 0) * 12) / yearly);
}

function normalizeLoan(account) {
  const details = account?.loanDetails;
  if (!account || !details) return null;
  const originalPrincipal = Number(details.originalPrincipal) || Number(details.currentBalance) || 0;
  return {
    id: account.id,
    LoanID: `ACCT-${account.id}`,
    BorrowerName: details.borrowerName || account.name,
    LoanType: details.loanType || account.accountType || 'Mortgage',
    APR: round2((Number(details.aprPercent) || 0) / 100),
    PaymentFrequency: details.paymentFrequency || 'Monthly',
    TermMonths: Number(details.termMonths) || 360,
    OriginationDate: details.originationDate || details.balanceAsOfDate,
    NextPaymentDate: details.nextPaymentDate || details.balanceAsOfDate,
    OriginalPrincipal: originalPrincipal,
    EscrowMonthly: Number(details.escrowMonthly) || 0,
    GraceDays: Number(details.graceDays) || 0,
    FixedPayment: details.fixedPayment !== false,
    MinimumPayment: Number(details.minimumPayment) || 0,
    AccountNumber: details.accountNumber || '',
    BorrowerAddress: details.borrowerAddress || '',
    PropertyAddress: details.propertyAddress || '',
    ServicerName: details.servicerName || account.institution || '',
    ServicerAddress: details.servicerAddress || '',
    ServicerPhone: details.servicerPhone || '',
    ServicerWebsite: details.servicerWebsite || '',
    StatementMessage: details.statementMessage || '',
    LateFeeFlat: Number(details.lateFeeFlat) || 0,
    LateFeePct: Number(details.lateFeePct) || 0,
  };
}

function scheduledPrincipalInterestFor(loan, balance) {
  if (loan.MinimumPayment > 0) return loan.MinimumPayment;
  const yearly = periodsPerYear(loan.PaymentFrequency);

  if (isAmortizedType(loan.LoanType) || loan.FixedPayment) {
    return fixedPIForLoan(loan);
  }

  if (loan.LoanType === 'Revolving LOC') {
    return round2(balance * loan.APR / yearly);
  }

  if (loan.LoanType === 'Credit Card') {
    const monthlyMinimum = Math.max(round2(balance * 0.02), 25);
    return round2((monthlyMinimum * 12) / yearly);
  }

  return fixedPIForLoan(loan);
}

function scheduledPaymentFor(loan, balance) {
  return round2(scheduledPrincipalInterestFor(loan, balance) + periodEscrowAmount(loan.PaymentFrequency, loan.EscrowMonthly));
}

function scheduledBreakdownFor(loan, balance) {
  const yearly = periodsPerYear(loan.PaymentFrequency);
  const escrow = periodEscrowAmount(loan.PaymentFrequency, loan.EscrowMonthly);
  const interest = round2(balance * loan.APR / yearly);
  const total = scheduledPaymentFor(loan, balance);
  const principal = round2(Math.max(0, total - interest - escrow));
  return {
    principal,
    interest,
    escrow,
    total,
  };
}

function normalizePayment(payment) {
  return {
    id: payment.id,
    accountId: Number(payment.accountId),
    paymentDate: payment.paymentDate,
    amount: Number(payment.amount) || 0,
    isScheduledInstallment: payment.isScheduledInstallment !== false,
    method: payment.method || 'ACH',
    reference: payment.reference || '',
    postedBy: payment.postedBy || 'You',
    postedAt: payment.postedAt || payment.createdAt || '',
  };
}

function normalizeDraw(draw) {
  return {
    id: draw.id,
    accountId: Number(draw.accountId),
    drawDate: draw.drawDate,
    amount: Number(draw.amount) || 0,
    notes: draw.notes || '',
  };
}

function buildComputedPaymentHistory({ loan, account, loanPayments = [], loanDraws = [] }) {
  const payments = loanPayments
    .filter((payment) => Number(payment.accountId) === Number(account.id))
    .map(normalizePayment);
  const draws = loanDraws
    .filter((draw) => Number(draw.accountId) === Number(account.id))
    .map(normalizeDraw);

  const events = [
    ...payments.map((payment) => ({ ...payment, kind: 'payment', date: payment.paymentDate })),
    ...draws.map((draw) => ({ ...draw, kind: 'draw', date: draw.drawDate })),
  ].sort((left, right) => left.date.localeCompare(right.date) || left.id - right.id);

  let balance = round2(loan.OriginalPrincipal || Number(account.loanDetails?.currentBalance) || 0);
  let totalPaid = 0;
  let totalPrincipal = 0;
  let totalInterest = 0;
  let totalEscrow = 0;
  const computedPayments = [];
  const computedDraws = [];

  for (const event of events) {
    if (event.kind === 'draw') {
      balance = round2(balance + event.amount);
      computedDraws.push({
        ...event,
        balance,
      });
      continue;
    }

    const scheduled = event.isScheduledInstallment !== false;
    const yearly = periodsPerYear(loan.PaymentFrequency);
    const accruedInterest = scheduled ? round2(balance * loan.APR / yearly) : 0;
    const escrowDue = scheduled ? periodEscrowAmount(loan.PaymentFrequency, loan.EscrowMonthly) : 0;
    const interest = Math.min(event.amount, accruedInterest);
    const afterInterest = round2(event.amount - interest);
    const escrow = Math.min(afterInterest, escrowDue);
    const principal = Math.min(balance, round2(afterInterest - escrow));

    balance = round2(Math.max(0, balance - principal));
    totalPaid = round2(totalPaid + event.amount);
    totalPrincipal = round2(totalPrincipal + principal);
    totalInterest = round2(totalInterest + interest);
    totalEscrow = round2(totalEscrow + escrow);

    computedPayments.push({
      ...event,
      principal,
      interest,
      escrow,
      balance,
      paid: totalPaid,
      principalPaid: totalPrincipal,
      interestPaid: totalInterest,
      escrowPaid: totalEscrow,
    });
  }

  return {
    payments: computedPayments,
    draws: computedDraws,
    balance,
    totals: {
      payment: totalPaid,
      principal: totalPrincipal,
      interest: totalInterest,
      escrow: totalEscrow,
      draws: round2(computedDraws.reduce((sum, draw) => sum + draw.amount, 0)),
    },
  };
}

function buildExtras(calculator = {}) {
  if (Array.isArray(calculator.extras)) {
    return calculator.extras
      .map((extra, index) => ({
        id: extra.id || `extra-${index}`,
        kind: extra.kind || 'recurring',
        amount: Number(extra.amount) || 0,
        every: extra.every || 'month',
        date: extra.date,
        start: extra.start,
      }))
      .filter((extra) => extra.amount > 0);
  }

  const extras = [];
  const monthlyExtra = Number(calculator.extraPerMonth) || 0;
  const oneOffExtra = Number(calculator.oneTimeExtra) || 0;
  if (monthlyExtra > 0) {
    extras.push({
      id: 'monthly-extra',
      kind: 'recurring',
      amount: monthlyExtra,
      every: 'month',
      start: calculator.nextPaymentDate,
    });
  }
  if (oneOffExtra > 0 && calculator.oneTimeDate) {
    extras.push({
      id: 'one-time-extra',
      kind: 'once',
      amount: oneOffExtra,
      date: calculator.oneTimeDate,
    });
  }
  return extras;
}

function aggregateTimeline(timeline, mode = 'monthly') {
  const map = new Map();
  let lastPaid = 0;
  let lastInterest = 0;
  let lastPrincipal = 0;

  for (const entry of timeline || []) {
    const key = mode === 'yearly' ? entry.date.slice(0, 4) : entry.date.slice(0, 7);
    const existing = map.get(key) || {
      period: key,
      paid: 0,
      interest: 0,
      principal: 0,
      balance: entry.balance,
    };

    const paid = Number(entry.paid) || lastPaid;
    const interest = Number(entry.interestPaid) || lastInterest;
    const principal = Number(entry.principalPaid) || lastPrincipal;

    existing.paid = round2(existing.paid + Math.max(0, paid - lastPaid));
    existing.interest = round2(existing.interest + Math.max(0, interest - lastInterest));
    existing.principal = round2(existing.principal + Math.max(0, principal - lastPrincipal));
    existing.balance = entry.balance;
    map.set(key, existing);

    lastPaid = paid;
    lastInterest = interest;
    lastPrincipal = principal;
  }

  return [...map.values()].sort((left, right) => left.period.localeCompare(right.period));
}

function formatDuration(days) {
  if (!Number.isFinite(days) || days <= 0) return '0 days';
  if (days < 30) {
    const roundedDays = Math.round(days);
    return `${roundedDays} day${roundedDays === 1 ? '' : 's'}`;
  }
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  return `${years} year${years === 1 ? '' : 's'}${remainingMonths ? ` ${remainingMonths} mo` : ''}`;
}

function getMonthBounds(monthKey) {
  const [year, month] = String(monthKey || '').split('-').map(Number);
  if (!year || !month) return null;
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return {
    startDate: toISODate(start),
    endDate: toISODate(end),
  };
}

function buildMonthlyStatement({ account, loan, reportMonth, history, balanceStart }) {
  const bounds = getMonthBounds(reportMonth);
  if (!bounds) return null;

  const inMonth = (date) => date >= bounds.startDate && date <= bounds.endDate;
  const paymentsToDate = history.payments.filter((payment) => payment.paymentDate <= bounds.endDate);
  const paymentsInMonth = history.payments.filter((payment) => inMonth(payment.paymentDate));
  const drawsInMonth = history.draws.filter((draw) => inMonth(draw.drawDate));
  const paymentsInYear = history.payments.filter((payment) => (
    payment.paymentDate >= `${reportMonth.slice(0, 4)}-01-01` && payment.paymentDate <= bounds.endDate
  ));

  const sumPayments = (items) => items.reduce((acc, payment) => ({
    total: round2(acc.total + payment.amount),
    principal: round2(acc.principal + payment.principal),
    interest: round2(acc.interest + payment.interest),
    escrow: round2(acc.escrow + payment.escrow),
  }), {
    total: 0,
    principal: 0,
    interest: 0,
    escrow: 0,
  });

  const principalPaidToDate = paymentsToDate.reduce((sum, payment) => round2(sum + payment.principal), 0);
  const drawTotalToDate = history.draws
    .filter((draw) => draw.drawDate <= bounds.endDate)
    .reduce((sum, draw) => round2(sum + draw.amount), 0);
  const balanceEnd = round2((loan.OriginalPrincipal || balanceStart) - principalPaidToDate + drawTotalToDate);
  const scheduledBreakdown = scheduledBreakdownFor(loan, Math.max(0, balanceEnd));
  const dueDates = [];
  let due = parseISO(loan.NextPaymentDate || bounds.endDate);
  const statementEnd = parseISO(bounds.endDate);
  for (let guard = 0; guard < 2400 && !Number.isNaN(due.getTime()) && due <= statementEnd; guard += 1) {
    dueDates.push(toISODate(due));
    due = nextByFrequency(due, loan.PaymentFrequency);
  }
  const scheduledPaymentsMade = paymentsToDate.filter((payment) => payment.isScheduledInstallment !== false).length;
  const overdueCount = Math.max(0, dueDates.length - scheduledPaymentsMade);
  const overdueAmount = round2(overdueCount * scheduledBreakdown.total);
  const totalDue = round2(scheduledBreakdown.total + overdueAmount);

  return {
    statementDate: bounds.endDate,
    periodStart: bounds.startDate,
    periodEnd: bounds.endDate,
    dueDate: loan.NextPaymentDate,
    accountNumber: loan.AccountNumber,
    borrowerName: loan.BorrowerName || account.name,
    borrowerAddress: loan.BorrowerAddress,
    propertyAddress: loan.PropertyAddress,
    servicerName: loan.ServicerName || account.institution || account.name,
    servicerAddress: loan.ServicerAddress,
    servicerPhone: loan.ServicerPhone,
    servicerWebsite: loan.ServicerWebsite,
    statementMessage: loan.StatementMessage || 'Please contact the servicer with any questions about this statement.',
    statusLabel: overdueCount > 0 ? `Past Due (${overdueCount})` : 'Active',
    maturityDate: loan.OriginationDate ? toISODate(addMonths(loan.OriginationDate, loan.TermMonths || 0)) : '',
    payoffDate: computePayoffDate(loan, Math.max(0, balanceEnd), loan.NextPaymentDate),
    scheduledBreakdown,
    overdueAmount,
    totalDue,
    balanceEnd,
    drawsInMonthTotal: round2(drawsInMonth.reduce((sum, draw) => sum + draw.amount, 0)),
    transactions: [
      ...paymentsInMonth.map((payment) => ({
        key: `payment-${payment.id}`,
        date: payment.paymentDate,
        description: payment.isScheduledInstallment === false ? 'Principal-only payment' : 'Payment received',
        charge: 0,
        payment: payment.amount,
      })),
      ...drawsInMonth.map((draw) => ({
        key: `draw-${draw.id}`,
        date: draw.drawDate,
        description: 'Draw',
        charge: draw.amount,
        payment: 0,
      })),
    ].sort((left, right) => left.date.localeCompare(right.date)),
    totalsInMonth: sumPayments(paymentsInMonth),
    totalsInYear: sumPayments(paymentsInYear),
    totalsToEnd: sumPayments(paymentsToDate),
  };
}

function buildChartRows(baseProjection, scenarioProjection) {
  const maxRows = 180;
  const rows = [];
  const scenarioByDate = new Map((scenarioProjection.timeline || []).map((entry) => [entry.date, entry]));
  for (const entry of (baseProjection.timeline || []).slice(0, maxRows)) {
    const scenario = scenarioByDate.get(entry.date);
    rows.push({
      date: entry.date,
      label: entry.date.slice(0, 7),
      scheduledBalance: entry.balance,
      scenarioBalance: scenario?.balance ?? null,
      principal: entry.principal,
      interest: entry.interest,
    });
  }
  return rows;
}

export function createLoanScenarioExtra(kind = 'recurring') {
  const today = toISODate(new Date());
  return {
    id: `extra-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind,
    amount: '',
    every: 'month',
    date: today,
    start: today,
  };
}

export function buildLoanInsights(account, calculator = {}, reportMonth = '', loanPayments = [], loanDraws = []) {
  if (!account?.loanDetails) return null;

  const loan = normalizeLoan(account);
  if (!loan) return null;

  const history = buildComputedPaymentHistory({
    loan,
    account,
    loanPayments,
    loanDraws,
  });
  const hasActivity = history.payments.length || history.draws.length;
  const snapshotBalance = Number(account.loanDetails.currentBalance) || 0;
  const currentBalance = hasActivity ? history.balance : snapshotBalance;
  const originalPrincipal = loan.OriginalPrincipal || currentBalance;
  const principalPaid = round2(Math.max(0, originalPrincipal - currentBalance));
  const scheduledPayment = scheduledPaymentFor(loan, currentBalance);
  const scheduledBreakdown = scheduledBreakdownFor(loan, currentBalance);
  const scheduledDone = history.payments.filter((payment) => payment.isScheduledInstallment !== false).length;
  const baseProjection = projectWithExtras({
    loan,
    balanceStart: currentBalance,
    nextDueDate: loan.NextPaymentDate,
    extras: [],
    scheduledDone,
  });
  const scenarioExtras = buildExtras({ ...calculator, nextPaymentDate: loan.NextPaymentDate });
  const scenarioProjection = projectWithExtras({
    loan,
    balanceStart: currentBalance,
    nextDueDate: loan.NextPaymentDate,
    extras: scenarioExtras,
    scheduledDone,
  });

  const scenarioTimeSavedDays = baseProjection.payoffDate && scenarioProjection.payoffDate
    ? Math.max(0, daysBetween(scenarioProjection.payoffDate, baseProjection.payoffDate))
    : 0;
  const progressPercent = originalPrincipal > 0
    ? Math.min(100, Math.max(0, round2((principalPaid / originalPrincipal) * 100)))
    : 0;

  const activeReportMonth = reportMonth || toISODate(new Date()).slice(0, 7);
  const report = buildMonthlyStatement({
    account,
    loan,
    reportMonth: activeReportMonth,
    history,
    balanceStart: currentBalance,
  });

  return {
    loan,
    history,
    summary: {
      currentBalance,
      originalPrincipal,
      principalPaid,
      progressPercent,
      balanceAsOfDate: account.loanDetails.balanceAsOfDate,
      scheduledPayment,
      scheduledBreakdown,
      payoffDate: computePayoffDate(loan, currentBalance, loan.NextPaymentDate) || baseProjection.payoffDate,
      totalInterestRemaining: baseProjection.totals.totalInterest,
      totalProjectedPaid: baseProjection.totals.totalPaid,
      nextPaymentDate: loan.NextPaymentDate,
      lifetimePaid: round2(history.totals.payment + baseProjection.totals.totalPaid),
      paymentsPosted: history.payments.length,
    },
    baseProjection,
    scenarioProjection,
    scenario: {
      extras: scenarioExtras,
      timeSavedDays: scenarioTimeSavedDays,
      timeSavedLabel: formatDuration(scenarioTimeSavedDays),
      interestSaved: round2(baseProjection.totals.totalInterest - scenarioProjection.totals.totalInterest),
      paymentSaved: round2(baseProjection.totals.totalPaid - scenarioProjection.totals.totalPaid),
    },
    chartRows: buildChartRows(baseProjection, scenarioProjection),
    monthlyRollup: aggregateTimeline(baseProjection.timeline, 'monthly'),
    yearlyRollup: aggregateTimeline(baseProjection.timeline, 'yearly'),
    report,
    recommendedOneTimeDate: loan.NextPaymentDate || account.loanDetails.balanceAsOfDate || toISODate(addMonths(new Date(), 1)),
  };
}
