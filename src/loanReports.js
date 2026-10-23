import { recalcLoanPayments, parseISO, toISODate, addMonths, addDays } from './legacyLoanEngine.js';

const amount = (value) => Number(value) || 0;
const cents = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
export const money = (value) => amount(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function reportPeriod(preset, today = localDate()) {
  if (preset === 'ytd') return { start: `${today.slice(0, 4)}-01-01`, end: today };
  if (preset === '12months') {
    const date = new Date(`${today}T12:00:00Z`);
    const year = date.getUTCFullYear() - 1;
    const month = date.getUTCMonth();
    const day = Math.min(date.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
    const start = new Date(Date.UTC(year, month, day + 1)).toISOString().slice(0, 10);
    return { start, end: today };
  }
  return { start: `${preset}-01-01`, end: `${preset}-12-31` };
}

// Replay servicing only to identify installment dates; keep recorded amounts intact.
export function appliedReportPayments(loans, payments, draws) {
  const applied = new Map();
  for (const loan of loans) {
    if (!(Number(loan.TermMonths) > 0) || !(loan.NextPaymentDate || loan.OriginationDate)) continue;
    const original = payments.filter((p) => p.LoanRef === loan.id);
    const replayed = recalcLoanPayments(loan, original.map((p, index) => ({ ...p, id: p.id ?? `report-${index}` })), draws);
    original.forEach((payment, index) => applied.set(payment, replayed[index]?.AppliedDueDate));
  }
  return payments.map((payment) => ({ ...payment, reportDate: payment.IsScheduledInstallment === false ? payment.PaymentDate : applied.get(payment) || payment.AppliedDueDate || payment.PaymentDate }));
}

// Balances on the report's applied-period basis, rather than bank posting dates.
export function buildPeriodReport(loans, payments, draws, start, end) {
  const within = (date) => date >= start && date <= end;
  const appliedPayments = appliedReportPayments(loans, payments, draws);
  return loans.map((loan) => {
    const paid = appliedPayments.filter((p) => p.LoanRef === loan.id);
    const borrowed = draws.filter((d) => d.LoanRef === loan.id);
    const sum = (list, field) => list.reduce((total, row) => total + amount(row[field]), 0);
    const periodPayments = paid.filter((p) => within(p.reportDate));
    const origin = loan.OriginationDate;
    const opening = (origin && origin < start ? amount(loan.OriginalPrincipal) : 0)
      + sum(borrowed.filter((d) => d.DrawDate < start), 'Amount')
      - sum(paid.filter((p) => p.reportDate < start), 'PrincipalPortion');
    const advances = (origin && within(origin) ? amount(loan.OriginalPrincipal) : 0)
      + sum(borrowed.filter((d) => within(d.DrawDate)), 'Amount');
    const principal = sum(periodPayments, 'PrincipalPortion');
    return {
      id: loan.id, name: loan.LoanID || loan.BorrowerName || `Loan ${loan.id}`,
      interest: cents(sum(periodPayments, 'InterestPortion')), principal: cents(principal),
      opening: cents(opening), advances: cents(advances), closing: cents(opening + advances - principal),
      change: cents(advances - principal), count: periodPayments.length,
      missingOrigin: !origin,
    };
  });
}


export function buildReportDetails(loans, payments, draws, start, end) {
  const ids = new Set(loans.map((loan) => loan.id));
  const names = new Map(loans.map((loan) => [loan.id, [loan.BorrowerName, loan.LoanID].filter(Boolean).join(' / ') || `Loan ${loan.id}`]));
  const within = (date) => date >= start && date <= end;
  const activity = [
    ...appliedReportPayments(loans, payments, draws).filter((p) => ids.has(p.LoanRef) && within(p.reportDate)).map((p) => ({
      date: p.PaymentDate, appliedDate: p.reportDate, loan: names.get(p.LoanRef), description: `Payment${p.Method ? ` (${p.Method})` : ''}${p.Reference ? ` - ${p.Reference}` : ''}`,
      principal: amount(p.PrincipalPortion), interest: amount(p.InterestPortion), borrowing: 0,
    })),
    ...draws.filter((d) => ids.has(d.LoanRef) && within(d.DrawDate)).map((d) => ({ date: d.DrawDate, loan: names.get(d.LoanRef), description: 'Draw / balance adjustment', principal: 0, interest: 0, borrowing: amount(d.Amount) })),
    ...loans.filter((loan) => within(loan.OriginationDate)).map((loan) => ({ date: loan.OriginationDate, loan: names.get(loan.id), description: 'Original disbursement', principal: 0, interest: 0, borrowing: amount(loan.OriginalPrincipal) })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.loan.localeCompare(b.loan));
  const months = [];
  for (let month = start.slice(0, 7); month <= end.slice(0, 7);) {
    const entries = activity.filter((entry) => (entry.appliedDate || entry.date).startsWith(month));
    const total = (key) => cents(entries.reduce((sum, entry) => sum + entry[key], 0));
    months.push({ month, interest: total('interest'), principal: total('principal'), borrowing: total('borrowing'), change: cents(total('borrowing') - total('principal')) });
    const [year, number] = month.split('-').map(Number);
    month = `${number === 12 ? year + 1 : year}-${String(number === 12 ? 1 : number + 1).padStart(2, '0')}`;
  }
  return { activity, months };
}


// Shared by preview and PDF: three complete month summaries per horizontal row.
export function monthlyReportRows(months) {
  return Array.from({ length: Math.ceil(months.length / 3) }, (_, index) =>
    Array.from({ length: 3 }, (_, column) => months[index * 3 + column] || null));
}
export function monthLabel(month) {
  return new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}


export function formatLoanDate(value) {
  if (!value) return '-';
  const iso = value instanceof Date ? toISODate(value) : String(value).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? `${match[2]}-${match[3]}-${match[1]}` : '-';
}

export const LOAN_INFO_HEADINGS = ['Borrower', 'Loan ID', 'Interest Rate', 'Origination Date', 'Maturity Date', 'Outstanding Principal'];
export function loanInfoCells(loan, reportRow) {
  const frequency = loan.PaymentFrequency || 'Monthly';
  const yearly = { Monthly: 12, Biweekly: 26, Weekly: 52, Quarterly: 4, Annual: 1 }[frequency] || 12;
  const periods = Math.round((Number(loan.TermMonths) || 0) * yearly / 12);
  let maturity = loan.NextPaymentDate ? parseISO(loan.NextPaymentDate) : addMonths(parseISO(loan.OriginationDate), 1);
  if (periods > 0 && Number.isFinite(maturity.getTime())) {
    for (let i = 1; i < periods; i++) maturity = frequency === 'Weekly' ? addDays(maturity, 7) : frequency === 'Biweekly' ? addDays(maturity, 14) : addMonths(maturity, frequency === 'Quarterly' ? 3 : frequency === 'Annual' ? 12 : 1);
  } else maturity = null;
  return [loan.BorrowerName || '-', loan.LoanID || `Loan ${loan.id}`, `${((Number(loan.APR) || 0) * 100).toFixed(3)}%`, formatLoanDate(loan.OriginationDate), formatLoanDate(maturity), money(reportRow?.closing)];
}
