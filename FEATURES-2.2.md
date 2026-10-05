# TRAC51 v2.2 — Login & permissions fix

## Fixed
- Participant login demo account is ensured whenever `SEED_DEMO=true`, even if agenda records already exist.
- When `SEED_DEMO=false`, the synthetic DEMO-001 participant is automatically deactivated.
- Admin navigation/button is hidden from participants.
- Client-side navigation blocks admin views unless an authenticated admin session exists.
- All server-side admin endpoints continue to require an admin session.
- Added explicit quick reactions (👍, 👏, 🙏) through the moderated participant interaction endpoint.

## Participant permissions
Participants can consume conference content; register/cancel elective events; view delegate profiles; submit questions and reactions; and submit help requests. They cannot modify agenda, set LIVE NOW, publish announcements, moderate, upload/replace/delete documents, edit static content, import delegates, or manage events.
