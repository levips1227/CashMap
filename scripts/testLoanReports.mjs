import assert from 'node:assert/strict';
import { buildPeriodReport, buildReportDetails, reportPeriod, monthlyReportRows, formatLoanDate, loanInfoCells } from '../src/loanReports.js';
import { createLoanReportPdf } from '../src/loanReportPdf.js';

assert.deepEqual(reportPeriod('ytd', '2026-10-23'), { start: '2026-01-01', end: '2026-10-23' });
assert.deepEqual(reportPeriod('12months', '2026-10-23'), { start: '2025-10-24', end: '2026-10-23' });
assert.deepEqual(reportPeriod('12months', '2024-02-29'), { start: '2023-03-01', end: '2024-02-29' });
assert.deepEqual(reportPeriod('2024'), { start: '2024-01-01', end: '2024-12-31' });
const loans = [{ id: 1, LoanID: 'Existing', OriginationDate: '2024-01-01', OriginalPrincipal: 1000 }, { id: 2, LoanID: 'New', OriginationDate: '2026-01-01', OriginalPrincipal: 500 }];
const payments = [
  { LoanRef: 1, PaymentDate: '2025-12-31', PrincipalPortion: 100, InterestPortion: 20 },
  { LoanRef: 1, PaymentDate: '2026-01-01', PrincipalPortion: 50, InterestPortion: 10 },
  { LoanRef: 1, PaymentDate: '2026-10-23', PrincipalPortion: 60, InterestPortion: 9.99 },
  { LoanRef: 1, PaymentDate: '2026-10-24', PrincipalPortion: 70, InterestPortion: 8 },
];
const rows = buildPeriodReport(loans, payments, [{ LoanRef: 1, DrawDate: '2026-03-01', Amount: 200 }], '2026-01-01', '2026-10-23');
assert.deepEqual(rows[0], { id: 1, name: 'Existing', interest: 19.99, principal: 110, opening: 900, advances: 200, closing: 990, change: 90, count: 2, missingOrigin: false });
assert.equal(rows[1].opening, 0);
assert.equal(rows[1].closing, 500);
assert.equal(rows.reduce((sum, row) => sum + row.change, 0), 590);
assert.equal(buildPeriodReport([loans[0]], payments, [], '2027-01-01', '2027-12-31')[0].principal, 0);
// A subset must exclude the unselected loan's payments, draws, and origination.
const details = buildReportDetails([loans[0]], payments, [{ LoanRef: 1, DrawDate: '2026-03-01', Amount: 200 }, { LoanRef: 2, DrawDate: '2026-03-01', Amount: 999 }], '2026-01-01', '2026-10-23');
assert.equal(details.activity.length, 3);
assert.equal(details.months.length, 10);
assert.equal(details.months.reduce((sum, month) => sum + month.principal, 0), rows[0].principal);
assert.equal(details.months.reduce((sum, month) => sum + month.borrowing, 0), rows[0].advances);
assert.ok(Math.abs(details.activity.reduce((sum, entry) => sum + entry.interest, 0) - rows[0].interest) < 0.005);
const combined = buildReportDetails(loans, payments, [], '2026-01-01', '2026-10-23');
assert.equal(combined.activity.filter((entry) => entry.description === 'Original disbursement').length, 1);
assert.equal(combined.months.reduce((sum, month) => sum + month.borrowing, 0), 500);
assert.equal(buildReportDetails([], payments, [], '2026-01-01', '2026-10-23').activity.length, 0);
// Replay the same servicing rules used by Loan Manager: early/split scheduled
// payments stay with their installment, while principal-only extras stay dated.
const servicingLoan = { id: 3, LoanID: 'PERIODS', OriginationDate: '2026-08-01', NextPaymentDate: '2026-09-01', OriginalPrincipal: 1000, TermMonths: 10, APR: 0, GraceDays: 15 };
const servicingPayments = [
  { id: 301, LoanRef: 3, PaymentDate: '2026-09-01', Amount: 100, PrincipalPortion: 100 },
  { id: 302, LoanRef: 3, PaymentDate: '2026-09-25', Amount: 40, PrincipalPortion: 40 },
  { id: 303, LoanRef: 3, PaymentDate: '2026-09-30', Amount: 60, PrincipalPortion: 60 },
  { id: 304, LoanRef: 3, PaymentDate: '2026-09-30', Amount: 10, PrincipalPortion: 10, IsScheduledInstallment: false },
];
const october = buildReportDetails([servicingLoan], servicingPayments, [], '2026-10-01', '2026-10-31');
assert.equal(october.activity.length, 2);
assert.equal(october.activity[1].date, '2026-09-30');
assert.equal(october.activity[1].appliedDate, '2026-10-01');
assert.equal(october.months[0].principal, 100);
const octoberSummary = buildPeriodReport([servicingLoan], servicingPayments, [], '2026-10-01', '2026-10-31')[0];
assert.equal(octoberSummary.principal, 100);
assert.equal(octoberSummary.opening, 890);
assert.equal(octoberSummary.closing, 790);
assert.equal(servicingPayments[1].AppliedDueDate, undefined, 'Reports must not mutate stored payments');
const januaryLoan = { ...servicingLoan, id: 4, OriginationDate: '2026-12-01', NextPaymentDate: '2027-01-01' };
const january = buildReportDetails([januaryLoan], [{ id: 401, LoanRef: 4, PaymentDate: '2026-12-31', Amount: 100, PrincipalPortion: 100 }], [], '2027-01-01', '2027-12-31');
assert.equal(january.months[0].principal, 100, 'Early January installment belongs to January report');
const late = buildReportDetails([servicingLoan], [{ id: 305, LoanRef: 3, PaymentDate: '2026-10-18', Amount: 100, PrincipalPortion: 100 }], [], '2026-09-01', '2026-09-30');
assert.equal(late.months[0].principal, 100, 'Late payment belongs to the unpaid installment');
assert.equal(late.activity[0].appliedDate, '2026-09-01');
const pdf = createLoanReportPdf({ type: 'interest', title: 'Interest Report', dates: { start: '2026-01-01', end: '2026-10-23' }, loans, rows, totals: rows[0], details });
assert.ok(pdf.output().startsWith('%PDF-'));
assert.ok(pdf.output().includes('MONTHLY BREAKDOWN'));
assert.ok(pdf.output().includes('Principal paid'));
const statementData = { servicerName: 'Sample Servicer', servicerAddress: '1585 Broadway\nNew York, NY 10036', statementDateLabel: '2026-09-16', dueDateLabel: '2026-10-01', accountNumber: '2840003127', totalDue: 2098.47, borrowerAddress: '284 Maple St\nApt 2\nHolyoke, MA 01040', propertyAddress: '284 Maple St\nHolyoke, MA 01040', statusLabel: 'Active', maturityDate: '2055-09-01', payoffDateLabel: '2055-09-01', balanceEnd: 328289.11, scheduledBreakdown: { principal: 320.24, interest: 1778.23, escrow: 0, total: 2098.47 }, overdueAmount: 0, periodStart: '2026-08-16', periodEnd: '2026-09-15', transactions: [{ date: '2026-09-01', description: 'Payment (ACH)', charge: 0, payment: 2098.47 }], totalsInMonth: { principal: 318.51, interest: 1779.96, escrow: 0, total: 2098.47 }, totalsInYear: { principal: 2805.59, interest: 16080.64, escrow: 0, total: 18886.23 }, totalsToEnd: { principal: 3710.89, interest: 21470.75, escrow: 0, total: 25181.64 }, statementMessage: 'If you have questions about this statement, please contact your loan servicer.' };
const statementPdf = createLoanReportPdf({ type: 'statement', loan: { BorrowerName: 'Sample Borrower', LoanID: 'LN-0100', APR: .065, OriginationDate: '2025-09-03' }, statement: statementData });
assert.ok(statementPdf.output().includes('Mortgage Statement'));
assert.equal(statementPdf.getNumberOfPages(), 1);
const longPdf = createLoanReportPdf({ type: 'statement', loan: loans[0], statement: { ...statementData, transactions: Array.from({length:100}, (_, i) => ({date:'2026-09-01', description:`Payment ${i}`, charge:0,payment:100})) } });
assert.ok(longPdf.getNumberOfPages() > 1);
assert.ok(!longPdf.output().includes('/JavaScript'));
if (process.argv.includes('--write-samples')) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync('tmp/pdfs', { recursive: true });
  statementPdf.save('tmp/pdfs/statement-qa.pdf');
  pdf.save('tmp/pdfs/period-qa.pdf');
}
console.log('Report checks passed: installment assignment, balances, direct PDF generation, statement layout and multi-page exports.');


const twelveMonths = Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}` }));
const monthGrid = monthlyReportRows(twelveMonths);
assert.equal(monthGrid.length, 4);
assert.ok(monthGrid.every((row) => row.length === 3));
assert.deepEqual(monthGrid.flat(), twelveMonths);
assert.equal(monthlyReportRows(twelveMonths.slice(0, 10))[3][1], null);

assert.equal(formatLoanDate('2026-01-09'), '01-09-2026');
assert.equal(formatLoanDate(new Date('2026-10-23T00:00:00Z')), '10-23-2026');
assert.equal(formatLoanDate(null), '-');
assert.ok(pdf.output().includes('Report Period: 01-01-2026 - 10-23-2026'));
assert.ok(!statementPdf.output().includes('2026-09-16'));
const info = loanInfoCells({ id: 8, LoanID: 'ID-8', BorrowerName: 'Borrower', APR: .065, OriginationDate: '2025-09-03', NextPaymentDate: '2025-10-01', PaymentFrequency: 'Monthly', TermMonths: 360 }, { closing: 1234.56 });
assert.deepEqual(info, ['Borrower', 'ID-8', '6.500%', '09-03-2025', '09-01-2055', '$1,234.56']);
