# Workspace application development

The public entry point is `apps_get_app`. Its `developerContext` describes authentication, model access, mail, storage and the deployment target for the current enterprise instance. Use the returned endpoints and scoped grants.

Build locally, upload a source snapshot and an explicit deployment artifact, inspect the deployment result, then publish the selected release. The CLI lives in `packages/cli`; credentials and installed MCP server entries are isolated by the Auth and MCP origins. Installing a second workspace preserves the first workspace and unrelated connectors.

Application capabilities are declared and provisioned explicitly. Disabled services have no implicit fallback to a vendor endpoint. A service key must never be copied from another instance or placed in a public asset.
