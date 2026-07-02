# CashMap

CashMap is a personal finance web application for cash-flow projections, transactions, recurring payments, budgets, account reconciliation, household sharing, and loan management.

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

