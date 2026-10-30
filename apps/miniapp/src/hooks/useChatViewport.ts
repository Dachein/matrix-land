import Taro, { useDidHide, useResize } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";
import { resizeChatViewport, updateChatKeyboard, visibleChatHeight, type ChatViewport } from "../services/chatViewport";

export function useChatViewport() {
  const native = process.env.TARO_ENV === "weapp";
  const focused = useRef(false);
  const [viewport, setViewport] = useState<ChatViewport>(() => {
    const info = Taro.getWindowInfo();
    return { width: info.windowWidth, height: info.windowHeight, keyboardHeight: 0 };
  });
  const [browserHeight, setBrowserHeight] = useState<number>();
  const onKeyboardHeight = useCallback((height: number) => {
    if (native) setViewport((current) => updateChatKeyboard(current, height));
  }, [native]);
  const onFocus = useCallback((height?: number) => {
    focused.current = true;
    if (typeof height === "number") onKeyboardHeight(height);
  }, [onKeyboardHeight]);
  const onBlur = useCallback(() => { focused.current = false; }, []);

  useResize(({ size }) => {
    if (native) setViewport((current) => resizeChatViewport(current, size.windowWidth, size.windowHeight));
  });
  useDidHide(() => { focused.current = false; onKeyboardHeight(0); });
  useEffect(() => {
    if (!native) return;
    // The global close event also arrives after the textarea blurs or becomes disabled.
    const handleKeyboard = ({ height }: { height: number }) => {
      if (focused.current || height === 0) onKeyboardHeight(height);
    };
    Taro.onKeyboardHeightChange(handleKeyboard);
    return () => Taro.offKeyboardHeightChange(handleKeyboard);
  }, [native, onKeyboardHeight]);
  useEffect(() => {
    if (native || typeof window === "undefined") return;
    const visual = window.visualViewport;
    const resize = () => setBrowserHeight(visual?.height || window.innerHeight);
    resize();
    visual?.addEventListener("resize", resize);
    window.addEventListener("resize", resize);
    return () => {
      visual?.removeEventListener("resize", resize);
      window.removeEventListener("resize", resize);
    };
  }, [native]);

  return {
    height: native ? visibleChatHeight(viewport) : browserHeight,
    keyboardOpen: native ? viewport.keyboardHeight > 0 : Boolean(browserHeight && viewport.height - browserHeight > 100),
    onKeyboardHeight, onFocus, onBlur
  };
}
