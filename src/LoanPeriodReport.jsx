import { money, monthLabel, monthlyReportRows, formatLoanDate, LOAN_INFO_HEADINGS, loanInfoCells } from './loanReports';

function ReportTable({ title, headings, rows, footer, compact = false }) {
  return <section className={`lr-statement-section${compact ? ' lr-activity' : ''}`}>
    <div className="lr-section-title">{title}</div>
    <table><thead><tr>{headings.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.length ? rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>) : <tr><td colSpan={headings.length}>No recorded activity in this period.</td></tr>}</tbody>
      {footer && <tfoot><tr>{footer.map((cell, i) => <td key={i}>{cell}</td>)}</tr></tfoot>}
    </table>
  </section>;
}

export default function LoanPeriodReport({ type, title, dates, loans, rows, totals, details }) {
  const interest = type === 'interest';
  const loanName = (row) => {
    const loan = loans.find((loan) => loan.id === row.id);
    return <><strong>{loan?.BorrowerName || row.name}</strong><small>{[loan?.LoanID, loan?.ServicerName].filter(Boolean).join(' / ')}</small></>;
  };
  return <article className="lr-statement-document">
    <header className="lr-statement-header" data-pdf-keep>
      <div><div className="lr-section-label">CASHMAP / LOAN MANAGER</div><p>Recorded loan activity report</p><p>{loans.length} loans selected</p></div>
      <div className="lr-statement-heading"><h3>{title}</h3><p>Report Period: {formatLoanDate(dates.start)} - {formatLoanDate(dates.end)}</p><p>Both dates inclusive</p><div className="lr-amount"><span>{interest ? 'INTEREST PAID' : 'PRINCIPAL PAID'}</span><strong>{money(interest ? totals.interest : totals.principal)}</strong></div></div>
    </header>
    <ReportTable title="Selected Loans (balances at report period end)" headings={LOAN_INFO_HEADINGS} rows={loans.map((loan) => loanInfoCells(loan, rows.find((row) => row.id === loan.id)))} />
    <div className="lr-statement-pair" data-pdf-keep>
      <section><div className="lr-section-label">REPORT SCOPE</div>{loans.map((loan) => <p key={loan.id}><strong>{loan.BorrowerName || 'Borrower not entered'}</strong> / {loan.LoanID || `Loan ${loan.id}`}</p>)}</section>
      <section><div className="lr-section-label">PERIOD SUMMARY</div>{(interest ? [['Interest paid', money(totals.interest)], ['Principal paid', money(totals.principal)], ['Recorded payments', totals.count]] : [['Opening principal balance', money(totals.opening)], ['New borrowing', money(totals.advances)], ['Principal paid', money(totals.principal)], ['Closing principal balance', money(totals.closing)], ['Net balance change', money(totals.change)]]).map(([label, value]) => <div className="lr-statement-line" key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>
    </div>
    <ReportTable title="Loan breakdown" headings={interest ? ['Borrower / loan', 'Payments', 'Principal paid', 'Interest paid'] : ['Borrower / loan', 'Opening', 'Borrowing', 'Principal paid', 'Closing', 'Net change']}
      rows={rows.map((row) => interest ? [loanName(row), row.count, money(row.principal), money(row.interest)] : [loanName(row), money(row.opening), money(row.advances), money(row.principal), money(row.closing), money(row.change)])}
      footer={interest ? ['Total', totals.count, money(totals.principal), money(totals.interest)] : ['Total', money(totals.opening), money(totals.advances), money(totals.principal), money(totals.closing), money(totals.change)]} />
    <section className="lr-statement-section"><div className="lr-section-title">Monthly breakdown / applied payment periods</div><table className="lr-month-table"><tbody>{monthlyReportRows(details.months).map((group, index) => <tr key={index}>{group.map((month, column) => <td key={column}>{month && <><strong>{monthLabel(month.month)}</strong><div><span>Interest paid</span><span>{money(month.interest)}</span></div><div><span>Principal paid</span><span>{money(month.principal)}</span></div></>}</td>)}</tr>)}</tbody></table></section>
    <ReportTable compact title={interest ? 'Payment activity' : 'Principal and borrowing activity'} headings={interest ? ['Paid date', 'Borrower / loan', 'Description', 'Principal paid', 'Interest paid'] : ['Paid date', 'Borrower / loan', 'Description', 'Borrowing', 'Principal paid', 'Net change']}
      rows={details.activity.filter((entry) => !interest || entry.description.startsWith('Payment')).map((entry) => interest ? [formatLoanDate(entry.date), entry.loan, entry.description, money(entry.principal), money(entry.interest)] : [formatLoanDate(entry.date), entry.loan, entry.description, money(entry.borrowing), money(entry.principal), money(entry.borrowing - entry.principal)])} />
    <p className="lr-period-basis">Scheduled payments are grouped and filtered by the installment due date assigned by the loan servicing engine, even when paid early or late. Principal-only extras, draws, and originations use their actual dates. Balances are shown on this applied-period basis. Loans without a usable term/schedule use recorded dates.</p>
    <section className="lr-statement-notes" data-pdf-keep><div className="lr-section-label">REPORT NOTES</div><p>{interest ? 'Interest totals use recorded payment interest portions. Projected interest and escrow are excluded.' : 'Net change = original disbursements and draws minus principal paid. Negative change means debt decreased. Opening balance is immediately before the start date; closing balance includes the end date. Adjustments are included when recorded as draws or principal entries.'} No recorded payments means zero paid, not an estimate.</p>{!interest && rows.some((row) => row.missingOrigin) && <p><strong>Incomplete balance history:</strong> Some loans have no origination date. Add the date to include their original principal in historical balances.</p>}</section>
  </article>;
}
