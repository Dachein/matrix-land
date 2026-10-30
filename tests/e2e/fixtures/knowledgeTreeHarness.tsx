import { createRoot } from "react-dom/client";
import { useState } from "react";
import { useKnowledgeTree } from "../../../src/portal/knowledge/useKnowledgeTree";
import type { KnowledgeTranslate } from "../../../src/portal/knowledge/types";

const t: KnowledgeTranslate = (key) => key;

function Harness() {
  const [userId, setUserId] = useState("first");
  const [message, setMessage] = useState("");
  const tree = useKnowledgeTree({ userId, section: "my", onSectionChange: () => {}, setMessage, t });
  return <>
    <button onClick={() => setUserId((id) => id === "first" ? "second" : "first")}>Switch user</button>
    <button onClick={() => { void tree.refreshCurrentFolder().then(() => setMessage("refreshed")); }}>Refresh</button>
    <output data-testid="user">{userId}</output>
    <output data-testid="items">{tree.items.map((item) => item.id).join(",")}</output>
    <output data-testid="recent">{tree.recentItems.map((item) => item.id).join(",")}</output>
    <output data-testid="message">{message}</output>
  </>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
