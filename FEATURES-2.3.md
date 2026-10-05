# TRAC51 Production v2.3

Participant login hardening and test reliability update.

- Synthetic demo delegate is ensured at login when `SEED_DEMO=true`, preventing false negatives when the variable was added after the initial deployment.
- Participant login now returns distinct messages for missing delegate vs incorrect PIN.
- Successful participant login immediately establishes the delegate identity in the UI before loading the full conference bundle.
- Non-authentication content-load errors no longer silently throw the user back to the login screen.
- Admin APIs remain server-side protected by an admin-only session.

Demo test remains: NRIC `900101145678`, PIN `145678`. Set `SEED_DEMO=true` for testing only.
