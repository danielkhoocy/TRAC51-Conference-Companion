# TRAC51 — START HERE

This is the production-oriented TRAC51 Conference Companion for **Railway + GoDaddy**.

## What you need to do

You do not need to change the application code.

### A. Create a private GitHub repository

Create a private repository named:

`trac51-conference-companion`

Unzip this package and upload the **contents of the `trac51-railway-production` folder** to that repository. Make sure these are at the top level:

- `package.json`
- `server.js`
- `public/`
- `seed/`
- `ops/`

### B. Create the Railway project

1. Go to Railway and sign in with GitHub.
2. Choose **New Project**.
3. Choose **Deploy from GitHub repo**.
4. Select `trac51-conference-companion`.
5. Railway will create the web service.
6. In the project canvas choose **+ New → Database → PostgreSQL**.
7. Give the database the name `Postgres`.
8. Open the TRAC51 web service and go to **Variables**.
9. Add:

`DATABASE_URL = ${{Postgres.DATABASE_URL}}`

`NODE_ENV = production`

`RAILWAY_VOLUME_MOUNT_PATH = /data`

`ADMIN_USER = <your Secretariat username>`

`ADMIN_PASSWORD = <your strong admin password>`

`SESSION_SECRET = <random secret, at least 32 characters>`

`PARTICIPANT_SECRET = <different random secret, at least 32 characters>`

Do not put real secrets into GitHub.

10. Open **Settings → Volumes** on the TRAC51 web service. Add a volume with mount path:

`/data`

Use the size available on your chosen plan. The app uses `/data/uploads` for conference files/photos.

11. Open the web service **Settings** and set the region to **Southeast Asia / Singapore**.
12. Set the healthcheck path to:

`/health`

13. Deploy.

### C. Test the temporary Railway address

Railway can generate a public domain from the service's Networking settings.

Open the generated `https://....railway.app` address.

For a synthetic demo test only, set:

`SEED_DEMO = true`

before the first deployment. The demo participant is:

- NRIC: `900101145678`
- PIN: `145678`

After testing, remove `SEED_DEMO` and redeploy. Do not import real delegates while demo data is enabled.

### D. Connect your GoDaddy domain

In Railway, open the TRAC51 service:

**Settings → Networking → Custom Domain**

Enter:

`trac51.tracmy.org`

Railway will show the exact **CNAME** and **TXT** records needed.

In GoDaddy:

**Domains → tracmy.org → DNS → Add New Record**

Add the CNAME and TXT exactly as Railway shows them.

Do not change your existing `@` or email/MX records.

When Railway shows the custom domain as verified, use:

`https://trac51.tracmy.org`

### E. Prepare the real delegate list

Use the supplied `DELEGATES-TEMPLATE.csv`.

Required fields for participant login:

- Name
- NRIC Number

Recommended fields:

- ID
- Church
- District
- Conference Role
- Board/Committee
- Email
- Phone
- Photo URL

Upload the real list through **Admin → Data Import** only after the production login/security test is complete.

## Secretariat daily use

Once deployed, the Secretariat should not need GitHub or Railway for normal work. Everything is managed from the TRAC51 Admin Console:

- Live Control
- Agenda
- Announcements
- Moderation
- Events
- Library uploads
- Photos
- Static conference information
- Delegate import
- Help Desk

## Backups

Railway supports scheduled backups for volume-backed services. Enable backups for both the Postgres service and the `/data` volume before the conference.

For Postgres, consider enabling point-in-time recovery as an additional protection layer.

## Before real launch

- Replace demo/admin credentials.
- Keep `SEED_DEMO` unset or false.
- Test the real domain over HTTPS.
- Test participant login with 3–5 synthetic records.
- Test an event registration and cancellation.
- Test LIVE NOW from one admin device and verify the change appears on another participant device.
- Test a report upload and photo upload.
- Test delegate import.
- Test moderation and help desk.
- Confirm the organisation's privacy notice and data governance approval before importing actual NRIC data.

## Agenda + Library management (Build 2.1)
Agenda editing now lets Secretariat select a presenter from the delegate directory and link a presentation and report from the Library. Existing sessions can also upload and attach a new presentation/report directly. The Library now supports versioned replacement, restore, link/unlink through the agenda editor, archiving and permanent deletion.

When updating an existing Railway deployment, simply replace the files in the GitHub repository with this package and wait for Railway to deploy. The database schema upgrades itself at startup.
