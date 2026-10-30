# Security

Version 0.1.0 is an initial source release with local validation. It has not completed a production security assessment.

Do not post credentials, customer records, exploit payloads against a live deployment, or private logs in public issues. Contact the repository owner through an available private channel for suspected vulnerabilities. A dedicated disclosure address has not yet been configured.

Use independent installation and runtime credentials, explicit domain allowlists, verified SSH host keys, and a strong local vault password. Back up the encrypted vault together with installation state. Restrict filesystem access to these files. The local setup server is intended for a single operator on loopback, not a public deployment console.

Dependency checks are point-in-time results. Run `npm audit` on the locked dependencies and review upstream security updates before deploying. Do not disable certificate verification or authentication to work around an installation error.
