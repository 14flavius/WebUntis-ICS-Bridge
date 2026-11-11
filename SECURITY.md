# Security policy

WebUntis ICS Bridge stores WebUntis credentials and publishes calendar links, so
security reports are taken seriously.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately through GitHub:
[Report a vulnerability](https://github.com/14flavius/webuntis-ics-bridge/security/advisories/new).

Include what you found, how to reproduce it and which version or commit you used.
Remove passwords, feed links and personal timetable data from logs and examples.

You can expect a first answer within a week. Please give a fix reasonable time
before publishing details.

## Supported versions

Only the latest release on the `main` branch receives security fixes.

## Scope

In scope:

- Authentication, sessions, two-factor authentication and user administration.
- Access to another user's WebUntis accounts, events, feeds or calendar links.
- Storage and handling of WebUntis credentials and backups.
- Requests the bridge sends to other servers (for example SSRF).

Out of scope:

- Anyone holding an ICS link can read that calendar. This is how calendar
  subscriptions work; rotate the link to revoke access.
- Problems in WebUntis itself. Report those to Untis.
- Attacks that need access to the server, its `.env` files or the `data/` directory.
