# TRAC51 Conference Companion — Production Build

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
