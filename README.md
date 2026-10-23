# CashMap

CashMap is a personal finance web application for cash-flow projections, transactions, recurring payments, budgets, account reconciliation, household sharing, and loan management.

## Loan Manager Reports

In **Loans → Loan Manager → Reports**, choose Monthly Statement, Interest Report, or Principal & Balance Report. The dashboard retains the statement preview and shows summary cards and a per-loan table for period reports. **Download PDF** saves a standalone report directly, without opening the browser print dialog or including the application navigation. PDF generation is imported with the reports dashboard to avoid click-time module loading failures.

- Monthly statements use the loan selected in the loan list and the chosen statement month.
- Interest and principal reports support one, several, or all loans via borrower/loan checkboxes, with year to date, last 12 months, calendar years, and custom dates. Both date boundaries are inclusive and apply to installment due dates for scheduled payments. Principal-only extras, draws, and originations use actual dates. Last 12 months ends today and starts the day after the same date last year (with leap-day handling).
- Interest paid and principal paid use recorded payment portions, excluding projections and escrow. The existing servicing engine identifies the installment each scheduled payment satisfies; this includes split, early, and late payments. For example, an October 1 installment paid September 30 is included in October. Report filtering, summaries, monthly breakdowns, and balances all use this applied-period basis. Activity lists both paid and applied dates. Principal-only extras keep their actual dates. Loans without a usable term/schedule fall back to recorded dates. Periods with no payments show zero.
- Net principal change equals new borrowing (original disbursements and draws) minus principal repaid. Negative change means debt decreased. Opening balance is immediately before the range and closing balance includes the final day, both on the applied-period basis (these can differ from posting-date balances). Adjustments are included when entered as draws or principal payment entries; there is no separate adjustment ledger. Missing origination dates are flagged because historical original balances cannot be assigned reliably.
- PDFs use the proven jsPDF/AutoTable direct-download generator, with selectable text, neutral statement-style tables, automatic pagination, and two-column statement information panels. No screenshot capture is used. The monthly statement preview retains its existing layout; the PDF recreates those sections in a print layout rather than capturing browser pixels. Period reports retain applied-payment dates and use three separate months per row, with each month showing its interest and principal totals (12 months occupy four rows). Principal/balance details remain in the loan summary and activity sections.


Local development: run `npm run dev:full`, then open `http://localhost:5173/` (API on port 4000). Focused report verification: `node scripts/testLoanReports.mjs`; production verification: `npm run build`.

### Report changes — October 23, 2026

Fixed Loan Manager report generation calling `window.print()`. Added direct PDF downloads and a reports dashboard. Follow-up: PDF downloads now capture the preview document itself using browser-native SVG capture (html-to-image) and jsPDF, replacing the separate PDF template so the statement layout stays consistent. Added multi-loan checkboxes with borrower, loan, servicer, and property details; enriched period reports with statement-style sections, monthly totals, and transaction activity. Historical balances are reconstructed from recorded activity. PDF follow-up: replaced the failing CSS capture path, removed manual color/grid conversion, and render one page at a time to avoid oversized canvases. Export errors now include their underlying reason. Monthly breakdowns now follow servicing installment assignments and use a compact three-column layout. See [CHANGELOG.md](CHANGELOG.md) for details.

## Runtime Requirements

- Node.js `20.19+` or `22.12+`
- npm
- A production HTTPS reverse proxy such as Nginx
- systemd on the current Oracle Linux server

The production application is served by Express on port `4000`. Express serves the compiled Vite files from `dist/`.

## Updating From The Repository

These commands assume the production checkout is `/home/ubuntu/CashMap` and the systemd service is named `cashmap`.

```bash
cd /home/ubuntu/CashMap
git status --short
git pull --ff-only
npm ci
npm run build
sudo systemctl restart cashmap
sudo systemctl status cashmap --no-pager
curl -fsS http://127.0.0.1:4000/api/health
```

The final command should return:

```json
{"ok":true}
```

Notes:

- `git status --short` should normally return nothing on production.
- `git pull --ff-only` prevents Git from creating an unintended merge commit on the server.
- `npm ci` installs exactly what is recorded in `package-lock.json`.
- `npm run build` creates the production frontend in `dist/`.
- Restart is required because the Express server does not reload production code automatically.
- `systemctl status` is a recommended verification step, not a requirement for the restart itself.
- A Vite chunk-size warning does not mean the build failed.

If `git pull` reports tracked local changes, do not overwrite them blindly. Inspect them first:

```bash
git status
git diff
```

Production source files should not be edited directly. Commit changes locally, push them to GitHub, and then pull them into production.

## Production Service Commands

```bash
# Start
sudo systemctl start cashmap

# Stop
sudo systemctl stop cashmap

# Restart after an update or environment change
sudo systemctl restart cashmap

# Check current status and recent startup output
sudo systemctl status cashmap --no-pager

# Show the latest 100 log lines
sudo journalctl -u cashmap -n 100 --no-pager

# Follow logs live; press Ctrl+C to exit
sudo journalctl -u cashmap -f

# Enable automatic startup after a server reboot
sudo systemctl enable cashmap
```

Run the following only after changing the systemd unit file:

```bash
sudo systemctl daemon-reload
sudo systemctl restart cashmap
```

## Production Environment

The application reads `/home/ubuntu/CashMap/.env`, but that file is excluded from Git and must be maintained separately on each server.

Recommended production values:

```env
PORT=4000
JWT_SECRET=replace-with-a-long-random-secret
ADMIN_USERNAME=Admin
ADMIN_PASSWORD=replace-with-a-secure-password
DB_PATH=/home/ubuntu/CashMap/data/budget-app.json
TRUST_PROXY=true
COOKIE_SECURE=true
GOOGLE_CLIENT_ID=
VITE_GOOGLE_CLIENT_ID=
RESET_ADMIN_ON_START=false
```

Important:

- Do not commit `.env`.
- Keep the same `JWT_SECRET` between deployments. Changing it signs out all users, although it does not delete application data.
- Generate a JWT secret with `openssl rand -hex 64`.
- Keep `RESET_ADMIN_ON_START=false` during normal operation.
- `ADMIN_PASSWORD` is used to create or intentionally reset an administrator; it is not a substitute for changing passwords through the app.
- Set `NODE_ENV=production` in the systemd service, not in `.env`. Vite warns when `NODE_ENV=production` is stored in `.env`.
- `COOKIE_SECURE=true` requires HTTPS.
- `TRUST_PROXY=true` is appropriate when Nginx or another trusted reverse proxy terminates HTTPS.
- `VITE_GOOGLE_CLIENT_ID` is compiled into the frontend. Rebuild and restart after changing it.

Secure the file:

```bash
chmod 600 /home/ubuntu/CashMap/.env
```

A typical systemd service includes:

```ini
[Unit]
Description=CashMap App
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/CashMap
Environment=NODE_ENV=production
EnvironmentFile=/home/ubuntu/CashMap/.env
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Confirm the correct npm path with `command -v npm` before changing `ExecStart`.

## Data And Backups

All users, households, transactions, budgets, reconciliations, and loan data are stored in:

```text
/home/ubuntu/CashMap/data/budget-app.json
```

The `data/` directory is excluded from Git, so `git pull` and `npm ci` do not transfer or replace production data.

Create a backup directory and make a timestamped backup:

```bash
mkdir -p /home/ubuntu/cashmap-backups
cp -p /home/ubuntu/CashMap/data/budget-app.json \
  "/home/ubuntu/cashmap-backups/budget-app-$(date +%Y%m%d-%H%M%S).json"
```

For a guaranteed point-in-time backup, briefly stop CashMap before copying:

```bash
sudo systemctl stop cashmap
cp -p /home/ubuntu/CashMap/data/budget-app.json \
  "/home/ubuntu/cashmap-backups/budget-app-$(date +%Y%m%d-%H%M%S).json"
sudo systemctl start cashmap
```

Restore a backup:

```bash
sudo systemctl stop cashmap
cp -p /home/ubuntu/cashmap-backups/BACKUP_FILE.json \
  /home/ubuntu/CashMap/data/budget-app.json
sudo systemctl start cashmap
curl -fsS http://127.0.0.1:4000/api/health
```

Store backups outside the Git repository and protect them because they contain private financial and account information.

## Resetting An Administrator

Stop the running service before using the reset script so the server's in-memory data cannot overwrite the reset:

```bash
cd /home/ubuntu/CashMap
sudo systemctl stop cashmap
ADMIN_USERNAME='Admin' ADMIN_PASSWORD='replace-with-a-secure-password' npm run reset:admin
sudo systemctl start cashmap
sudo systemctl status cashmap --no-pager
```

The password must contain at least eight characters.

## Local Development

Install dependencies and start both Vite and Express:

```powershell
cd "P:\Codex\Budget projection"
npm.cmd ci
npm.cmd run dev:full
```

Local addresses:

- Frontend: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:4000`

Use `Ctrl+C` to stop the foreground development servers.

PowerShell may block `npm.ps1` under its execution policy. Using `npm.cmd` avoids that issue without changing the machine-wide policy.

Other useful commands:

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd start
```

`npm.cmd start` runs the production Express server and expects an existing `dist/` build.

## HTTPS And Reverse Proxy

Production should be accessed through an HTTPS domain. Nginx should proxy the public domain to:

```text
http://127.0.0.1:4000
```

After changing Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Do not expose port `4000` publicly when Nginx is the intended public entry point.

## Installable Web App

CashMap includes a web manifest and service worker. Installation requires a supported browser and a secure HTTPS origin. Localhost is also considered secure for development, but the service worker is registered only in a production build.

After a deployment, the service worker checks for and activates updates automatically. If a browser remains stuck on an older version, perform a hard refresh. As a last resort, use browser developer tools to unregister the old CashMap service worker once, then reload.

## Versioning

CashMap follows `MAJOR.MINOR.PATCH` versioning:

- `PATCH`: compatible bug fixes and small refinements
- `MINOR`: new backward-compatible features
- `MAJOR`: breaking changes or a major redesign/data-model change

Update the version in both `package.json` and `package-lock.json`, or use npm to update both:

```bash
npm version patch --no-git-tag-version
npm version minor --no-git-tag-version
npm version major --no-git-tag-version
```

Run only the one command matching the intended release.


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
