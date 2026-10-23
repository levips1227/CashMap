import { formatCurrency, formatDateLabel } from '../budgetEngine';

export default function MobileTransactionLedger({ entries, sort, onSortChange, isSelectable, isSelected, onToggle, onEdit, onDelete, statusClassName, directionClassName }) {
  return <div className="mobile-ledger">
    <div className="mobile-ledger-sort">
      <label>Sort by<select value={sort.key} onChange={(event) => onSortChange({ ...sort, key: event.target.value })}>
        {Object.entries({ date: 'Date', title: 'Item', amount: 'Amount', account: 'Account', status: 'Status', after: 'Account balance', total: 'Total cash' }).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>Order<select value={sort.direction} onChange={(event) => onSortChange({ ...sort, direction: event.target.value })}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
    </div>
    <div className="mobile-transaction-list">
      {entries.map((entry) => <article className="mobile-transaction" key={entry.id}>
        <div className="mobile-transaction-heading">
          {isSelectable(entry) && <label className="mobile-transaction-select"><input type="checkbox" checked={isSelected(entry)} onChange={() => onToggle(entry)} aria-label={`Select ${entry.title} on ${formatDateLabel(entry.date)}`} /></label>}
          <div className="mobile-transaction-title"><time dateTime={entry.date}>{formatDateLabel(entry.date)}</time><h3>{entry.title}</h3></div>
          <div className="mobile-transaction-summary"><strong className="mobile-transaction-amount">{formatCurrency(entry.amount)}</strong><div className="mobile-transaction-badges"><span className={directionClassName(entry.direction)}>{entry.direction === 'opening' ? 'Start' : entry.direction}</span><span className={statusClassName(entry.status)}>{entry.status}</span></div></div>
        </div>
        <div className="mobile-transaction-meta"><div className="mobile-transaction-account"><span>{entry.account?.name || 'Unassigned'}{entry.toAccount ? ` to ${entry.toAccount.name}` : ''}</span><span className="mobile-transaction-category">Category: {entry.category || entry.sourceType}</span></div><div className="card-row-actions">{entry.sourceType === 'opening' ? <span className="table-secondary">Starting balance</span> : <><button type="button" className="soft-button" onClick={() => onEdit(entry)}>Edit</button>{entry.sourceType === 'manual' && <button type="button" className="soft-button danger-button" onClick={() => onDelete(entry.id)}>Delete</button>}</>}</div></div>
        <dl className="mobile-transaction-balances"><div><dt>Account balance</dt><dd>{entry.accountBalanceAfter != null ? formatCurrency(entry.accountBalanceAfter) : '-'}</dd></div><div><dt>Total cash</dt><dd>{formatCurrency(entry.totalBalanceAfter)}</dd></div></dl>
      </article>)}
    </div>
    {!entries.length && <div className="empty-state">No transactions match this date range and filter yet.</div>}
  </div>;
}
