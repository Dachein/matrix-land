# Security

Version 0.1.0 is an initial source release with local validation. It has not completed a production security assessment.

Do not post credentials, customer records, exploit payloads against a live deployment, or private logs in public issues. Report suspected vulnerabilities privately through [GitHub's Report a vulnerability form](https://github.com/Dachein/matrix-land/security/advisories/new). Include the affected commit, reproduction steps using synthetic data, expected behavior, and impact. A dedicated disclosure email address has not yet been configured.

Use independent installation and runtime credentials, explicit domain allowlists, verified SSH host keys, and a strong local vault password. Back up the encrypted vault together with installation state. Restrict filesystem access to these files. The local setup server is intended for a single operator on loopback, not a public deployment console.

Dependency checks are point-in-time results. Run `npm audit` on the locked dependencies and review upstream security updates before deploying. Do not disable certificate verification or authentication to work around an installation error.
