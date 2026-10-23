import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { money, monthLabel, monthlyReportRows, formatLoanDate, LOAN_INFO_HEADINGS, loanInfoCells } from './loanReports.js';

// Direct, data-driven PDF generation: no screenshot capture or click-time imports.
export function createLoanReportPdf(report) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const ink = [16, 34, 59];
  let y = 12;
  const text = (value, x = 14, size = 9, options = {}) => {
    doc.setFont('helvetica', options.bold ? 'bold' : 'normal');
    doc.setFontSize(size); doc.setTextColor(...ink);
    doc.text(String(value || '-'), x, y, options);
  };
  const table = (title, headings, body, foot) => {
    if (y > 250) { doc.addPage(); y = 12; }
    autoTable(doc, { startY: y, margin: { left: 14, right: 14, bottom: 16 },
      head: [[{ content: title.toUpperCase(), colSpan: headings.length }], ...(headings.some(Boolean) ? [headings] : [])],
      body, foot: foot ? [foot] : undefined, showFoot: 'lastPage', theme: 'plain',
      styles: { font: 'helvetica', fontSize: 8, textColor: ink, lineColor: [203, 213, 225], lineWidth: 0, cellPadding: 2, overflow: 'linebreak' },
      headStyles: { fillColor: [243, 244, 246], textColor: ink, fontStyle: 'normal' },
      footStyles: { fillColor: [255, 255, 255], textColor: ink, fontStyle: 'bold' },
      tableLineColor: [203, 213, 225], tableLineWidth: 0.15,
      rowPageBreak: 'avoid',
      didParseCell: (cell) => {
        if (cell.section === 'head') {
          if (cell.row.index === 0) cell.cell.styles.fontSize = 7;
          else cell.cell.styles.fillColor = [248, 250, 252];
          if (title === 'Important messages') cell.cell.styles.fillColor = [255, 255, 255];
        }
        if (cell.section === 'body') cell.cell.styles.lineWidth = { bottom: 0.1 };
        if (title === 'Past payments breakdown' && cell.section === 'body' && cell.row.index === body.length - 1) {
          cell.cell.styles.fontStyle = 'bold'; cell.cell.styles.lineWidth = { top: 0.2 };
        }
        if (title.startsWith('Monthly breakdown') && cell.section === 'body') {
          cell.cell.styles.halign = 'left'; cell.cell.styles.cellWidth = 182 / 3;
        }
        if (title === 'Recorded activity') {
          cell.cell.styles.fontSize = 7;
          cell.cell.styles.cellPadding = { top: 0.7, bottom: 0.7, left: 1.5, right: 1.5 };
        }
      },
    });
    y = doc.lastAutoTable.finalY + 4;
  };
  const pair = (leftTitle, leftRows, rightTitle, rightRows) => {
    const top = y;
    const box = (x, title, rows) => {
      autoTable(doc, { startY: top, margin: { left: x, right: 210 - x - 89 }, tableWidth: 89,
        head: [[{ content: title.toUpperCase(), colSpan: 2 }]], body: rows, theme: 'plain',
        styles: { fontSize: 8, textColor: ink, cellPadding: { top: 0.7, bottom: 0.7, left: 2, right: 2 }, overflow: 'linebreak' },
        headStyles: { fontSize: 7, fontStyle: 'normal', textColor: [82, 97, 119] },
        didParseCell: (cell) => {
          if (title === 'Current payment due' && cell.section === 'body' && [3, 5].includes(cell.row.index)) {
            cell.cell.styles.lineWidth = { top: 0.15 }; cell.cell.styles.lineColor = [203, 213, 225]; cell.cell.styles.fontStyle = 'bold';
          }
        },
        columnStyles: { 1: { halign: 'right' } }, tableLineColor: [203, 213, 225], tableLineWidth: 0,
      });
      return doc.lastAutoTable.finalY;
    };
    const leftEnd = box(14, leftTitle, leftRows);
    const rightEnd = box(107, rightTitle, rightRows);
    const bottom = Math.max(leftEnd, rightEnd);
    doc.setDrawColor(203, 213, 225); doc.setLineWidth(0.15);
    doc.rect(14, top, 89, bottom - top); doc.rect(107, top, 89, bottom - top);
    y = bottom + 4;
  };
  if (report.type === 'statement') {
    const s = report.statement, loan = report.loan;
    text(s.servicerName, 14, 9);
    text('Mortgage Statement', 196, 14, { align: 'right' }); y += 5;
    const address = doc.splitTextToSize([s.servicerAddress, s.servicerPhone && `Phone: ${s.servicerPhone}`, s.servicerWebsite && `Web: ${s.servicerWebsite}`].filter(Boolean).join('\n'), 86);
    doc.setFontSize(8); doc.text(address, 14, y);
    text(`Statement Date: ${formatLoanDate(s.statementDateLabel)}`, 196, 8, { align: 'right' }); y += 4;
    text(`Payment Due Date: ${formatLoanDate(s.dueDateLabel)}`, 196, 8, { align: 'right' }); y += 4;
    text(`Account Number: ${s.accountNumber || '-'}`, 196, 8, { align: 'right' }); y += 4;
    doc.setDrawColor(203, 213, 225); doc.setFillColor(248, 250, 252); doc.rect(153, y, 43, 14, 'FD');
    y += 4; text('AMOUNT DUE', 194, 7, { align: 'right' }); y += 7;
    text(money(s.totalDue), 194, 13, { align: 'right', bold: true }); y = Math.max(y + 8, 24 + address.length * 4);
    pair('Borrower', [[{ content: `${loan.BorrowerName || '-'}\n${s.borrowerAddress || '-'}`, colSpan: 2 }]], 'Property address', [[{ content: s.propertyAddress || '-', colSpan: 2 }]]);
    pair('Account information', [
      ['Loan ID', loan.LoanID || '-'], ['Status', s.statusLabel], ['Interest rate', `${((loan.APR || 0) * 100).toFixed(3)}%`], ['Origination date', formatLoanDate(loan.OriginationDate)], ['Maturity date', formatLoanDate(s.maturityDate)], ['Current payoff date', formatLoanDate(s.payoffDateLabel)], ['Outstanding principal', money(s.balanceEnd)],
    ], 'Current payment due', [
      ['Principal', money(s.scheduledBreakdown.principal)], ['Interest', money(s.scheduledBreakdown.interest)], ['Escrow', money(s.scheduledBreakdown.escrow)], ['Regular payment', money(s.scheduledBreakdown.total)], ['Past due', money(s.overdueAmount)], ['Total amount due', money(s.totalDue)],
    ]);
    const iso = formatLoanDate;
    table(`Transaction activity (${iso(s.periodStart)} - ${iso(s.periodEnd)})`, ['Date', 'Description', 'Charges', 'Payments'], s.transactions.length ? s.transactions.map((t) => [formatLoanDate(t.date), t.description, t.charge ? money(t.charge) : '-', t.payment ? money(t.payment) : '-']) : [['-', 'No activity in this period.', '-', '-']]);
    table('Past payments breakdown', ['Description', 'Last month', 'Year to date', 'Life to date'], ['principal', 'interest', 'escrow', 'total'].map((key) => [key[0].toUpperCase() + key.slice(1), money(s.totalsInMonth[key]), money(s.totalsInYear[key]), money(s.totalsToEnd[key])]));
    table('Important messages', [''], [[s.statementMessage || '-']]);
  } else {
    const { loans, rows, totals: t, details, dates } = report;
    const interest = report.type === 'interest';
    text('CASHMAP / LOAN MANAGER', 14, 8); text(report.title, 196, 14, { align: 'right' }); y += 6;
    text(`Report Period: ${formatLoanDate(dates.start)} - ${formatLoanDate(dates.end)}`, 196, 9, { align: 'right' }); y += 6;
    text(`${loans.length} loans selected`, 14, 9); y += 7;
    table('Selected Loans (balances at report period end)', LOAN_INFO_HEADINGS, loans.map((loan) => loanInfoCells(loan, rows.find((row) => row.id === loan.id))));
    table('Period summary', ['Interest paid', 'Principal paid', 'New borrowing', 'Net balance change'], [[money(t.interest), money(t.principal), money(t.advances), money(t.change)]]);
    const name = (row) => { const loan = loans.find((l) => l.id === row.id); return [loan?.BorrowerName, row.name, loan?.ServicerName].filter(Boolean).join(' / '); };
    table('Loan breakdown', interest ? ['Borrower / loan', 'Payments', 'Principal paid', 'Interest paid'] : ['Borrower / loan', 'Opening', 'Borrowing', 'Principal paid', 'Closing', 'Net change'], rows.map((r) => interest ? [name(r), r.count, money(r.principal), money(r.interest)] : [name(r), money(r.opening), money(r.advances), money(r.principal), money(r.closing), money(r.change)]));
    table('Monthly breakdown / applied payment periods', ['', '', ''], monthlyReportRows(details.months).map((group) => group.map((m) => m ? `${monthLabel(m.month)}\nInterest paid: ${money(m.interest)}\nPrincipal paid: ${money(m.principal)}` : '')));
    table('Recorded activity', ['Paid date', 'Borrower / loan', 'Description', 'Interest', 'Principal', 'Borrowing'], details.activity.filter((entry) => !interest || entry.description.startsWith('Payment')).map((e) => [formatLoanDate(e.date), e.loan, e.description, money(e.interest), money(e.principal), money(e.borrowing)]));
    table('Report notes', [''], [['Scheduled payments use the installment due date assigned by the servicing engine. Extras, draws, and originations use actual dates. Balances use this applied-period basis. No recorded payments means zero paid.'], ...(rows.some((r) => r.missingOrigin) ? [['Some origination dates are missing; historical original balances are incomplete.']] : [])]);
  }
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) { doc.setPage(page); if (report.type === 'statement') { doc.setDrawColor(203, 213, 225); doc.setLineWidth(0.15); doc.rect(10, 7, 190, page === pages ? Math.min(275, y) : 275); } doc.setFontSize(8); doc.setTextColor(100); doc.text(`${page} / ${pages}`, 196, 290, { align: 'right' }); }
  return doc;
}
