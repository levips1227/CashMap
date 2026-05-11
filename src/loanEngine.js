export const EPS = 1e-6;
export const round2 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

export function parseISO(value) {
  if (!value) return new Date(NaN);
  if (value instanceof Date) return new Date(value.getTime());
  const parts = String(value).split('-').map(Number);
  if (parts.length === 3 && parts.every((item) => Number.isFinite(item))) {
    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  }
  return new Date(value);
}

export function toISODate(value) {
  const date = parseISO(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

export function daysBetween(left, right) {
  const leftTime = parseISO(toISODate(left)).getTime();
  const rightTime = parseISO(toISODate(right)).getTime();
  return Math.max(0, Math.round((rightTime - leftTime) / (1000 * 60 * 60 * 24)));
}

export function addDays(value, days) {
  const date = parseISO(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

export function addMonths(value, months) {
  const date = parseISO(value);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(year, month + months, 1));
  const endOfTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0));
  const clampedDay = Math.min(day, endOfTarget.getUTCDate());
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), clampedDay));
}

export function addYears(value, years) {
  const date = parseISO(value);
  return new Date(Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth(), date.getUTCDate()));
}

const EXTRA_FREQUENCY = { day: 365, week: 52, month: 12, year: 1 };
const PERIODS_PER_YEAR = { Monthly: 12, Biweekly: 26, Weekly: 52, Quarterly: 4, Annual: 1 };

function periodsPerYear(frequency) {
  return PERIODS_PER_YEAR[frequency] || 12;
}

function advanceByFrequency(value, frequency) {
  if (frequency === 'Weekly') return addDays(value, 7);
  if (frequency === 'Biweekly') return addDays(value, 14);
  if (frequency === 'Quarterly') return addMonths(value, 3);
  if (frequency === 'Annual') return addYears(value, 1);
  return addMonths(value, 1);
}

function advanceByPeriods(value, frequency, periods) {
  let date = parseISO(value);
  for (let index = 0; index < periods; index += 1) {
    date = advanceByFrequency(date, frequency);
  }
  return date;
}

export function amortizedPayment(principal, apr, periods, periodsYearly) {
  if (periods <= 0) return 0;
  const rate = (apr ?? 0) / periodsYearly;
  if (Math.abs(rate) < EPS) return round2((principal ?? 0) / periods);
  const payment = (principal ?? 0) * (rate * Math.pow(1 + rate, periods)) / (Math.pow(1 + rate, periods) - 1);
  return round2(Math.max(0, payment));
}

export function fixedPIForLoan(loan) {
  const frequency = loan.PaymentFrequency || 'Monthly';
  const yearly = periodsPerYear(frequency);
  const periods = Math.max(1, Math.round(((loan.TermMonths || 0) * yearly) / 12));
  return amortizedPayment(loan.OriginalPrincipal ?? 0, loan.APR, periods, yearly);
}

function expandExtrasMap(extras, startDate, maxYears = 100) {
  const map = new Map();
  if (!Array.isArray(extras)) return map;
  const endDate = addYears(startDate, maxYears);
  for (const extra of extras) {
    if (!extra || !(extra.amount > 0)) continue;
    if (extra.kind === 'once') {
      const parsed = parseISO(extra.date || startDate);
      if (Number.isNaN(parsed.getTime())) continue;
      const aligned = parsed < startDate ? startDate : parsed;
      const key = toISODate(aligned);
      if (aligned <= endDate) {
        map.set(key, round2((map.get(key) || 0) + round2(extra.amount)));
      }
      continue;
    }

    const every = extra.every || 'month';
    let when = parseISO(extra.start || startDate);
    if (Number.isNaN(when.getTime())) when = startDate;
    if (when < startDate) when = startDate;

    for (let guard = 0; guard < (EXTRA_FREQUENCY[every] || 12) * maxYears; guard += 1) {
      if (when > endDate) break;
      const key = toISODate(when);
      map.set(key, round2((map.get(key) || 0) + round2(extra.amount)));
      if (every === 'day') when = addDays(when, 1);
      else if (every === 'week') when = addDays(when, 7);
      else if (every === 'month') when = addMonths(when, 1);
      else if (every === 'year') when = addYears(when, 1);
    }
  }
  return map;
}

function loanPaymentAmount(loan) {
  return loan.MinimumPayment > 0 ? round2(loan.MinimumPayment) : fixedPIForLoan(loan);
}

export function computePayoffDate(loan, balanceStart, nextDueDate) {
  let balance = round2(balanceStart ?? 0);
  if (balance <= 0) return null;

  const apr = loan.APR ?? 0;
  const frequency = loan.PaymentFrequency || 'Monthly';
  const yearly = periodsPerYear(frequency);
  const payment = loanPaymentAmount(loan);
  const firstDue = parseISO(nextDueDate || loan.NextPaymentDate || addMonths(parseISO(loan.OriginationDate), 1));
  const remainingPeriods = Math.max(1, Math.round(((loan.TermMonths || 1) * yearly) / 12));

  let date = firstDue;
  for (let guard = 0; guard < Math.max(remainingPeriods + 120, 2400); guard += 1) {
    const interest = round2(balance * apr / yearly);
    const principal = Math.max(0, round2(payment - interest));
    if (principal <= 0) return null;
    balance = round2(Math.max(0, balance - principal));
    if (balance <= EPS) {
      return toISODate(date);
    }
    date = advanceByFrequency(date, frequency);
  }

  return null;
}

export function projectWithExtras({ loan, balanceStart, nextDueDate, extras = [], scheduledDone = 0 }) {
  let balance = round2(balanceStart ?? 0);
  if (balance <= 0) {
    return {
      timeline: [],
      payoffDate: null,
      totals: { totalPaid: 0, totalInterest: 0, totalPrincipal: 0 },
      balanceEnd: 0,
      schedule: [],
    };
  }

  const apr = loan.APR ?? 0;
  const frequency = loan.PaymentFrequency || 'Monthly';
  const yearly = periodsPerYear(frequency);
  const payment = loanPaymentAmount(loan);
  const baseStart = parseISO(nextDueDate || loan.NextPaymentDate || addMonths(parseISO(loan.OriginationDate), 1));
  const start = advanceByPeriods(baseStart, frequency, scheduledDone);
  const term = loan.TermMonths || 0;
  const termPeriods = Math.max(1, Math.round((term * yearly) / 12));
  const remainingScheduled = Math.max(1, termPeriods - scheduledDone);
  const extrasMap = expandExtrasMap(extras, start);
  const extraEvents = [...extrasMap.entries()]
    .map(([date, amount]) => ({ date, amount }))
    .sort((left, right) => left.date.localeCompare(right.date));
  let extraIndex = 0;

  const timeline = [];
  let date = start;
  let previousDate = toISODate(addDays(start, -1));
  let totalPaid = 0;
  let totalInterest = 0;
  let totalPrincipal = 0;

  for (let guard = 0; guard < Math.max(remainingScheduled + 120, 2400); guard += 1) {
    const dueDate = toISODate(date);
    let extraAmount = 0;
    while (extraIndex < extraEvents.length && extraEvents[extraIndex].date <= dueDate) {
      if (extraEvents[extraIndex].date > previousDate) {
        extraAmount = round2(extraAmount + extraEvents[extraIndex].amount);
      }
      extraIndex += 1;
    }
    const interest = round2(balance * apr / yearly);
    const principal = Math.min(balance, Math.max(0, round2(payment - interest)));
    const extraPrincipal = Math.min(Math.max(0, balance - principal), extraAmount);
    const totalPrincipalThisPeriod = round2(principal + extraPrincipal);
    const totalPayment = round2(totalPrincipalThisPeriod + interest);

    totalPaid = round2(totalPaid + totalPayment);
    totalInterest = round2(totalInterest + interest);
    totalPrincipal = round2(totalPrincipal + totalPrincipalThisPeriod);
    balance = round2(Math.max(0, balance - totalPrincipalThisPeriod));

    timeline.push({
      date: dueDate,
      payment: totalPayment,
      interest,
      principal: totalPrincipalThisPeriod,
      balance,
      paid: totalPaid,
      interestPaid: totalInterest,
      principalPaid: totalPrincipal,
    });

    if (balance <= EPS) break;
    previousDate = dueDate;
    date = advanceByFrequency(date, frequency);
  }

  const payoffDate = timeline.length ? timeline[timeline.length - 1].date : null;
  return {
    timeline,
    payoffDate,
    totals: {
      totalPaid,
      totalInterest,
      totalPrincipal,
    },
    balanceEnd: balance,
    schedule: timeline,
  };
}
