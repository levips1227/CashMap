import { useEffect, useMemo, useState } from 'react';
import { formatCurrency } from './budgetEngine';
import {
  PAYOFF_METHODS,
  calculateDebtPayoff,
  createBlankDebtRow,
  formatDebtInput,
  formatPayoffLength,
  formatPayoffMonth,
  numericDebtValue,
} from './debtPayoffUtils';

export default function DebtPayoffCalculator({
  rows,
  setRows,
  loading,
  onReloadLoans,
  extras,
  setExtras,
  fixedTotalPayment,
  setFixedTotalPayment,
  method,
  setMethod,
}) {
  const [error, setError] = useState('');

  async function loadLoanRows() {
    setError('');
    try {
      await onReloadLoans({ includeNewLoans: true });
    } catch (err) {
      setError(err.message || 'Could not load loan data.');
    }
  }

  useEffect(() => {
    if (!rows.length) {
      loadLoanRows();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  const payoff = useMemo(
    () => calculateDebtPayoff(rows, method, extras, fixedTotalPayment),
    [rows, method, extras, fixedTotalPayment],
  );
  const baseline = useMemo(
    () => calculateDebtPayoff(rows, method, { monthly: 0, yearly: 0, oneTimeAmount: 0, oneTimeMonth: 1 }, fixedTotalPayment),
    [rows, method, fixedTotalPayment],
  );
  const interestSaved = Math.max(0, baseline.totalInterest - payoff.totalInterest);
  const monthlyMinimums = rows.reduce((sum, row) => sum + numericDebtValue(row.minimumPayment), 0);

  function updateExtra(field, value) {
    setExtras((current) => ({ ...current, [field]: value }));
  }

  function updateRow(rowId, patch) {
    setRows((current) => current.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
  }

  function removeRow(rowId) {
    setRows((current) => {
      const nextRows = current.filter((row) => row.id !== rowId);
      return nextRows.length ? nextRows : [createBlankDebtRow()];
    });
  }

  return (
    <div className="debt-payoff-workspace">
      <section className="panel">
        <div className="panel-head">
          <div>
            <div className="kicker">Debt Payoff Calculator</div>
            <h2>Plan a payoff strategy</h2>
          </div>
          <div className="form-actions">
            <button type="button" className="soft-button" onClick={loadLoanRows} disabled={loading}>
              Reload loans
            </button>
            <button type="button" className="primary-button" onClick={() => setRows((current) => [...current, createBlankDebtRow()])}>
              Add debt
            </button>
          </div>
        </div>

        <div className="filters-grid debt-payoff-controls">
          <Field label="Payoff method">
            <select value={method} onChange={(event) => setMethod(event.target.value)}>
              {PAYOFF_METHODS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Extra monthly payment">
            <input
              value={extras.monthly}
              onChange={(event) => updateExtra('monthly', event.target.value)}
              onBlur={() => updateExtra('monthly', formatDebtInput(extras.monthly))}
              placeholder="0.00"
            />
          </Field>
          <Field label="Extra yearly payment">
            <input
              value={extras.yearly}
              onChange={(event) => updateExtra('yearly', event.target.value)}
              onBlur={() => updateExtra('yearly', formatDebtInput(extras.yearly))}
              placeholder="0.00"
            />
          </Field>
          <Field label="One-time extra">
            <input
              value={extras.oneTimeAmount}
              onChange={(event) => updateExtra('oneTimeAmount', event.target.value)}
              onBlur={() => updateExtra('oneTimeAmount', formatDebtInput(extras.oneTimeAmount))}
              placeholder="0.00"
            />
          </Field>
          <Field label="One-time month #">
            <input
              type="number"
              min="1"
              value={extras.oneTimeMonth}
              onChange={(event) => updateExtra('oneTimeMonth', event.target.value)}
            />
          </Field>
          <Field label="Fixed total monthly payment">
            <div className="segmented-choice">
              <button
                type="button"
                className={`soft-button${fixedTotalPayment ? ' active' : ''}`}
                onClick={() => setFixedTotalPayment(true)}
              >
                Yes
              </button>
              <button
                type="button"
                className={`soft-button${!fixedTotalPayment ? ' active' : ''}`}
                onClick={() => setFixedTotalPayment(false)}
              >
                No
              </button>
            </div>
          </Field>
        </div>

        {error ? <div className="banner error">{error}</div> : null}

        <div className="metric-grid compact debt-payoff-summary">
          <div className="metric-card cool">
            <div className="metric-label">Debt Free Date</div>
            <div className="metric-value">{payoff.months ? formatPayoffMonth(payoff.months) : 'Not ready'}</div>
            <div className="metric-meta">{payoff.months ? formatPayoffLength(payoff.months) : 'Add balances and payments'}</div>
          </div>
          <div className="metric-card teal">
            <div className="metric-label">Total Paid</div>
            <div className="metric-value">{formatCurrency(payoff.totalPaid)}</div>
            <div className="metric-meta">Principal and interest</div>
          </div>
          <div className="metric-card teal">
            <div className="metric-label">Total Interest</div>
            <div className="metric-value">{formatCurrency(payoff.totalInterest)}</div>
            <div className="metric-meta">Projected from current rows</div>
          </div>
          <div className="metric-card cool">
            <div className="metric-label">Interest Saved</div>
            <div className="metric-value">{formatCurrency(interestSaved)}</div>
            <div className="metric-meta">Compared with no extra payments</div>
          </div>
          <div className="metric-card sand">
            <div className="metric-label">Monthly Payoff Budget</div>
            <div className="metric-value">
              {formatCurrency(monthlyMinimums + numericDebtValue(extras.monthly))}
            </div>
            <div className="metric-meta">Minimums plus extra payment</div>
          </div>
        </div>

        {payoff.months ? (
          <div className="inline-note debt-results-copy">
            You can pay off these debts by <strong>{formatPayoffMonth(payoff.months)}</strong> ({formatPayoffLength(payoff.months)}) with a starting monthly payment target of <strong>{formatCurrency(monthlyMinimums + numericDebtValue(extras.monthly))}</strong>.
            You will pay <strong>{formatCurrency(payoff.totalPaid)}</strong> total, including <strong>{formatCurrency(payoff.totalInterest)}</strong> in interest.
            Extra payments save about <strong>{formatCurrency(interestSaved)}</strong> in interest compared with the same plan without extras.
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-head compact">
          <div>
            <div className="kicker">Debt Inputs</div>
            <h2>Loans and other balances</h2>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table debt-payoff-table">
            <thead>
              <tr>
                <th>Creditor</th>
                <th>Balance</th>
                <th>APR %</th>
                <th>Monthly payment</th>
                <th>Source</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <input value={row.creditor} onChange={(event) => updateRow(row.id, { creditor: event.target.value })} />
                  </td>
                  <td>
                    <input
                      value={row.balance}
                      onChange={(event) => updateRow(row.id, { balance: event.target.value })}
                      onBlur={() => updateRow(row.id, { balance: formatDebtInput(row.balance) })}
                    />
                  </td>
                  <td>
                    <input value={row.apr} onChange={(event) => updateRow(row.id, { apr: event.target.value })} />
                  </td>
                  <td>
                    <input
                      value={row.minimumPayment}
                      onChange={(event) => updateRow(row.id, { minimumPayment: event.target.value })}
                      onBlur={() => updateRow(row.id, { minimumPayment: formatDebtInput(row.minimumPayment) })}
                    />
                  </td>
                  <td>{row.sourceLoanId ? <span className="pill primary">Loan Manager</span> : <span className="pill muted">Manual</span>}</td>
                  <td>
                    <button type="button" className="link-button danger" onClick={() => removeRow(row.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head compact">
          <div>
            <div className="kicker">Payoff Order</div>
            <h2>Projected payoff by debt</h2>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table debt-payoff-table">
            <thead>
              <tr>
                <th>Debt</th>
                <th>Starting balance</th>
                <th>Interest</th>
                <th>Total paid</th>
                <th>Payoff</th>
                <th>Payment schedule</th>
              </tr>
            </thead>
            <tbody>
              {payoff.debtSummaries.map((summary) => (
                <tr key={summary.id}>
                  <td>{summary.creditor}</td>
                  <td>{formatCurrency(summary.startingBalance)}</td>
                  <td>{formatCurrency(summary.interestPaid)}</td>
                  <td>{formatCurrency(summary.totalPaid)}</td>
                  <td>{summary.payoffMonth ? `${formatPayoffMonth(summary.payoffMonth)} (${summary.payoffMonth} mo)` : '-'}</td>
                  <td>
                    <div className="payment-schedule-list">
                      {summary.paymentSchedule.slice(0, 4).map((item) => (
                        <span key={item}>{item}</span>
                      ))}
                      {summary.paymentSchedule.length > 4 ? <span>Plus {summary.paymentSchedule.length - 4} more changes.</span> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!payoff.debtSummaries.length ? <div className="empty-state">Enter at least one debt to calculate a payoff plan.</div> : null}
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
