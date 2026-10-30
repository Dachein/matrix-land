import { Button, Image, Input, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useLoad } from "@tarojs/taro";
import { useMemo, useRef, useState } from "react";
import folderIcon from "../../assets/folder-open.png";
import { fileTypeIcon } from "../../services/fileTypeIcons";
import { MateSidebar } from "../../components/MateSidebar";
import { listMates, loadKnowledgeLibraryFolder, loadKnowledgeLibraryHome, logout, redirectToLogin, refreshCurrentUserProfile, requireAuth, uploadKnowledgeFile } from "../../services/api";
import { isAuthRequiredError } from "../../services/auth";
import { chooseFiles, chooseFileSource, isPickerCancelled } from "../../services/fileSelection";
import { useI18n } from "../../services/i18n";
import { useUploadTimer } from "../../hooks/useUploadTimer";
import { selectFilePreview } from "../../services/filePreview";
import { state } from "../../state";
import type { KnowledgeLibraryHome, KnowledgeLibraryItem, KnowledgeLibraryRecentFile, Mate } from "../../types";
import "./index.scss";

type Relation = "all" | "mine" | "viewer";
const SHOW_KNOWLEDGE_UPLOAD_ACTION = false;

export default function KnowledgePage() {
  const { t } = useI18n();
  const [home, setHome] = useState<KnowledgeLibraryHome>();
  const [trail, setTrail] = useState<KnowledgeLibraryItem[]>([]);
  const [folderItems, setFolderItems] = useState<KnowledgeLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [relation, setRelation] = useState<Relation>("all");
  const [uploading, setUploading] = useState(false);
  const uploadInFlight = useRef(false);
  const elapsed = useUploadTimer(uploading);
  const [uploadStatus, setUploadStatus] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [mates, setMates] = useState(() => state.getMates());
  const [user, setUser] = useState(() => state.getUser());
  const folderRequest = useRef(0);
  const selectedMate = state.getLiveSession()?.mate || state.getMate();
  const needsFirstMate = !mates.some((mate) => mate.isDefault && mate.status === "published");
  const navigation = useMemo(() => customNavigationMetrics(), []);
  const currentFolder = trail[trail.length - 1];
  const rootItems = (home?.items || []).filter((item) => item.kind === "folder" && !item.parentPath);
  const rootRows = rootItems.filter((item) => matches(item.name, item.description, query)
    && (relation === "all" || relation === "viewer" && role(item) === "viewer"
      || relation === "mine" && (role(item) === "owner" || role(item) === "collaborator")));
  const folderRows = folderItems.filter((item) => matches(item.name, item.description, query));
  const recentRows = (home?.recentFiles || []).filter((entry) => matches(entry.item.fileName, entry.item.relativePath, query));

  useLoad(() => {
    if (!requireAuth()) return;
    void loadHome();
  });

  async function loadHome() {
    setLoading(true);
    setError("");
    try { setHome(await loadKnowledgeLibraryHome()); }
    catch (caught) {
      if (isAuthRequiredError(caught)) { redirectToLogin(); return; }
      setError(t("knowledge.loadFailed"));
    } finally { setLoading(false); }
  }

  async function openFolder(item: KnowledgeLibraryItem, nextTrail: KnowledgeLibraryItem[]) {
    const request = ++folderRequest.current;
    setTrail(nextTrail);
    setFolderItems([]);
    setQuery("");
    setLoading(true);
    setError("");
    try {
      const items = await loadKnowledgeLibraryFolder(item.id);
      if (request === folderRequest.current) setFolderItems(items);
    } catch (caught) {
      if (request !== folderRequest.current) return;
      if (isAuthRequiredError(caught)) { redirectToLogin(); return; }
      setError(t("knowledge.loadFailed"));
    } finally { if (request === folderRequest.current) setLoading(false); }
  }

  function openRoot() {
    folderRequest.current += 1;
    setTrail([]);
    setFolderItems([]);
    setQuery("");
    setError("");
    setLoading(false);
  }

  function goUp() {
    if (trail.length < 2) { openRoot(); return; }
    const parentTrail = trail.slice(0, -1);
    void openFolder(parentTrail[parentTrail.length - 1], parentTrail);
  }

  async function upload() {
    if (uploadInFlight.current || !requireAuth()) return;
    uploadInFlight.current = true;
    try {
      const source = await chooseFileSource();
      const [file] = await chooseFiles(source, 1);
      if (!file) return;
      setUploading(true); setUploadStatus("");
      await uploadKnowledgeFile(file, currentFolder?.id);
      setUploadStatus(t("knowledge.saved", { name: file.name }));
      if (currentFolder) void openFolder(currentFolder, trail);
      else void loadHome();
    } catch (caught) {
      if (isAuthRequiredError(caught)) { redirectToLogin(); return; }
      if (!isPickerCancelled(caught)) {
        const code = caught instanceof Error ? caught.message : "";
        setUploadStatus(code === "upload_file_too_large" || code === "knowledge_file_too_large" ? t("knowledge.tooLarge") : code === "knowledge_upload_forbidden" ? t("knowledge.forbidden") : t("knowledge.uploadFailed"));
      }
    } finally { uploadInFlight.current = false; setUploading(false); }
  }

  function openFile(file: { id: string; name: string; mimeType?: string; sizeBytes?: number; modifiedAt?: string }) {
    selectFilePreview(file);
    void Taro.navigateTo({ url: `/pages/knowledge-preview/index?id=${encodeURIComponent(file.id)}` });
  }

  function openMenu() {
    setMenuOpen(true);
    void listMates({ force: true }).then(setMates).catch(() => setMates(state.getMates()));
    void refreshCurrentUserProfile().then((profile) => { if (profile) setUser(profile); }).catch(() => {});
  }

  async function switchMate(mate: Mate) {
    if (mate.status !== "published") { await Taro.showToast({ title: t("home.unpublished"), icon: "none" }); return; }
    state.setMate(mate);
    if (state.getLiveSession()?.mate.id !== mate.id) state.clearLiveSession();
    setMenuOpen(false);
    await Taro.redirectTo({ url: "/pages/chat/index" });
  }

  async function signOut() {
    const confirmed = await Taro.showModal({ title: t("account.logoutTitle"), content: t("account.logoutBody"), confirmText: t("account.logout"), confirmColor: "#a02920" });
    if (!confirmed.confirm) return;
    try { await logout(); await Taro.reLaunch({ url: "/pages/login/index" }); }
    catch { await Taro.showToast({ title: t("account.logoutFailed"), icon: "none" }); }
  }

  function itemRow(item: KnowledgeLibraryItem) {
    const sharing = sharingScope(item);
    return <View className="knowledge-row" key={item.id} onClick={() => item.kind === "folder" ? void openFolder(item, [...trail, item]) : openFile(item)}>
      <Image className="knowledge-row-icon" mode="aspectFit" src={item.kind === "folder" ? folderIcon : fileTypeIcon(item.name, item.mimeType)} />
      <View className="knowledge-row-copy"><Text className="knowledge-row-name">{item.name}</Text>{!currentFolder && item.description && <Text className="knowledge-row-detail">{item.description}</Text>}</View>
      {!currentFolder && <View className={`knowledge-row-sharing ${sharing.kind}`}><Text>{sharing.kind === "collaboration" ? t("knowledge.visibility.collaboration", { count: sharing.count }) : t(`knowledge.visibility.${sharing.kind}`)}</Text></View>}
      <Text className="knowledge-row-chevron">›</Text>
    </View>;
  }

  function recentRow(entry: KnowledgeLibraryRecentFile) {
    return <View className="knowledge-row" key={entry.item.objectId} onClick={() => openFile({ id: entry.item.objectId, name: entry.item.fileName, mimeType: entry.item.mimeType, sizeBytes: entry.item.sizeBytes, modifiedAt: entry.item.updatedAt })}>
      <Image className="knowledge-row-icon" mode="aspectFit" src={fileTypeIcon(entry.item.fileName, entry.item.mimeType)} />
      <View className="knowledge-row-copy"><Text className="knowledge-row-name">{entry.item.fileName}</Text><Text className="knowledge-row-detail">{entry.item.relativePath || entry.serviceName || ""}</Text></View>
      <Text className="knowledge-row-chevron">›</Text>
    </View>;
  }

  return <View className="knowledge-page">
    <View className="knowledge-head" style={{ height: `${navigation.height}px`, paddingTop: `${navigation.statusBarHeight}px` }}>
      <Text className={`knowledge-menu-trigger${currentFolder ? " back" : ""}`} onClick={currentFolder ? goUp : openMenu} aria-label={t(currentFolder ? "knowledge.back" : "chat.menu")}>{currentFolder ? "‹" : "☰"}</Text>
      <Text className="knowledge-title">{t("chat.knowledge")}</Text>
      <View className="knowledge-head-spacer" />
    </View>
    <ScrollView className="knowledge-content" scrollY>
      <View className="knowledge-toolbar">
        <View className="knowledge-search"><Text>⌕</Text><Input value={query} onInput={(event) => setQuery(event.detail.value)} placeholder={t("knowledge.search")} /></View>
        {SHOW_KNOWLEDGE_UPLOAD_ACTION && <Button className="knowledge-upload" disabled={uploading} onClick={() => void upload()}>{uploading ? `${t("files.uploading")} · ${elapsed}` : `＋　${t("knowledge.upload")}`}</Button>}
      </View>
      {uploadStatus && <Text className="knowledge-upload-status">{uploadStatus}</Text>}
      {currentFolder ? <View className="knowledge-breadcrumbs"><Text onClick={openRoot}>{t("chat.knowledge")}</Text>{trail.map((item, index) => <Text key={item.id} onClick={() => { if (index < trail.length - 1) void openFolder(item, trail.slice(0, index + 1)); }}> / {item.name}</Text>)}</View> : <View className="knowledge-filters">{(["all", "mine", "viewer"] as const).map((value) => <Text key={value} className={relation === value ? "active" : ""} onClick={() => setRelation(value)}>{t(`knowledge.filter.${value}`)}</Text>)}</View>}
      {loading && <Text className="knowledge-state">{t("knowledge.loading")}</Text>}
      {error && <View className="knowledge-error"><Text>{error}</Text><Button onClick={() => currentFolder ? void openFolder(currentFolder, trail) : void loadHome()}>{t("common.retry")}</Button></View>}
      {!loading && !error && <View className="knowledge-list">
        {(currentFolder ? folderRows : rootRows).map(itemRow)}
        {!(currentFolder ? folderRows : rootRows).length && <Text className="knowledge-list-empty">{query ? t("knowledge.noResults") : currentFolder ? t("knowledge.emptyFolder") : t("knowledge.empty")}</Text>}
        {!currentFolder && <><Text className="knowledge-list-group">{t("knowledge.recent")}</Text>{recentRows.length ? recentRows.map(recentRow) : <Text className="knowledge-list-empty">{t("knowledge.noRecent")}</Text>}</>}
      </View>}
    </ScrollView>
    <MateSidebar active="knowledge" mates={mates} onClose={() => setMenuOpen(false)} onCreate={() => { setMenuOpen(false); void Taro.redirectTo({ url: "/pages/chat/index?create=1" }); }} onKnowledge={() => setMenuOpen(false)} onLogout={() => void signOut()} onSelect={(mate) => void switchMate(mate)} onSetup={() => { setMenuOpen(false); void Taro.redirectTo({ url: "/pages/mates/index" }); }} onSettings={(mate) => { setMenuOpen(false); void Taro.navigateTo({ url: `/pages/mate-settings/index?id=${encodeURIComponent(mate.id)}` }); }} open={menuOpen} selectedMateId={selectedMate?.id} showSetup={needsFirstMate} user={user} />
  </View>;
}

function matches(name: string, detail = "", query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || `${name} ${detail}`.toLocaleLowerCase().includes(needle);
}

function role(item: KnowledgeLibraryItem) {
  return item.effectiveRole || item.access || "viewer";
}

function sharingScope(item: KnowledgeLibraryItem) {
  const itemRole = role(item);
  if (itemRole === "viewer") return { count: 0, kind: "shared" as const };
  const explicitCount = Number(item.collaboratorCount);
  const count = Math.max(
    Number.isFinite(explicitCount) && explicitCount >= 0 ? Math.floor(explicitCount) : 0,
    item.collaboratorUserIds?.length || 0,
    itemRole === "collaborator" ? 1 : 0
  );
  return count > 0
    ? { count, kind: "collaboration" as const }
    : { count: 0, kind: "private" as const };
}

function customNavigationMetrics() {
  const windowInfo = Taro.getWindowInfo();
  const capsule = Taro.getMenuButtonBoundingClientRect();
  const statusBarHeight = windowInfo.statusBarHeight || capsule.top || 20;
  const gap = Math.max(4, capsule.top - statusBarHeight);
  return { height: capsule.bottom + gap, statusBarHeight };
}
