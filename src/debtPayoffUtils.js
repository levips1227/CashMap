import { budgetApi } from './api';
import { addMonths, fixedPIForLoan, round2, toISODate } from './legacyLoanEngine';

export const PAYOFF_METHODS = [
  { id: 'avalanche', label: 'Highest interest first' },
  { id: 'snowball', label: 'Lowest balance first' },
  { id: 'custom', label: 'Table order' },
];

const FREQ_PER_YEAR = { Monthly: 12, Biweekly: 26, Weekly: 52, Quarterly: 4, Annual: 1 };

export function numericDebtValue(value) {
  const parsed = Number(String(value ?? '').replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatDebtInput(value) {
  if (value === '' || value === null || value === undefined) return '';
  return String(round2(numericDebtValue(value)));
}

function monthlyPaymentFromLoan(loan) {
  const frequency = loan.PaymentFrequency || 'Monthly';
  const periodsPerYear = FREQ_PER_YEAR[frequency] || 12;
  const periodPayment = numericDebtValue(loan.MinimumPayment) > 0
    ? numericDebtValue(loan.MinimumPayment)
    : fixedPIForLoan(loan);
  const monthlyEscrow = numericDebtValue(loan.EscrowMonthly);
  return round2((periodPayment * periodsPerYear) / 12 + monthlyEscrow);
}

function currentBalanceForLoan(loan, payments, draws) {
  const principalPaid = payments
    .filter((payment) => payment.LoanRef === loan.id)
    .reduce((sum, payment) => sum + numericDebtValue(payment.PrincipalPortion), 0);
  const drawTotal = draws
    .filter((draw) => draw.LoanRef === loan.id)
    .reduce((sum, draw) => sum + numericDebtValue(draw.Amount), 0);
  return Math.max(0, round2(numericDebtValue(loan.OriginalPrincipal) - principalPaid + drawTotal));
}

function loanToDebtRow(loan, payments, draws) {
  return {
    id: `loan-${loan.id}`,
    sourceLoanId: loan.id,
    creditor: loan.BorrowerName || loan.LoanID || 'Loan',
    balance: formatDebtInput(currentBalanceForLoan(loan, payments, draws)),
    apr: String(round2(numericDebtValue(loan.APR) * 100)),
    minimumPayment: formatDebtInput(monthlyPaymentFromLoan(loan)),
  };
}

export async function buildLoanDebtRows() {
  const response = await budgetApi.getLegacyLoanState();
  const state = response.state || {};
  const loans = Array.isArray(state.loans) ? state.loans : [];
  const payments = Array.isArray(state.payments) ? state.payments : [];
  const draws = Array.isArray(state.draws) ? state.draws : [];
  return loans
    .filter((loan) => (loan.Status || 'Active') !== 'Closed')
    .map((loan) => loanToDebtRow(loan, payments, draws))
    .filter((row) => numericDebtValue(row.balance) > 0);
}

export function createBlankDebtRow() {
  return {
    id: `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sourceLoanId: null,
    creditor: '',
    balance: '',
    apr: '',
    minimumPayment: '',
  };
}

export function mergeLoanDebtRows(currentRows, loanRows, { includeNewLoans = false } = {}) {
  const current = Array.isArray(currentRows) ? currentRows : [];
  const loanRowMap = new Map(loanRows.map((row) => [row.sourceLoanId, row]));
  const nextRows = current
    .map((row) => {
      if (!row.sourceLoanId) return row;
      const latest = loanRowMap.get(row.sourceLoanId);
      if (!latest) return null;
      return {
        ...row,
        creditor: latest.creditor,
        balance: latest.balance,
        apr: latest.apr,
        minimumPayment: latest.minimumPayment,
      };
    })
    .filter(Boolean);

  if (includeNewLoans) {
    const existingLoanIds = new Set(nextRows.map((row) => row.sourceLoanId).filter(Boolean));
    loanRows.forEach((row) => {
      if (!existingLoanIds.has(row.sourceLoanId)) {
        nextRows.push(row);
      }
    });
  }

  return nextRows.length ? nextRows : [createBlankDebtRow()];
}

function monthLabelFromOffset(month) {
  if (!month) return '';
  return toISODate(addMonths(new Date(), month)).slice(0, 7);
}

export function formatPayoffMonth(month) {
  if (!month) return '-';
  const date = addMonths(new Date(), month);
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function formatPayoffLength(months) {
  if (!months) return '-';
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (!years) return `${months} month${months === 1 ? '' : 's'}`;
  if (!rest) return `${months} months (${years} year${years === 1 ? '' : 's'})`;
  return `${months} months (${years} yr ${rest} mo)`;
}

function formatScheduleAmount(value) {
  return numericDebtValue(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPaymentSchedule(summary) {
  return summary.scheduleSegments.map((segment, index) => {
    const amount = formatScheduleAmount(segment.amount);
    const isFinal = summary.payoffMonth && segment.endMonth === summary.payoffMonth;
    const prefix = index === 0 || isFinal ? 'Pay' : 'Then pay';

    if (isFinal && segment.startMonth === segment.endMonth) {
      return `Pay $${amount} at month ${segment.endMonth} to payoff.`;
    }
    if (isFinal) {
      return `${prefix} $${amount} until month ${segment.endMonth} to payoff.`;
    }
    return `${prefix} $${amount} until month ${segment.endMonth}.`;
  });
}

function getPayoffOrder(rows, method) {
  const active = rows.filter((row) => row.balance > 0);
  if (method === 'snowball') {
    return [...active].sort((left, right) => left.balance - right.balance || right.apr - left.apr);
  }
  if (method === 'custom') {
    return active;
  }
  return [...active].sort((left, right) => right.apr - left.apr || left.balance - right.balance);
}

function buildExtraForMonth(month, extras = {}) {
  const yearly = Math.max(0, numericDebtValue(extras.yearly));
  const oneTimeAmount = Math.max(0, numericDebtValue(extras.oneTimeAmount));
  const oneTimeMonth = Math.max(1, Math.round(numericDebtValue(extras.oneTimeMonth)));
  let amount = 0;
  if (yearly > 0 && month % 12 === 0) amount = round2(amount + yearly);
  if (oneTimeAmount > 0 && oneTimeMonth === month) amount = round2(amount + oneTimeAmount);
  return amount;
}

export function calculateDebtPayoff(rows, method, extras = {}, fixedTotalPayment = true) {
  let debts = rows
    .map((row, index) => ({
      ...row,
      index,
      balance: round2(numericDebtValue(row.balance)),
      apr: numericDebtValue(row.apr) / 100,
      minimumPayment: round2(Math.max(0, numericDebtValue(row.minimumPayment))),
    }))
    .filter((row) => row.creditor.trim() && row.balance > 0);

  if (!debts.length) {
    return {
      months: 0,
      payoffDate: null,
      totalInterest: 0,
      totalPaid: 0,
      timeline: [],
      debtSummaries: [],
    };
  }

  const startMinimums = debts.reduce((sum, debt) => sum + debt.minimumPayment, 0);
  const baseMonthlyBudget = round2(startMinimums + Math.max(0, numericDebtValue(extras.monthly)));
  const summaries = new Map(debts.map((debt) => [debt.id, {
    id: debt.id,
    creditor: debt.creditor,
    startingBalance: debt.balance,
    interestPaid: 0,
    totalPaid: 0,
    payoffMonth: null,
    payoffDate: null,
    scheduleSegments: [],
  }]));
  const timeline = [];

  for (let month = 1; month <= 1200 && debts.some((debt) => debt.balance > 0); month += 1) {
    debts = debts.map((debt) => {
      if (debt.balance <= 0) return debt;
      const interest = round2(debt.balance * debt.apr / 12);
      const summary = summaries.get(debt.id);
      summary.interestPaid = round2(summary.interestPaid + interest);
      return { ...debt, balance: round2(debt.balance + interest), currentInterest: interest };
    });

    const activeDebts = debts.filter((debt) => debt.balance > 0);
    const ordered = getPayoffOrder(activeDebts, method);
    const extraForMonth = buildExtraForMonth(month, extras);
    const activeMinimums = activeDebts.reduce((sum, debt) => sum + debt.minimumPayment, 0);
    let remainingBudget = fixedTotalPayment
      ? round2(baseMonthlyBudget + extraForMonth)
      : round2(activeMinimums + Math.max(0, numericDebtValue(extras.monthly)) + extraForMonth);
    const payments = [];

    for (const debt of activeDebts) {
      if (remainingBudget <= 0) break;
      const payment = Math.min(debt.balance, Math.min(debt.minimumPayment, remainingBudget));
      if (payment <= 0) continue;
      remainingBudget = round2(remainingBudget - payment);
      payments.push({ debtId: debt.id, payment });
    }

    for (const target of ordered) {
      if (remainingBudget <= 0) break;
      const alreadyPaid = payments
        .filter((payment) => payment.debtId === target.id)
        .reduce((sum, payment) => sum + payment.payment, 0);
      const availableBalance = round2(target.balance - alreadyPaid);
      if (availableBalance <= 0) continue;
      const payment = Math.min(availableBalance, remainingBudget);
      remainingBudget = round2(remainingBudget - payment);
      payments.push({ debtId: target.id, payment });
    }

    const monthlyPayments = new Map();
    payments.forEach((payment) => {
      monthlyPayments.set(payment.debtId, round2((monthlyPayments.get(payment.debtId) || 0) + payment.payment));
    });

    debts = debts.map((debt) => {
      const paid = round2(monthlyPayments.get(debt.id) || 0);
      if (!paid) return debt;
      const nextBalance = round2(Math.max(0, debt.balance - paid));
      const summary = summaries.get(debt.id);
      summary.totalPaid = round2(summary.totalPaid + paid);
      if (nextBalance <= 0 && !summary.payoffMonth) {
        summary.payoffMonth = month;
        summary.payoffDate = monthLabelFromOffset(month);
      }
      return { ...debt, balance: nextBalance };
    });

    monthlyPayments.forEach((paymentAmount, debtId) => {
      const summary = summaries.get(debtId);
      if (!summary || paymentAmount <= 0) return;
      const previous = summary.scheduleSegments[summary.scheduleSegments.length - 1];
      if (previous && Math.abs(previous.amount - paymentAmount) < 0.005 && previous.endMonth === month - 1) {
        previous.endMonth = month;
        return;
      }
      summary.scheduleSegments.push({
        startMonth: month,
        endMonth: month,
        amount: round2(paymentAmount),
      });
    });

    timeline.push({
      month,
      date: toISODate(addMonths(new Date(), month)),
      totalBalance: round2(debts.reduce((sum, debt) => sum + debt.balance, 0)),
      interest: round2(debts.reduce((sum, debt) => sum + (debt.currentInterest || 0), 0)),
      payment: round2(payments.reduce((sum, payment) => sum + payment.payment, 0)),
    });
  }

  const months = timeline.length;
  const totalInterest = round2([...summaries.values()].reduce((sum, item) => sum + item.interestPaid, 0));
  const totalPaid = round2([...summaries.values()].reduce((sum, item) => sum + item.totalPaid, 0));
  const startingPrincipal = round2([...summaries.values()].reduce((sum, item) => sum + item.startingBalance, 0));
  const debtSummaries = [...summaries.values()].map((summary) => ({
    ...summary,
    paymentSchedule: formatPaymentSchedule(summary),
  }));

  return {
    months,
    payoffDate: months ? timeline[timeline.length - 1].date : null,
    payoffLabel: formatPayoffMonth(months),
    payoffLength: formatPayoffLength(months),
    totalInterest,
    totalPaid,
    startingPrincipal,
    principalShare: totalPaid > 0 ? round2((startingPrincipal / totalPaid) * 100) : 0,
    interestShare: totalPaid > 0 ? round2((totalInterest / totalPaid) * 100) : 0,
    monthlyBudget: baseMonthlyBudget,
    timeline,
    debtSummaries,
  };
}
