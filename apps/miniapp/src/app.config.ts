export default defineAppConfig({
  pages: [
    "pages/chat/index",
    "pages/login/index",
    "pages/mates/index",
    "pages/mate-settings/index",
    "pages/capabilities/index",
    "pages/knowledge/index",
    "pages/knowledge-preview/index",
    "pages/file-import/index"
  ],
  window: {
    backgroundTextStyle: "light",
    navigationBarBackgroundColor: "#f3f2ee",
    navigationBarTitleText: "工作区 AI",
    navigationBarTextStyle: "black",
    backgroundColor: "#f3f2ee"
  },
  lazyCodeLoading: "requiredComponents",
  supportedMaterials: [
    { materialType: "application/*", name: "用${nickname}保存", desc: "发送给默认 Mate 或保存到知识库", path: "pages/file-import/index" },
    { materialType: "text/plain", name: "用${nickname}保存", desc: "发送给默认 Mate 或保存到知识库", path: "pages/file-import/index" },
    { materialType: "text/html", name: "用${nickname}保存", desc: "发送给默认 Mate 或保存到知识库", path: "pages/file-import/index" },
    { materialType: "text/markdown", name: "用${nickname}保存", desc: "发送给默认 Mate 或保存到知识库", path: "pages/file-import/index" },
    { materialType: "image/*", name: "用${nickname}保存", desc: "发送给默认 Mate 或保存到知识库", path: "pages/file-import/index" }
  ]
});
