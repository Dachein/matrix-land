// Compatibility entrypoint for the root API test command. The miniapp API is
// owned and tested by its dedicated Worker.
import "../../../workers/miniapp-api/src/facade.test.mjs";
import "./ingress.test.mjs";
