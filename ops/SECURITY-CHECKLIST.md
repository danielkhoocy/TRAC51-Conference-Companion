# TRAC51 Production Security Checklist

## Authentication
- Participant login: NRIC + last 6 digits of NRIC PIN.
- Raw NRIC is not stored by the application.
- Participant/admin sessions use HttpOnly, SameSite cookies.
- Login attempts are rate-limited.
- Admin credentials are stored only in Railway Variables.
- `SESSION_SECRET` and `PARTICIPANT_SECRET` are different random secrets.

## Data exposure
- NRIC is never returned through public API responses.
- NRIC is not used in URLs.
- Uploaded files are served only to authenticated users.
- Audit logs do not contain raw NRIC values.

## Storage
- Postgres is the system of record.
- `/data` Railway Volume stores uploaded conference files and photos.
- Enable scheduled Railway backups for the Postgres service and `/data` volume.
- Keep a logical Postgres dump as an additional offsite backup if the organisation's policy requires it.

## Operations
- Use a private GitHub repository.
- Keep only one TRAC51 web-service replica while files live on the attached volume.
- Do not horizontally scale the service unless uploads are moved to shared object storage.
- Test restore procedures before the conference.
- Remove `SEED_DEMO` before loading real delegate data.

## Governance
- Obtain the organisation's privacy/security approval before importing real NRIC data.
- Publish a privacy notice appropriate to the conference registration process.
- Define retention/deletion rules for delegate records and conference photos.
