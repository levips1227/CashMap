import { useState } from 'react';
import { buildPeriodReport, buildReportDetails, localDate, money, reportPeriod, formatLoanDate } from './loanReports';
import './loanReports.css';
import LoanPeriodReport from './LoanPeriodReport';
import { createLoanReportPdf } from './loanReportPdf';

const TYPES = [
  ['statement', 'Monthly Statement', 'Servicing details and payment activity'],
  ['interest', 'Interest Report', 'Recorded interest over your chosen period'],
  ['principal', 'Principal & Balance Report', 'Repayments, borrowing, and net change'],
];

export default function LoanReportsDashboard({ loans, payments, draws, selected, reportData, reportMonth, setReportMonth, children }) {
  const [type, setType] = useState('statement');
  const [loanIds, setLoanIds] = useState(null);
  const [preset, setPreset] = useState('ytd');
  const [custom, setCustom] = useState(() => reportPeriod('ytd'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const today = localDate();
  const dates = preset === 'custom' ? custom : reportPeriod(preset, today);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(dates.start) && /^\d{4}-\d{2}-\d{2}$/.test(dates.end) && dates.start <= dates.end;
  const filtered = loanIds === null ? loans : loans.filter((loan) => loanIds.includes(loan.id));
  const toggleLoan = (id) => setLoanIds((previous) => {
    const current = previous ?? loans.map((loan) => loan.id);
    return current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
  });
  const rows = valid ? buildPeriodReport(filtered, payments, draws, dates.start, dates.end) : [];
  const totals = rows.reduce((sum, row) => Object.fromEntries(Object.keys(sum).map((key) => [key, sum[key] + row[key]])), { interest: 0, principal: 0, opening: 0, advances: 0, closing: 0, change: 0, count: 0 });
  const activityDates = [...loans.map((l) => l.OriginationDate), ...payments.map((p) => p.PaymentDate), ...draws.map((d) => d.DrawDate)].filter(Boolean);
  const years = [...new Set([Number(today.slice(0, 4)), ...activityDates.map((d) => Number(d.slice(0, 4)))])].filter(Number.isFinite);
  const firstYear = Math.min(...years);
  const lastYear = Math.max(...years);
  const calendarYears = Array.from({ length: Math.min(200, lastYear - firstYear + 1) }, (_, i) => lastYear - i);
  const title = TYPES.find(([key]) => key === type)[1];
  const details = valid ? buildReportDetails(filtered, payments, draws, dates.start, dates.end) : { activity: [], months: [] };
  async function download() {
    setBusy(true); setError('');
    try {
      const doc = createLoanReportPdf({ type, title, loan: selected, statement: reportData, dates, loans: filtered, rows, totals, details });
      doc.save(`loan-${type}-${type === 'statement' ? `${selected?.LoanID || selected?.id}-${reportMonth}` : `${dates.start}-to-${dates.end}`}.pdf`);
    } catch (err) {
      console.error('Loan PDF export failed', err);
      setError(`PDF download failed: ${err.message || 'Unable to render report'}. Please try again.`);
    } finally { setBusy(false); }
  }
  return <section className="loan-reports">
    <header className="lr-heading"><div><div className="lr-eyebrow">LOAN MANAGER / REPORTS</div><h2>Reports dashboard</h2><p>Explore your loan activity and download a standalone PDF.</p></div><button type="button" onClick={download} disabled={busy || (type === 'statement' ? !reportData : !valid || !rows.length)}>{busy ? 'Creating PDF…' : 'Download PDF'}</button></header>
    <div className="lr-types">{TYPES.map(([key, label, detail]) => <button type="button" key={key} aria-pressed={type === key} className={type === key ? 'active' : ''} onClick={() => { setType(key); setError(''); }}><strong>{label}</strong><span>{detail}</span></button>)}</div>
    <div className="lr-filters">{type === 'statement' ? <><label>Statement month<input type="month" value={reportMonth} onChange={(e) => setReportMonth(e.target.value)} /></label><p>Statement for {selected?.LoanID || selected?.BorrowerName}. Select a loan in the loan list to change it.</p></> : <>

      <label>Period<select value={preset} onChange={(e) => setPreset(e.target.value)}><option value="ytd">Year to date</option><option value="12months">Last 12 months</option>{calendarYears.map((year) => <option key={year} value={year}>Calendar year {year}</option>)}<option value="custom">Custom dates</option></select></label>
      {preset === 'custom' ? <><label>From<input type="date" value={custom.start} onChange={(e) => setCustom({ ...custom, start: e.target.value })} /></label><label>Through<input type="date" value={custom.end} onChange={(e) => setCustom({ ...custom, end: e.target.value })} /></label></> : <p>{formatLoanDate(dates.start)} through {formatLoanDate(dates.end)} · Inclusive dates</p>}
    </>}</div>
    {type !== 'statement' && <fieldset className="lr-loan-picker"><legend>Loans to include ({filtered.length} of {loans.length})</legend><div className="lr-selection-actions"><button type="button" onClick={() => setLoanIds(null)}>Select all</button><button type="button" onClick={() => setLoanIds([])}>Clear selection</button></div><div className="lr-loan-options">{loans.map((loan) => <label key={loan.id}><input type="checkbox" checked={loanIds === null || loanIds.includes(loan.id)} onChange={() => toggleLoan(loan.id)} /><span><strong>{loan.BorrowerName || 'Borrower not entered'}</strong><small>{[loan.LoanID || `Loan ${loan.id}`, loan.ServicerName, loan.PropertyAddress].filter(Boolean).join(' / ')}</small></span></label>)}</div></fieldset>}
    {type !== 'statement' && !filtered.length && <p role="status" className="lr-error">Select at least one loan to preview and download a report.</p>}
    {error && <p role="alert" className="lr-error">{error}</p>}
    {type === 'statement' && !reportData && <p role="alert" className="lr-error">Select a valid statement month to preview and download this report.</p>}
    {type !== 'statement' && !valid ? <p role="alert" className="lr-error">Choose a valid start and end date, with the start on or before the end.</p> : null}
    {type !== 'statement' && valid && <div className="lr-stats">{(type === 'interest' ? [['Interest paid', money(totals.interest)], ['Recorded payments', totals.count], ['Loans included', rows.length]] : [['Principal paid', money(totals.principal)], ['New borrowing', money(totals.advances)], ['Net balance change', money(totals.change)]]).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>}
    <div className="lr-preview"><div className="lr-preview-label">REPORT PREVIEW <span>{title}</span></div><div className="lr-document-scroll"><div className="lr-report-document">{type === 'statement' ? children : valid && filtered.length ? <LoanPeriodReport type={type} title={title} dates={dates} loans={filtered} rows={rows} totals={totals} details={details} /> : null}</div></div></div>
  </section>;
}
