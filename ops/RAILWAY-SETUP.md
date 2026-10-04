# TRAC51 Production — Railway Setup

This version is designed for a simple Railway + GoDaddy setup.

## Railway project
1. Create a new Railway project.
2. Create/add a PostgreSQL service.
3. Connect this GitHub repository as the web service.
4. Set the web service region to Singapore.
5. Add a Railway Volume to the web service and mount it at `/data`.
6. Set these variables on the web service:
   - `NODE_ENV=production`
   - `ADMIN_USER=...`
   - `ADMIN_PASSWORD=...`
   - `SESSION_SECRET=...`
   - `PARTICIPANT_SECRET=...`
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `RAILWAY_VOLUME_MOUNT_PATH=/data`
7. Set Build Command to `npm install` and Start Command to `npm start`.
8. Set Healthcheck path to `/health`.
9. Deploy.
10. Open the generated Railway domain and test the site.

## Demo testing first
Set `SEED_DEMO=true` before the first deployment if you want synthetic demo data. The demo participant is:
- NRIC: 900101145678
- PIN: 145678

Remove `SEED_DEMO` after testing. Do not upload real NRIC data until production security checks are complete.

## GoDaddy domain
In Railway, add Custom Domain and enter `trac51.tracmy.org`.
Railway will show a CNAME record and a TXT verification record. Add both in GoDaddy DNS. Do not change the root (`@`) or MX/email records.

## Backups
For the PostgreSQL service, enable scheduled volume backups. Railway also supports PITR on PostgreSQL; consider enabling it once production is stable.
For the app volume at `/data`, enable scheduled backups too because it stores uploaded reports/photos.

## Important
Use one production web service replica while using the local `/data` volume. Do not horizontally scale this app without moving uploads to shared/object storage.
