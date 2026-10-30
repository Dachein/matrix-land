import { Button, ScrollView, Text, View } from "@tarojs/components";
import { useEffect, useRef, useState } from "react";
import { loadKnowledgeLibraryFolder, loadKnowledgeLibraryHome, redirectToLogin } from "../services/api";
import { isAuthRequiredError } from "../services/auth";
import { useI18n } from "../services/i18n";
import type { KnowledgeLibraryItem } from "../types";
import "./KnowledgeFolderPicker.scss";

export function KnowledgeFolderPicker({ onClose, onSelect, busy, error }: {
  onClose: () => void;
  onSelect: (folderId: string) => void;
  busy: boolean;
  error: string;
}) {
  const { t } = useI18n();
  const [path, setPath] = useState<KnowledgeLibraryItem[]>([]);
  const [items, setItems] = useState<KnowledgeLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const selected = path.at(-1);
  useEffect(() => {
    const revision = ++generation.current;
    setLoading(true); setLoadError(false);
    const request = selected ? loadKnowledgeLibraryFolder(selected.id) : loadKnowledgeLibraryHome().then((home) => home.items);
    void request.then((next) => { if (revision === generation.current) setItems(next.filter((item) => item.kind === "folder")); })
      .catch((error) => { if (revision === generation.current) { if (isAuthRequiredError(error)) redirectToLogin(); else setLoadError(true); } })
      .finally(() => { if (revision === generation.current) setLoading(false); });
    return () => { generation.current += 1; };
  }, [selected?.id, retry]);
  const role = selected?.effectiveRole || selected?.access;
  const writable = role === "owner" || role === "collaborator";
  return <View className="knowledge-folder-backdrop" onClick={busy ? undefined : onClose}><View className="knowledge-folder-picker" onClick={(event) => event.stopPropagation()}>
    <View className="create-drawer-header"><Text className="form-title">{t("files.chooseFolder")}</Text><Text className="drawer-close" onClick={busy ? undefined : onClose}>×</Text></View>
    <Text className="folder-picker-path">{path.map((item) => item.name).join(" / ") || t("files.selectLocation")}</Text>
    {!!path.length && <Button disabled={busy || loading} onClick={() => setPath((current) => current.slice(0, -1))}>‹ {t("knowledge.back")}</Button>}
    <ScrollView scrollY className="folder-picker-list">
      {loading ? <Text>{t("common.loading")}</Text> : loadError ? <Button onClick={() => setRetry((value) => value + 1)}>{t("common.retry")}</Button> : items.map((item) => <View className="folder-picker-item" key={item.id} onClick={busy ? undefined : () => setPath((current) => [...current, { ...item, effectiveRole: item.effectiveRole || item.access || selected?.effectiveRole || selected?.access }])}><Text>▱ {item.name}</Text><Text>›</Text></View>)}
      {!loading && !loadError && !items.length && <Text>{t("knowledge.emptyFolder")}</Text>}
    </ScrollView>
    {error && <Text className="error">{error}</Text>}
    <Button className="primary" disabled={!selected || !writable || busy || loading || loadError} onClick={() => selected && onSelect(selected.id)}>{busy ? t("common.processing") : t("files.saveHere")}</Button>
  </View></View>;
}
