# TRAC51 Production Build 2.1 — Agenda & Library Content Management

This release adds proper presenter selection and document management for conference agenda items.

## Agenda
- Presenter is selected from the imported Delegate Directory.
- Presenter email, mobile and photo are taken from the delegate record.
- Every agenda item has dedicated slots for:
  - Content being presented (typically presentation/slides)
  - Associated report
- An agenda item can link to documents already in the Library.
- An existing agenda item can also upload a new presentation/report directly and link it immediately.

## Library
- Upload documents into a managed Library.
- Link a document to an agenda as Content, Report or Supporting.
- Replace a document without breaking the agenda link.
- Every replacement creates a new numbered version.
- Older versions remain available and can be restored as the current version.
- Archive a document to hide it from delegates without losing history.
- Permanently delete a document and its stored versions when required.

## Migration
The application automatically upgrades an existing TRAC51 PostgreSQL database on startup. No manual SQL migration is required.
It also backfills older uploaded files into version 1 where the files are still present on the Railway volume, and promotes legacy presenter names to delegate-linked presenters where an exact name match exists.

## Railway
Push these updated files to the same GitHub repository connected to Railway. Railway will create a new deployment automatically. Do not change your existing DATABASE_URL, admin credentials or secrets.
