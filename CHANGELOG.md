# Changelog

## Loan date formatting and report identification

- Display loan dates as MM-DD-YYYY in Loan Manager, report previews, charts, and PDFs; retain ISO date storage and native date inputs.
- Rename dashboard reports to Monthly Statement, Interest Report, and Principal & Balance Report.
- Add Report Period and loans selected labels to the period reports, followed by one six-column loan information row per selected loan. Outstanding principal is the period-end applied balance; maturity follows the loan schedule.
- Preserve the working PDF downloader and three-month-wide monthly breakdown.

## Statement reference alignment and compact report layouts

- Tightened statement account-box line spacing, added separators above Regular Payment and Total Amount Due, bolded totals, removed internal vertical table borders, and added the reference-style outer frame.
- Preview and PDF monthly breakdowns now show three separate months across each row; 12 months occupy four rows. Each month retains interest and principal totals. This supersedes the one-month-per-row layout below.
- Removed applied-date text from recorded activity and reduced row padding/font size. Applied-installment calculations remain unchanged.
- Added shared month-row grouping and checks for full-year and partial rows; rendered and checked sample PDFs.

## PDF downloader restoration and monthly table correction

- Restored direct jsPDF/AutoTable generation, the previously working export path; removed html-to-image and the click-time module import.
- Recreated monthly statement sections with neutral colors and paired information boxes; kept the existing statement preview. PDFs have selectable text and automatic pagination.
- Changed monthly breakdowns to one month per row and three columns (month, interest paid, principal paid), matching the supplied example. Applied-installment calculations are preserved.
- Added direct PDF generation checks for both report types, statement sections, and long transaction tables.

The entries below describe earlier iterations; capture-based generation and month cards were superseded by this restoration.

## October 23, 2026 — Loan report corrections

- Replaced the failing html2canvas export path with browser-native SVG rendering through html-to-image. The PDF still uses the preview document, preserving its statement layout. Removed the manual CSS color and grid conversion layer.
- Export each PDF page separately to avoid browser limits on tall canvases. Preserve row/block boundaries where possible, keep direct downloads, clean up temporary export elements, and show the underlying error if export fails.
- Assign scheduled report payments to the installment due date produced by the existing loan servicing engine. Early, late, and split payments follow the same installment assignment used for servicing; grace days continue to control late-interest handling, not a newly invented reporting window.
- Apply the same payment-period basis to report filters, summary totals, monthly totals, and principal balances. A September 30 payment toward October 1 appears in October. Principal-only extras, draws, and originations retain actual dates. Unusable schedules fall back to recorded dates.
- Show both payment date and applied date in transaction activity. Keep original recorded payment amounts and avoid modifying stored data when reports replay installment assignments.
- Condense monthly breakdowns into three columns and explain the reporting basis in the preview/PDF.
- Add regression checks for split early installments, year boundaries, actual-date principal extras, summary reconciliation, and non-mutating reports.

### Earlier report dashboard changes

- Restored standalone PDF downloads in place of browser printing.
- Added interest and principal/balance reports with date presets, custom dates, and one/several/all loan selection using borrower and loan checkboxes.
- Added statement-style previews, loan summaries, monthly totals, transaction activity, and missing-origination warnings.
