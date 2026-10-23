# Changelog

## Shorter mobile card header

- Move the amount to the top right beside the date/title, with direction/status badges underneath; remove the separate amount row.
- Keep text sizes, selection, account/category, balances, and actions unchanged; long content can wrap within the card.

## Mobile control widths and denser transaction cards

- Constrain date/month controls and Safari date internals to field widths, reduce padding without shrinking text, and stack date filters below 360px.
- Remove excess mobile button stretching and minimum control widths; wrap account/actions and constrain planner, report, and summary layouts.
- Place flow/status badges left of the transaction amount; show account, category, both balances, and edit/delete actions directly without Details.
- Preserve desktop and PDF layouts and existing transaction handlers; update card rendering checks.

## Mobile Transactions and compact top navigation

- Added a mobile-only top navigation selector while retaining desktop tabs.
- Present filtered/sorted ledger entries as phone cards with expandable Details, shared selection, and existing edit/delete actions.
- Collapse the phone transaction editor until needed; open and scroll to it when editing.
- Stack batch-entry fields into labeled mobile rows without changing import/save logic.
- Constrain grid/panel widths and fit header, account, date, and status controls to vertical screens; use 16px mobile inputs to avoid iOS focus zoom.
- Preserve desktop ledger/editor presentation and approved report/PDF layouts. Add component rendering checks; live phone viewport verification remains outstanding.

## Consistent reports palette and button feedback

- Replaced report-dashboard purple colors with the shared blue-green gradient and matching selection accents.
- Added CSS-only glow, slight hover lift, and press feedback for enabled buttons across the app, plus visible keyboard focus.
- Respect reduced motion and hover-capable pointers; leave disabled controls stationary and retain warm glow colors for destructive buttons.
- Mobile layouts remain unchanged pending review with the user.

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

## Additional implementation history moved from README

These notes preserve the original implementation summaries. Earlier capture-based PDF approaches and intermediate mobile layouts were superseded by the later entries above; use the README and report reference for current instructions and behavior.

### Report changes — October 23, 2026

Fixed Loan Manager report generation calling `window.print()`. Added direct PDF downloads and a reports dashboard. Follow-up: PDF downloads now capture the preview document itself using browser-native SVG capture (html-to-image) and jsPDF, replacing the separate PDF template so the statement layout stays consistent. Added multi-loan checkboxes with borrower, loan, servicer, and property details; enriched period reports with statement-style sections, monthly totals, and transaction activity. Historical balances are reconstructed from recorded activity. PDF follow-up: replaced the failing CSS capture path, removed manual color/grid conversion, and render one page at a time to avoid oversized canvases. Export errors now include their underlying reason. Monthly breakdowns now follow servicing installment assignments and use a compact three-column layout. See [CHANGELOG.md](CHANGELOG.md) for details.

### PDF downloader restoration

Restored jsPDF/AutoTable after capture-based export failures and removed the click-time dynamic import. Monthly breakdowns now use the requested three-column row format, replacing month cards. See [CHANGELOG.md](CHANGELOG.md).

### Report layout refinements

Monthly statement PDFs use compact account lines, subtotal/total separators, bold payment totals, and horizontal table rules without internal vertical borders, following the supplied statement reference. Period-report previews and PDFs share a three-months-across breakdown; a full year uses four rows. Recorded activity omits the applied-date display and uses compact rows; installment assignment calculations are unchanged.

### Loan date and report identification updates

Displayed Loan Manager dates and PDF dates use MM-DD-YYYY. Stored values and native date controls retain ISO dates for calculation and browser compatibility; monthly summaries keep their month/year labels. Interest Report and Principal & Balance Report show an explicit Report Period, the number of loans selected, and one identification row per loan (borrower, loan ID, interest rate, origination, scheduled maturity, and period-end outstanding principal). Monthly Statement retains its statement header.

### Button appearance and interaction

Reports controls now share the application's blue-green gradient and accents. Enabled buttons use CSS-only blue/teal glow and a slight lift on mouse hover, with keyboard focus outlines. Destructive buttons retain warm-colored feedback. Disabled buttons do not animate; reduced-motion preferences suppress movement, and touch devices do not get persistent hover effects. No animation dependency is required. The first mobile pass focuses on Transactions and compact top navigation; other mobile screens can be refined separately.

### Mobile Transactions and navigation

At viewport widths of 820px or less, the app uses a compact top navigation selector and Transactions switches from the desktop ledger table to readable vertical cards. Each card shows date, title, amount, flow, account, and status; Category, both balances, and the existing edit/delete actions are visible directly on each card; flow/status badges sit to the left of the amount. Sort controls and bulk selection/status changes share the same state as the desktop ledger. Opening balances remain read-only and recurring occurrences retain their existing edit behavior.

The phone add-transaction form starts collapsed and opens when editing a transaction. Batch entry keeps the same fields and save/import behavior, displayed as labeled vertical rows. Header controls, date filters, and form fields fit the viewport, and mobile text fields use 16px text to avoid iOS focus zoom. These responsive styles do not replace the desktop table, navigation tabs, or editor layout. PDF reports retain their approved layout.

Verification: `node scripts/testMobileLedger.mjs`, `npm run lint`, and `npm run build`. Component rendering checks cover actions, selection, transfers, zero balances, and empty results; device/browser layout still needs live review on phones.

### Mobile width and card density refinements

Mobile controls use less surrounding padding without reducing text sizes. Date/month controls are constrained to their field width, including Safari date internals; on very narrow screens (360px or less) the two date filters stack. Action buttons size to their content instead of stretching across form rows, while retaining 44px touch heights. Mobile report filters, planner inputs, summary grids, and account/action headers also have constrained or wrapping layouts. Desktop styling and PDF layouts are unchanged. Transaction cards show flow/status beside the amount and display account, category, balances, and actions without expanding a Details section.

Mobile transaction cards place the amount in the upper-right corner beside the date/title, with direction and status immediately below it. This removes the separate amount row while preserving text sizes, visible balances, and actions.
