# Application authentication

Use `apps_get_app` to retrieve the current App and its `developerContext`. The context contains the instance-specific SDK URL, verified session endpoint and registration details. Install the exact SDK version supplied by that instance. Do not copy another company's hostname or credentials.

The application verifies the signed workspace session, then maintains its own `app_users` record and application roles. Workspace authentication establishes identity; application authorization decides which records and actions that identity may access. An authenticated user never receives an application administrator role solely because they are the first visitor.

A short-lived signed handoff link can deliver the same development context to a client that cannot call MCP directly. Keep the link private and use it only for its intended App. Never embed a handoff token, service key or platform credential in client JavaScript.
