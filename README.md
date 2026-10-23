# CashMap

CashMap is a personal finance web application for cash-flow projections, transactions, recurring payments, budgets, account reconciliation, household sharing, and loan management.

See [CHANGELOG.md](CHANGELOG.md) for release and implementation history.

- [Runtime requirements](#runtime-requirements)
- [Deploy updates](#updating-from-the-repository)
- [Service commands](#production-service-commands)
- [Production environment](#production-environment)
- [Back up and restore](#data-and-backups)
- [Reset an administrator](#resetting-an-administrator)
- [Local development](#local-development)
- [Dependency maintenance and checks](#dependency-maintenance-and-checks)
- [Loan reports](#using-loan-reports)
- [HTTPS and reverse proxy](#https-and-reverse-proxy)
- [Installable web app](#installable-web-app)
- [Versioning](#versioning)

## Runtime Requirements

- Node.js `20.19+` or `22.12+`
- npm
- A production HTTPS reverse proxy such as Nginx
- systemd on the Ubuntu production server hosted on Oracle Cloud

The production application is served by Express on port `4000`. Express serves the compiled Vite files from `dist/`.

## Updating From The Repository

Create a [verified production backup](#ubuntu-full-project-backup-and-restore) before updating. These commands assume the production checkout is `/home/ubuntu/CashMap` and the systemd service is named `cashmap`.

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

Stop before restarting if installation or the build fails.

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

### Ubuntu full-project backup and restore

From `/home/ubuntu/CashMap`, run:

```bash
bash scripts/cashmapBackup.sh backup
bash scripts/cashmapBackup.sh list
```

The backup command briefly stops CashMap, archives the entire project (including hidden files, data, dependencies, and Git history), compares contents and file lists while stopped, writes a checksum, and restarts the service. Wait for `PASS`. Backups are private and stored outside the project at `/home/ubuntu/cashmap-backups`. Failures restart the service and do not print `PASS`.

Restore using the actual filename shown by `list` (the filename below is an example):

```bash
bash scripts/cashmapBackup.sh restore CashMap-20261023-171617.tar.gz
```

Restore verifies the checksum and archive before stopping CashMap, preserves the current project in a timestamped sibling folder, extracts and compares the restored files, then restarts. If extraction or comparison fails, it puts the previous installation back. Restore rolls application data and settings back to the backup date; use archives created by this project's backup process. Keep any preserved folders private because they include `.env` and data.

After either command, check startup:

```bash
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:4000/api/health
```

This covers the project directory, not external Nginx/systemd configuration or installed system runtimes. Stop other edits/deployment activity during backup/restore. Run the script as `ubuntu`; it uses `sudo` only for service control. For emergency use, keep a copy of the script outside the project alongside the backups.

### Complete local Windows backup and restore

Stop this project's development servers (`Ctrl+C` in the `dev:full` terminal) before backing up or restoring. From the project directory, run:

```powershell
python scripts/projectBackup.py backup
```

This creates a timestamped ZIP in the sibling `CashMap-backups` directory. It includes every project file, including hidden/ignored files, `.git`, `.env`, `data`, `dist`, and `node_modules`. SHA-256 checks verify the archive and confirm source files did not change during backup. Wait for `VERIFIED` before proceeding. Keep the ZIP private: it contains credentials and financial data. This covers the local project directory; it does not back up the Oracle server, global Node/Python installations, or data configured outside the project. External symbolic links cause an error rather than being silently omitted.

Keep a copy of `scripts/projectBackup.py` beside the archive so it remains available if the project is unavailable. To restore, stop the app and use the helper with the actual archive filename:

```powershell
python ..\CashMap-backups\projectBackup.py restore ..\CashMap-backups\CashMap-YYYYMMDD-HHMMSS.zip --target "P:\Codex\CashMap-restored"
```

The destination must be empty or nonexistent. Every restored file is verified. Open the restored folder to use it, or rename the existing project folder and put the restored folder in its place while servers and editors are closed. The old folder is preserved for rollback. Use the same Node/npm versions recorded in the ZIP's `manifest.json`; installed native dependencies are specific to the operating system and Node version. On another platform, run `npm ci` from the restored lockfile instead of using the backed-up `node_modules`.

To check an archive without restoring:

```powershell
python ..\CashMap-backups\projectBackup.py verify ..\CashMap-backups\CashMap-YYYYMMDD-HHMMSS.zip
```

### Production data-only backup and restore

All users, households, transactions, budgets, reconciliations, and loan data are stored in:

```text
/home/ubuntu/CashMap/data/budget-app.json
```

The `data/` directory is excluded from Git, so `git pull` and `npm ci` do not transfer or replace production data.

For a data-only copy (not source code or settings), create a private backup directory and make a timestamped backup:

```bash
mkdir -p /home/ubuntu/cashmap-backups
chmod 700 /home/ubuntu/cashmap-backups
cp -p /home/ubuntu/CashMap/data/budget-app.json \
  "/home/ubuntu/cashmap-backups/budget-app-$(date +%Y%m%d-%H%M%S).json"
```

The full-project helper above stops the app automatically. For a consistent data-only backup, briefly stop CashMap before copying:

```bash
sudo systemctl stop cashmap
cp -p /home/ubuntu/CashMap/data/budget-app.json \
  "/home/ubuntu/cashmap-backups/budget-app-$(date +%Y%m%d-%H%M%S).json"
sudo systemctl start cashmap
```

Restore a data-only backup (replace `BACKUP_FILE.json` with the actual filename):

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

- Frontend: `http://localhost:5173`
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

## Dependency Maintenance And Checks

Make dependency updates locally, then test, review, and commit the lockfile before deploying with `npm ci`. Start from a clean Git state and make a backup first. Avoid fixing dependencies directly on production or using `npm audit fix --force` without reviewing breaking changes.

```powershell
npm.cmd audit fix
npm.cmd audit
npm.cmd run lint
npm.cmd run build
node scripts/testLoanReports.mjs
node scripts/testMobileLedger.mjs
node scripts/testServerSmoke.mjs
```

For routine verification without dependency changes, skip `npm.cmd audit fix`. On Ubuntu, use `npm` instead of `npm.cmd`.

Report checks cover installment assignment, balances, direct PDF generation, statement layout, and multipage exports. Mobile ledger checks cover actions, selection, transfers, zero balances, and empty results. The server smoke check uses disposable data to verify production startup, frontend serving, health, rejected and successful logins, and session authentication. Phone layout and normal user workflows still need browser/device review.

## Using Loan Reports

1. Open **Loans > Loan Manager > Reports**.
2. Choose Monthly Statement, Interest Report, or Principal & Balance Report.
3. For a monthly statement, select the loan and statement month. For a period report, select one or more loans and a preset or custom date range.
4. Select **Download PDF** to save a standalone report.

See the [report reference](docs/loan-reports.md) for calculation rules, date boundaries, payment assignment, balance definitions, missing-origination warnings, and PDF behavior.

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
