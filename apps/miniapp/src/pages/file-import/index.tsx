import { Button, Image, Text, View } from "@tarojs/components";
import Taro, { useDidShow, useRouter } from "@tarojs/taro";
import { useRef, useState } from "react";
import { createLiveSession, getDefaultMate, redirectToLogin, uploadAttachment, uploadKnowledgeFile } from "../../services/api";
import { isAuthRequiredError } from "../../services/auth";
import { materialFileName } from "../../services/fileTypes";
import { fileTypeIcon } from "../../services/fileTypeIcons";
import { chooseFiles, chooseFileSource, isPickerCancelled } from "../../services/fileSelection";
import { useUploadTimer } from "../../hooks/useUploadTimer";
import { USE_MOCKS } from "../../services/request";
import { state } from "../../state";
import type { Mate } from "../../types";
import "./index.scss";

type ImportFile = { path: string; name: string; size: number; type: string };

export default function FileImportPage() {
  const router = useRouter();
  const manual = router.params.manual === "1";
  const [file, setFile] = useState<ImportFile>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [uploadTarget, setUploadTarget] = useState<"mate" | "knowledge">();
  const elapsed = useUploadTimer(busy);
  const uploadLabel = `文件上传中 · ${elapsed}`;
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [defaultMate, setDefaultMate] = useState<Mate | null>(null);
  const [mateLoading, setMateLoading] = useState(true);

  useDidShow(() => {
    if (!USE_MOCKS && !state.getUser()) {
      setDefaultMate(null);
      setMateLoading(false);
    } else {
      setMateLoading(true);
      void getDefaultMate().then((mate) => {
        setDefaultMate(mate?.status === "published" ? mate : null);
      }).catch((caught) => {
        if (isAuthRequiredError(caught)) { redirectToLogin(); return; }
        setDefaultMate(null);
        setError("暂时无法获取默认 Mate，仍可保存到知识库。");
      }).finally(() => setMateLoading(false));
    }
    if (manual) return;
    try {
      const entry = Taro.getEnterOptionsSync();
      const material = entry.scene === 1173 ? entry.forwardMaterials?.[0] : undefined;
      if (material?.path) {
        const type = material.type || "application/octet-stream";
        setFile({ path: material.path, name: materialFileName(material.name, type), size: material.size || 0, type });
        setSaved(false);
        setError("");
      }
    } catch { /* H5 preview does not provide WeChat entry options. */ }
  });

  async function chooseFile() {
    if (!USE_MOCKS && !state.getUser()) {
      await Taro.navigateTo({ url: "/pages/login/index?returnTo=file-import&manual=1" });
      return;
    }
    try {
      const source = await chooseFileSource();
      const [chosen] = await chooseFiles(source, 1);
      if (chosen) {
        setFile({ path: chosen.path, name: chosen.name, size: chosen.size, type: chosen.type || "application/octet-stream" });
        setSaved(false); setError("");
      }
    } catch (caught) {
      if (!isPickerCancelled(caught)) setError("无法选择文件，请重试。");
    }
  }

  async function localFile(selected: ImportFile) {
    if (/^http:\/\//i.test(selected.path)) throw new Error("download_insecure");
    if (!/^https?:\/\//i.test(selected.path)) {
      if (selected.size) return selected;
      const info = await Taro.getFileInfo({ filePath: selected.path });
      return { ...selected, size: "size" in info ? info.size : selected.size };
    }
    const response = await Taro.downloadFile({ url: selected.path });
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error("download_failed");
    const info = await Taro.getFileInfo({ filePath: response.tempFilePath });
    return { ...selected, path: response.tempFilePath, size: "size" in info ? info.size : selected.size };
  }

  async function run(target: "mate" | "knowledge", action: (selected: ImportFile) => Promise<void>) {
    if (!file || busyRef.current) return;
    if (!USE_MOCKS && !state.getUser()) {
      await Taro.navigateTo({ url: `/pages/login/index?returnTo=file-import${manual ? "&manual=1" : ""}` });
      return;
    }
    busyRef.current = true; setUploadTarget(target); setBusy(true); setError("");
    try { await action(await localFile(file)); }
    catch (caught) {
      if (isAuthRequiredError(caught)) { redirectToLogin(); return; }
      const code = caught instanceof Error ? caught.message : "";
      setError(code === "default_mate_unavailable" ? "请先开通默认 Mate。" : code === "knowledge_upload_forbidden" ? "你没有这个知识库的写入权限。" : code === "workspace_attachment_type_unsupported" ? "默认 Mate 暂时无法读取这种文件格式。" : code === "knowledge_file_too_large" || code === "workspace_attachment_too_large" || code === "upload_file_too_large" ? "文件超过 20 MiB 上传限制。" : code === "download_insecure" || code === "download_failed" ? "无法下载这个网页素材，请从微信聊天中选择文件。" : "处理文件失败，请重试。");
    } finally { busyRef.current = false; setBusy(false); setUploadTarget(undefined); }
  }

  function sendToMate() {
    void run("mate", async (selected) => {
      const mate = await getDefaultMate();
      if (!mate || mate.status !== "published") {
        setDefaultMate(null);
        throw new Error("default_mate_unavailable");
      }
      const session = await createLiveSession(mate, undefined, { newConversation: true });
      const attachment = await uploadAttachment(session, selected);
      state.setMate(mate);
      state.setLiveSession(session);
      state.setPendingImport(mate.id, attachment);
      await Taro.redirectTo({ url: "/pages/chat/index" });
    });
  }

  function saveToKnowledge() {
    void run("knowledge", async (selected) => {
      await uploadKnowledgeFile(selected);
      setSaved(true);
    });
  }

  return <View className="file-import-page">
    <View className="file-import-head"><Text onClick={() => Taro.navigateBack()}>‹</Text><Text>打开文件</Text></View>
    <View className="file-import-content">
      <Text className="file-import-eyebrow">Mate</Text>
      <Text className="file-import-title">{defaultMate ? "这个文件要放在哪里？" : "保存文件到知识库"}</Text>
      <View className="file-import-card">
        <Image className="file-import-icon" src={fileTypeIcon(file?.name || "", file?.type)} mode="aspectFit" />
        <View className="file-import-file"><Text className="file-import-name">{file?.name || "还没有选择文件"}</Text><Text className="file-import-meta">{file ? `${Math.ceil(file.size / 1024)} KB` : "从微信聊天或相册选择"}</Text></View>
      </View>
      {!file && <Button className="file-import-choose" onClick={() => void chooseFile()}>从微信聊天或相册选择</Button>}
      {file && <>
        {mateLoading && <Text className="file-import-status">正在查找默认 Mate…</Text>}
        {!mateLoading && defaultMate && <Button className="file-import-primary" disabled={busy} onClick={sendToMate}>{busy && uploadTarget === "mate" ? uploadLabel : `发送给「${defaultMate.displayName}」`}</Button>}
        {!mateLoading && <Button className={defaultMate ? "file-import-secondary" : "file-import-primary"} disabled={busy || saved} onClick={saveToKnowledge}>{busy && uploadTarget === "knowledge" ? uploadLabel : saved ? "已保存到知识库" : "保存到知识库"}</Button>}
        <Text className="file-import-hint">保存位置：我的知识库。知识库会按你的权限处理文件。</Text>
      </>}
      {error && <Text className="file-import-error">{error}</Text>}
    </View>
  </View>;
}
