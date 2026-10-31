# TRAC51 Conference Companion — Production Build v2.2

This build is designed for a simple **Railway + GoDaddy** deployment.

## Architecture
- Railway: TRAC51 web application
- Railway PostgreSQL: persistent conference database
- Railway Volume mounted at `/data`: uploaded reports/slides/photos
- GoDaddy: existing `tracmy.org` domain and email
- Public URL: `https://trac51.tracmy.org`

## Features
- Participant login using NRIC + last 6 digits PIN
- Raw NRIC never stored; HMAC hashes only
- Secure HttpOnly participant/admin sessions
- Login rate limiting
- Admin-controlled LIVE NOW agenda
- Immediate live updates using server-sent events
- Delegate directory
- Announcements and moderation
- Event sign-up and cancellation
- Conference Help Desk
- Reports, slides and photos
- Static content management
- Delegate CSV import
- Audit log
- Health endpoint

## Start here
Read `START-HERE.md`.

## Important
This is a deployment-ready application package, but the final production deployment still requires the organisation to create its own Railway account, secrets, database, domain records and privacy/security approvals. Never commit real delegate NRIC data or production secrets to GitHub.

## v2.2 fixes
- Demo participant seeding no longer depends on agenda seed data already existing.
- Participants cannot switch into or navigate to admin views in the UI.
- All admin API endpoints remain server-side protected by admin sessions.
- Participant actions remain limited to viewing, registering, reacting, asking questions, and help requests.
- Added quick reactions to agenda sessions.

## Demo testing
Set `SEED_DEMO=true` temporarily and redeploy to activate the synthetic participant `900101145678` / `145678`. After testing, set it back to `false` and redeploy; the demo account is automatically deactivated.
