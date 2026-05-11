import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  formatCurrency,
  formatCurrencyCompact,
  formatDateLabel,
  getTodayKey,
} from './budgetEngine';
import {
  buildLoanInsights,
  createLoanScenarioExtra,
} from './loanPlanner';

function MetricCard({ label, value, meta, tone = 'cool' }) {
  return (
    <article className={`metric-card ${tone}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {meta ? <div className="metric-meta">{meta}</div> : null}
    </article>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

function getDefaultPaymentDraft(insights) {
  return {
    paymentDate: insights?.summary.nextPaymentDate || getTodayKey(),
    amount: insights?.summary.scheduledPayment ? String(insights.summary.scheduledPayment) : '',
    extraPrincipal: '',
    isScheduledInstallment: true,
    method: 'ACH',
    reference: '',
  };
}

function getDefaultDrawDraft() {
  return {
    drawDate: getTodayKey(),
    amount: '',
    notes: '',
  };
}

function LoanModeButton({ active, children, onClick }) {
  return (
    <button
      type="button"
      className={`soft-button${active ? ' active' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function currencyTooltip(value, name) {
  return [formatCurrency(value), name];
}

export default function LoanWorkspace({
  account,
  loanPayments = [],
  loanDraws = [],
  busy,
  onSavePayment,
  onUpdatePayment,
  onDeletePayment,
  onSaveDraw,
  onDeleteDraw,
  onError,
}) {
  const [mode, setMode] = useState('details');
  const [reportMonth, setReportMonth] = useState(getTodayKey().slice(0, 7));
  const [scenarioDrafts, setScenarioDrafts] = useState([
    createLoanScenarioExtra('recurring'),
  ]);
  const [appliedExtras, setAppliedExtras] = useState([]);
  const [scenarioRollupMode, setScenarioRollupMode] = useState('monthly');
  const [paymentDraft, setPaymentDraft] = useState(getDefaultPaymentDraft());
  const [editingPaymentId, setEditingPaymentId] = useState(null);
  const [drawDraft, setDrawDraft] = useState(getDefaultDrawDraft());

  const insights = useMemo(() => buildLoanInsights(
    account,
    { extras: appliedExtras },
    reportMonth,
    loanPayments,
    loanDraws,
  ), [account, appliedExtras, reportMonth, loanPayments, loanDraws]);

  useEffect(() => {
    setMode('details');
    setReportMonth(getTodayKey().slice(0, 7));
    setScenarioDrafts([createLoanScenarioExtra('recurring')]);
    setAppliedExtras([]);
    setEditingPaymentId(null);
    setDrawDraft(getDefaultDrawDraft());
  }, [account?.id]);

  useEffect(() => {
    if (!editingPaymentId) {
      setPaymentDraft(getDefaultPaymentDraft(insights));
    }
  }, [editingPaymentId, insights]);

  if (!account || !insights) {
    return (
      <div className="empty-state">
        Enter loan details to see payoff progress, payment history, calculator scenarios, and reports.
      </div>
    );
  }

  const paymentHistory = [...insights.history.payments].sort((left, right) => (
    right.paymentDate.localeCompare(left.paymentDate) || right.id - left.id
  ));
  const drawHistory = [...insights.history.draws].sort((left, right) => (
    right.drawDate.localeCompare(left.drawDate) || right.id - left.id
  ));
  const rollupRows = scenarioRollupMode === 'yearly' ? insights.yearlyRollup : insights.monthlyRollup;

  function updateScenarioExtra(id, patch) {
    setScenarioDrafts((current) => current.map((extra) => (
      extra.id === id ? { ...extra, ...patch } : extra
    )));
  }

  function addScenarioExtra(kind) {
    setScenarioDrafts((current) => [...current, createLoanScenarioExtra(kind)]);
  }

  function applyScenarioExtras() {
    setAppliedExtras(scenarioDrafts.filter((extra) => Number(extra.amount) > 0));
  }

  function clearScenarioExtras() {
    const reset = [createLoanScenarioExtra('recurring')];
    setScenarioDrafts(reset);
    setAppliedExtras([]);
  }

  async function submitPayment(event) {
    event.preventDefault();
    const baseAmount = Number(paymentDraft.amount || 0);
    const extraPrincipal = Number(paymentDraft.extraPrincipal || 0);
    const totalAmount = baseAmount + extraPrincipal;
    if (!paymentDraft.paymentDate || totalAmount <= 0) {
      onError(new Error('Enter a payment date and amount.'));
      return;
    }
    const payload = {
      accountId: account.id,
      paymentDate: paymentDraft.paymentDate,
      amount: totalAmount,
      isScheduledInstallment: paymentDraft.isScheduledInstallment,
      method: paymentDraft.method,
      reference: paymentDraft.reference,
      postedBy: 'You',
    };
    let saved = false;
    if (editingPaymentId) {
      saved = await onUpdatePayment(editingPaymentId, payload);
      if (!saved) return;
      setEditingPaymentId(null);
    } else {
      saved = await onSavePayment(payload);
      if (!saved) return;
    }
    setPaymentDraft(getDefaultPaymentDraft(insights));
  }

  async function submitDraw(event) {
    event.preventDefault();
    const amount = Number(drawDraft.amount || 0);
    if (!drawDraft.drawDate || amount <= 0) {
      onError(new Error('Enter a draw date and amount.'));
      return;
    }
    const saved = await onSaveDraw({
      accountId: account.id,
      drawDate: drawDraft.drawDate,
      amount,
      notes: drawDraft.notes,
    });
    if (!saved) return;
    setDrawDraft(getDefaultDrawDraft());
  }

  function editPayment(payment) {
    setEditingPaymentId(payment.id);
    setPaymentDraft({
      paymentDate: payment.paymentDate,
      amount: String(payment.amount),
      extraPrincipal: '',
      isScheduledInstallment: payment.isScheduledInstallment,
      method: payment.method,
      reference: payment.reference,
    });
  }

  return (
    <div className="loan-workspace">
      <div className="metric-grid compact">
        <MetricCard
          label="Current balance"
          value={formatCurrency(insights.summary.currentBalance)}
          meta={`As of ${formatDateLabel(insights.summary.balanceAsOfDate)}`}
          tone="sand"
        />
        <MetricCard
          label="Scheduled payment"
          value={formatCurrency(insights.summary.scheduledPayment)}
          meta={`Next due ${formatDateLabel(insights.summary.nextPaymentDate)}`}
          tone="cool"
        />
        <MetricCard
          label="Projected payoff"
          value={insights.summary.payoffDate ? formatDateLabel(insights.summary.payoffDate) : 'N/A'}
          meta={`${formatCurrency(insights.summary.totalInterestRemaining)} interest remaining`}
          tone="teal"
        />
        <MetricCard
          label="Principal progress"
          value={`${insights.summary.progressPercent}%`}
          meta={`${formatCurrency(insights.summary.principalPaid)} paid down`}
          tone="cool"
        />
      </div>

      <div className="progress-shell">
        <div className="progress-bar">
          <span style={{ width: `${insights.summary.progressPercent}%` }} />
        </div>
        <div className="progress-meta">
          <span>{formatCurrency(insights.summary.principalPaid)} of {formatCurrency(insights.summary.originalPrincipal)} retired</span>
          <span>{insights.summary.paymentsPosted} payments posted</span>
        </div>
      </div>

      <div className="entry-mode-toggle loan-mode-toggle">
        <LoanModeButton active={mode === 'details'} onClick={() => setMode('details')}>Loan details</LoanModeButton>
        <LoanModeButton active={mode === 'calculator'} onClick={() => setMode('calculator')}>Calculator</LoanModeButton>
        <LoanModeButton active={mode === 'reports'} onClick={() => setMode('reports')}>Reports</LoanModeButton>
      </div>

      {mode === 'details' ? (
        <div className="loan-grid">
          <div className="detail-panel">
            <div className="panel-mini-head">
              <strong>Loan terms</strong>
              <span>Servicer, schedule, and statement details.</span>
            </div>
            <div className="mini-metric-grid">
              <div className="mini-metric">
                <span>Type</span>
                <strong>{insights.loan.LoanType}</strong>
              </div>
              <div className="mini-metric">
                <span>APR</span>
                <strong>{(insights.loan.APR * 100).toFixed(3)}%</strong>
              </div>
              <div className="mini-metric">
                <span>Frequency</span>
                <strong>{insights.loan.PaymentFrequency}</strong>
              </div>
              <div className="mini-metric">
                <span>Term</span>
                <strong>{insights.loan.TermMonths} months</strong>
              </div>
              <div className="mini-metric">
                <span>Escrow</span>
                <strong>{formatCurrency(insights.loan.EscrowMonthly)} / mo</strong>
              </div>
              <div className="mini-metric">
                <span>Grace days</span>
                <strong>{insights.loan.GraceDays}</strong>
              </div>
            </div>
            <div className="statement-detail-box">
              <div>
                <span>Borrower</span>
                <strong>{insights.loan.BorrowerName || account.name}</strong>
              </div>
              <div>
                <span>Servicer</span>
                <strong>{insights.loan.ServicerName || account.institution || 'Not set'}</strong>
              </div>
              <div>
                <span>Account number</span>
                <strong>{insights.loan.AccountNumber || 'Not set'}</strong>
              </div>
            </div>
          </div>

          <div className="detail-panel">
            <div className="panel-mini-head">
              <strong>{editingPaymentId ? 'Edit payment' : 'Post payment'}</strong>
              <span>Scheduled payments split into interest, escrow, and principal automatically.</span>
            </div>
            <form className="form-grid compact" onSubmit={submitPayment}>
              <Field label="Payment date">
                <input
                  type="date"
                  value={paymentDraft.paymentDate}
                  onChange={(event) => setPaymentDraft((current) => ({ ...current, paymentDate: event.target.value }))}
                />
              </Field>
              <Field label="Payment amount">
                <input
                  type="number"
                  step="0.01"
                  value={paymentDraft.amount}
                  onChange={(event) => setPaymentDraft((current) => ({ ...current, amount: event.target.value }))}
                />
              </Field>
              <Field label="Extra principal">
                <input
                  type="number"
                  step="0.01"
                  value={paymentDraft.extraPrincipal}
                  onChange={(event) => setPaymentDraft((current) => ({ ...current, extraPrincipal: event.target.value }))}
                />
              </Field>
              <Field label="Method">
                <select
                  value={paymentDraft.method}
                  onChange={(event) => setPaymentDraft((current) => ({ ...current, method: event.target.value }))}
                >
                  <option value="ACH">ACH</option>
                  <option value="Check">Check</option>
                  <option value="Cash">Cash</option>
                  <option value="Card">Card</option>
                  <option value="Transfer">Transfer</option>
                </select>
              </Field>
              <Field label="Reference">
                <input
                  value={paymentDraft.reference}
                  onChange={(event) => setPaymentDraft((current) => ({ ...current, reference: event.target.value }))}
                />
              </Field>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={paymentDraft.isScheduledInstallment}
                  onChange={(event) => setPaymentDraft((current) => ({ ...current, isScheduledInstallment: event.target.checked }))}
                />
                <span>Apply as scheduled payment. Uncheck for principal-only.</span>
              </label>
              <div className="form-actions">
                <button type="submit" className="primary-button" disabled={busy}>
                  {editingPaymentId ? 'Update payment' : 'Post payment'}
                </button>
                {editingPaymentId ? (
                  <button
                    type="button"
                    className="soft-button"
                    onClick={() => {
                      setEditingPaymentId(null);
                      setPaymentDraft(getDefaultPaymentDraft(insights));
                    }}
                  >
                    Cancel edit
                  </button>
                ) : null}
              </div>
            </form>
          </div>

          <div className="detail-panel loan-wide-panel">
            <div className="panel-mini-head">
              <strong>Payments</strong>
              <span>{paymentHistory.length} records</span>
            </div>
            <div className="table-wrap compact">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Principal</th>
                    <th>Interest</th>
                    <th>Escrow</th>
                    <th>Balance</th>
                    <th>Method</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentHistory.map((payment) => (
                    <tr key={payment.id}>
                      <td>{formatDateLabel(payment.paymentDate)}</td>
                      <td>{formatCurrency(payment.amount)}</td>
                      <td>{formatCurrency(payment.principal)}</td>
                      <td>{formatCurrency(payment.interest)}</td>
                      <td>{formatCurrency(payment.escrow)}</td>
                      <td>{formatCurrency(payment.balance)}</td>
                      <td>{payment.method}</td>
                      <td>
                        <div className="card-row-actions">
                          <button type="button" className="link-button" onClick={() => editPayment(payment)}>
                            Edit
                          </button>
                          <button type="button" className="link-button danger" onClick={() => onDeletePayment(payment.id)}>
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!paymentHistory.length ? (
                <div className="empty-state">No loan payments posted yet.</div>
              ) : null}
            </div>
          </div>

          {insights.loan.LoanType === 'Revolving LOC' ? (
            <div className="detail-panel loan-wide-panel">
              <div className="panel-mini-head">
                <strong>Draws</strong>
                <span>Track advances that increase the loan balance.</span>
              </div>
              <form className="form-grid compact" onSubmit={submitDraw}>
                <Field label="Draw date">
                  <input
                    type="date"
                    value={drawDraft.drawDate}
                    onChange={(event) => setDrawDraft((current) => ({ ...current, drawDate: event.target.value }))}
                  />
                </Field>
                <Field label="Amount">
                  <input
                    type="number"
                    step="0.01"
                    value={drawDraft.amount}
                    onChange={(event) => setDrawDraft((current) => ({ ...current, amount: event.target.value }))}
                  />
                </Field>
                <Field label="Notes">
                  <input
                    value={drawDraft.notes}
                    onChange={(event) => setDrawDraft((current) => ({ ...current, notes: event.target.value }))}
                  />
                </Field>
                <div className="form-actions">
                  <button type="submit" className="primary-button" disabled={busy}>
                    Add draw
                  </button>
                </div>
              </form>
              <div className="draw-list">
                {drawHistory.map((draw) => (
                  <div key={draw.id} className="draw-row">
                    <span>{formatDateLabel(draw.drawDate)}</span>
                    <strong>{formatCurrency(draw.amount)}</strong>
                    <button type="button" className="link-button danger" onClick={() => onDeleteDraw(draw.id)}>
                      Delete
                    </button>
                  </div>
                ))}
                {!drawHistory.length ? <div className="empty-state">No draws recorded.</div> : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {mode === 'calculator' ? (
        <div className="loan-grid">
          <div className="detail-panel loan-wide-panel">
            <div className="panel-mini-head">
              <strong>What-if calculator</strong>
              <span>Add one-time or recurring extra principal payments, then apply the scenario.</span>
            </div>
            <div className="table-wrap compact">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Amount</th>
                    <th>Date/start</th>
                    <th>Every</th>
                    <th>Row</th>
                  </tr>
                </thead>
                <tbody>
                  {scenarioDrafts.map((extra) => (
                    <tr key={extra.id}>
                      <td>
                        <select
                          value={extra.kind}
                          onChange={(event) => updateScenarioExtra(extra.id, { kind: event.target.value })}
                        >
                          <option value="recurring">Recurring</option>
                          <option value="once">One-time</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.01"
                          value={extra.amount}
                          onChange={(event) => updateScenarioExtra(extra.id, { amount: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="date"
                          value={extra.kind === 'once' ? extra.date : extra.start}
                          onChange={(event) => updateScenarioExtra(extra.id, extra.kind === 'once'
                            ? { date: event.target.value }
                            : { start: event.target.value })}
                        />
                      </td>
                      <td>
                        <select
                          value={extra.every}
                          disabled={extra.kind === 'once'}
                          onChange={(event) => updateScenarioExtra(extra.id, { every: event.target.value })}
                        >
                          <option value="day">Day</option>
                          <option value="week">Week</option>
                          <option value="month">Month</option>
                          <option value="year">Year</option>
                        </select>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="link-button danger"
                          onClick={() => setScenarioDrafts((current) => current.filter((item) => item.id !== extra.id))}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="form-actions">
              <button type="button" className="soft-button" onClick={() => addScenarioExtra('recurring')}>
                Add recurring extra
              </button>
              <button type="button" className="soft-button" onClick={() => addScenarioExtra('once')}>
                Add one-time extra
              </button>
              <button type="button" className="primary-button" onClick={applyScenarioExtras}>
                Apply scenario
              </button>
              <button type="button" className="soft-button" onClick={clearScenarioExtras}>
                Reset scenario
              </button>
            </div>
          </div>

          <div className="detail-panel">
            <div className="panel-mini-head">
              <strong>Scenario result</strong>
              <span>Compared with scheduled payoff.</span>
            </div>
            <div className="mini-metric-grid">
              <div className="mini-metric">
                <span>Scheduled payoff</span>
                <strong>{insights.baseProjection.payoffDate ? formatDateLabel(insights.baseProjection.payoffDate) : 'N/A'}</strong>
              </div>
              <div className="mini-metric">
                <span>Scenario payoff</span>
                <strong>{insights.scenarioProjection.payoffDate ? formatDateLabel(insights.scenarioProjection.payoffDate) : 'N/A'}</strong>
              </div>
              <div className="mini-metric">
                <span>Interest saved</span>
                <strong>{formatCurrency(insights.scenario.interestSaved)}</strong>
              </div>
              <div className="mini-metric">
                <span>Time saved</span>
                <strong>{insights.scenario.timeSavedLabel}</strong>
              </div>
            </div>
          </div>

          <div className="detail-panel">
            <div className="panel-mini-head">
              <strong>Payment rollup</strong>
              <span>Principal and interest by {scenarioRollupMode} period.</span>
            </div>
            <div className="form-actions">
              <LoanModeButton active={scenarioRollupMode === 'monthly'} onClick={() => setScenarioRollupMode('monthly')}>Monthly</LoanModeButton>
              <LoanModeButton active={scenarioRollupMode === 'yearly'} onClick={() => setScenarioRollupMode('yearly')}>Yearly</LoanModeButton>
            </div>
            <div className="chart-shell compact-chart">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={rollupRows.slice(0, 36)}>
                  <CartesianGrid strokeDasharray="4 4" stroke="rgba(148, 163, 184, 0.18)" />
                  <XAxis dataKey="period" minTickGap={20} stroke="#6b7280" />
                  <YAxis tickFormatter={formatCurrencyCompact} stroke="#6b7280" width={76} />
                  <Tooltip formatter={currencyTooltip} />
                  <Legend />
                  <Bar dataKey="principal" stackId="payments" fill="#0f766e" name="Principal" />
                  <Bar dataKey="interest" stackId="payments" fill="#b45309" name="Interest" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="detail-panel loan-wide-panel">
            <div className="panel-mini-head">
              <strong>Balance projection</strong>
              <span>Scheduled balance versus the applied scenario.</span>
            </div>
            <div className="chart-shell">
              <ResponsiveContainer width="100%" height={330}>
                <LineChart data={insights.chartRows}>
                  <CartesianGrid strokeDasharray="4 4" stroke="rgba(148, 163, 184, 0.18)" />
                  <XAxis dataKey="label" minTickGap={28} stroke="#6b7280" />
                  <YAxis tickFormatter={formatCurrencyCompact} stroke="#6b7280" width={86} />
                  <Tooltip formatter={currencyTooltip} labelFormatter={(label) => label} />
                  <Legend />
                  <Line type="monotone" dataKey="scheduledBalance" stroke="#155eef" strokeWidth={3} dot={false} name="Scheduled" />
                  <Line type="monotone" dataKey="scenarioBalance" stroke="#0f766e" strokeWidth={3} dot={false} name="Scenario" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      ) : null}

      {mode === 'reports' ? (
        <div className="loan-grid">
          <div className="detail-panel loan-wide-panel">
            <div className="panel-mini-head">
              <strong>Reports</strong>
              <span>Select a month to preview a mortgage-style statement.</span>
            </div>
            <div className="form-actions">
              <input
                type="month"
                value={reportMonth}
                onChange={(event) => setReportMonth(event.target.value)}
              />
              <button type="button" className="primary-button" onClick={() => window.print()}>
                Print statement
              </button>
            </div>
          </div>

          {insights.report ? (
            <div className="statement-preview loan-wide-panel">
              <div className="statement-header">
                <div>
                  <div className="kicker">{insights.report.servicerName || account.name}</div>
                  <h3>Mortgage Statement</h3>
                  <p>{insights.report.servicerAddress || account.institution || ''}</p>
                  {insights.report.servicerPhone ? <p>{insights.report.servicerPhone}</p> : null}
                  {insights.report.servicerWebsite ? <p>{insights.report.servicerWebsite}</p> : null}
                </div>
                <div className="statement-amount-due">
                  <span>Amount due</span>
                  <strong>{formatCurrency(insights.report.totalDue)}</strong>
                  <small>Due {formatDateLabel(insights.report.dueDate)}</small>
                </div>
              </div>

              <div className="statement-grid">
                <div className="statement-box">
                  <span>Borrower</span>
                  <strong>{insights.report.borrowerName}</strong>
                  <p>{insights.report.borrowerAddress || '-'}</p>
                </div>
                <div className="statement-box">
                  <span>Property address</span>
                  <p>{insights.report.propertyAddress || '-'}</p>
                </div>
                <div className="statement-box">
                  <span>Account information</span>
                  <p>Loan ID: {insights.loan.LoanID}</p>
                  <p>Account: {insights.report.accountNumber || '-'}</p>
                  <p>Status: {insights.report.statusLabel}</p>
                  <p>Maturity: {insights.report.maturityDate ? formatDateLabel(insights.report.maturityDate) : '-'}</p>
                  <p>Payoff: {insights.report.payoffDate ? formatDateLabel(insights.report.payoffDate) : '-'}</p>
                </div>
                <div className="statement-box">
                  <span>Current payment due</span>
                  <p>Principal: {formatCurrency(insights.report.scheduledBreakdown.principal)}</p>
                  <p>Interest: {formatCurrency(insights.report.scheduledBreakdown.interest)}</p>
                  <p>Escrow: {formatCurrency(insights.report.scheduledBreakdown.escrow)}</p>
                  <p>Past due: {formatCurrency(insights.report.overdueAmount)}</p>
                </div>
              </div>

              <div className="table-wrap compact">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Description</th>
                      <th>Charges</th>
                      <th>Payments</th>
                    </tr>
                  </thead>
                  <tbody>
                    {insights.report.transactions.map((transaction) => (
                      <tr key={transaction.key}>
                        <td>{formatDateLabel(transaction.date)}</td>
                        <td>{transaction.description}</td>
                        <td>{transaction.charge ? formatCurrency(transaction.charge) : '-'}</td>
                        <td>{transaction.payment ? formatCurrency(transaction.payment) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!insights.report.transactions.length ? (
                  <div className="empty-state">No activity in this statement period.</div>
                ) : null}
              </div>

              <div className="statement-grid">
                <div className="statement-box">
                  <span>Current month</span>
                  <p>Principal: {formatCurrency(insights.report.totalsInMonth.principal)}</p>
                  <p>Interest: {formatCurrency(insights.report.totalsInMonth.interest)}</p>
                  <p>Escrow: {formatCurrency(insights.report.totalsInMonth.escrow)}</p>
                  <p>Total: {formatCurrency(insights.report.totalsInMonth.total)}</p>
                </div>
                <div className="statement-box">
                  <span>Year to date</span>
                  <p>Principal: {formatCurrency(insights.report.totalsInYear.principal)}</p>
                  <p>Interest: {formatCurrency(insights.report.totalsInYear.interest)}</p>
                  <p>Escrow: {formatCurrency(insights.report.totalsInYear.escrow)}</p>
                  <p>Total: {formatCurrency(insights.report.totalsInYear.total)}</p>
                </div>
                <div className="statement-box">
                  <span>Loan to date</span>
                  <p>Principal: {formatCurrency(insights.report.totalsToEnd.principal)}</p>
                  <p>Interest: {formatCurrency(insights.report.totalsToEnd.interest)}</p>
                  <p>Escrow: {formatCurrency(insights.report.totalsToEnd.escrow)}</p>
                  <p>Total: {formatCurrency(insights.report.totalsToEnd.total)}</p>
                </div>
                <div className="statement-box">
                  <span>Important messages</span>
                  <p>{insights.report.statementMessage}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-state">Choose a valid report month.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
