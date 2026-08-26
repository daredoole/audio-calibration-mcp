# Contributing

Use Node.js 20 or 22. Run `npm ci`, `npm test`, `npm run coverage`, and
`npm run validate:release` before opening a pull request.

Calibration changes need deterministic fixtures, an uncertainty statement, and
measured post-application verification semantics. Never replace raw traces with
smoothed data, turn target preference into an objective law, or bypass audible
output confirmation. Mutating tools must preview, bind every field into the
confirmation token, snapshot/backup, verify, and test rollback.

Tests must not require real audio hardware. Put opt-in hardware smoke tests behind
an explicit environment flag and sanitize all contributed fixtures.
