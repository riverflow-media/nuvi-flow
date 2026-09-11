# Security policy

Please do not publish vulnerabilities, stream tokens, passwords, database files, or private media paths in a public issue.

Until a dedicated security contact is configured, open a GitHub private vulnerability report for the repository. Include the affected version, reproduction steps, impact, and any suggested mitigation.

Supported versions receive security fixes through the latest published release. Home-server operators should keep the dashboard on a trusted network, use unique secrets, and update the container or Windows app when releases are published.

Nuvi-Flow generates a private 256-bit addon installation URL on first startup. All manifest, catalog, metadata, and stream-discovery requests require that URL. Keep it private and regenerate it from the authenticated dashboard if it is exposed; regeneration revokes the previous addon URL immediately.

Media and Silo proxy URLs use separate signed, expiring tokens. Do not paste addon or playback URLs into public issues or logs. Nuvi-Flow redacts addon access tokens from its own structured request logs, but reverse proxies should also be configured to avoid recording sensitive URL paths.
