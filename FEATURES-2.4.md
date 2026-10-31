# TRAC51 Production v2.4 — Agenda Maintenance

This release adds a dedicated Secretariat Agenda Maintenance screen while preserving the TRAC51 visual theme and existing Live Control workflow.

## Agenda Maintenance
- Create new agenda sessions.
- Read/review the full programme grouped by conference date.
- Update session date, time, title, venue, status, description and presenter.
- Select presenters directly from active delegate records.
- Link the presentation/content and associated report from the document Library.
- Delete agenda records with a confirmation that explains Library files are retained.
- Move sessions earlier/later within the same conference day.
- Search sessions and filter by conference day.
- See live status and document-link status in the maintenance list.

## Separation of duties
- Agenda Maintenance is for planning and maintaining programme records.
- Live Control remains a separate operational screen for setting the current live session.
- Agenda Maintenance is included in the admin-only view allowlist and requires the existing admin session.

## Technical notes
- Existing PostgreSQL schema is reused; no destructive migration is required.
- Agenda create SQL placeholder mismatch has been corrected.
- Agenda ordering now groups by conference date, then sort order/time.
- Added an admin-protected reorder endpoint and audit entry.
- Deleting an agenda item removes agenda links but leaves its Library document records/files available.
