import { useState } from "react";
import { WorkspaceLogin } from "../components/WorkspaceLogin";

/** Local visual acceptance only; no mail or authentication service is connected. */
export function LoginPreview() {
  const [email, setEmail] = useState(true);
  return <WorkspaceLogin emailLoginConfigured entraLoginConfigured emailLoginUrl="/__local/preview-unavailable"
    isEmailAuth={email} onSwitchAuthMethod={() => setEmail(current => !current)} onMicrosoftSignIn={() => {}}
    redirect="/home" />;
}
