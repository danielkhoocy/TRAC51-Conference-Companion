# TRAC51 Conference Companion — Production Build v2.4

This build is designed for Railway + GoDaddy. It includes a dedicated Agenda Maintenance screen for full Secretariat CRUD and retains Live Control as a separate operational feature.

## Architecture
- Railway: TRAC51 Node.js web application
- Railway PostgreSQL: conference database
- Railway Volume mounted at `/data`: uploaded reports/slides/photos
- GoDaddy: existing `tracmy.org` domain and email
- Public URL: `https://trac51.tracmy.org`

## v2.4 agenda maintenance
- Dedicated Admin → Agenda Maintenance page
- Create, read, update, delete agenda sessions
- Manage date, time, title, venue, status, presenter and session description
- Presenter selected from active Delegate Directory records
- Link content/presentation and associated report from the Library
- Day filter, text search, live status and document-link indicators
- Move sessions up/down within each conference day
- Separate Live Control remains the place to set LIVE NOW

## Existing features retained
- Participant NRIC + last-six-digit PIN login with hashed NRIC storage
- Admin-only APIs and secure sessions
- Live agenda, realtime updates, delegate directory, feed and moderation
- Events and registration, help desk, static content, Library and versioned documents
- Delegate CSV import, audit log and health endpoint

## Deployment update
For an existing Railway deployment, replace the files in the existing private GitHub repository with the contents of this package and let Railway deploy the new commit. Do not create a new project or database. Existing environment variables and PostgreSQL data are retained.

Do not commit real delegate NRIC data or production secrets to GitHub. Keep `SEED_DEMO=false` for production.
