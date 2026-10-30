import { Image, Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../services/i18n";
import { animatedMateAvatarUrl, loadMateAvatarChoices, MATE_AVATAR_CHOICES } from "./mateAvatarChoices";
import "./FirstMateSetup.scss";

import type { FirstMateProgress } from "../services/defaultMateSetup";
export type { FirstMateProgress } from "../services/defaultMateSetup";

export function FirstMateSetup({ busy, error, initialAvatarUrl, initialName, navigationHeight, onCreate, progressStep }: {
  busy: boolean;
  error: string;
  initialAvatarUrl?: string;
  initialName?: string;
  navigationHeight: number;
  onCreate: (displayName: string, avatarUrl: string) => void;
  progressStep: FirstMateProgress;
}) {
  const { t } = useI18n();
  const [choices, setChoices] = useState(MATE_AVATAR_CHOICES);
  const [selectedIndex, setSelectedIndex] = useState(() => Math.max(0, MATE_AVATAR_CHOICES.findIndex((choice) => choice.savedUrl === initialAvatarUrl)));
  const [hasChosenAvatar, setHasChosenAvatar] = useState(Boolean(initialAvatarUrl));
  const [displayName, setDisplayName] = useState(initialName || "");
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [viewportHeight] = useState(() => Taro.getWindowInfo().windowHeight || 800);
  const [screenWidth] = useState(() => Taro.getWindowInfo().windowWidth || 375);
  const [dragRpx, setDragRpx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [animatedReadyId, setAnimatedReadyId] = useState("");
  const gesture = useRef<{ startX: number; startedAt: number }>();
  const lastMoveAt = useRef(0);
  const lastSwipeAt = useRef(0);
  const selected = choices[selectedIndex] || choices[0];

  useEffect(() => {
    let mounted = true;
    void loadMateAvatarChoices().then((next) => {
      if (mounted && next.length) { setChoices(next); setSelectedIndex(Math.max(0, next.findIndex((choice) => choice.savedUrl === initialAvatarUrl))); }
    }).catch(() => { /* Keep the default avatar catalog available. */ });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const onKeyboardHeightChange = (event: { height: number }) => setKeyboardHeight(Math.max(0, event.height || 0));
    Taro.onKeyboardHeightChange(onKeyboardHeightChange);
    return () => Taro.offKeyboardHeightChange(onKeyboardHeightChange);
  }, []);

  function moveSelection(direction: number) {
    setHasChosenAvatar(true);
    setSelectedIndex((index) => (index + direction + choices.length) % choices.length);
  }

  function handleTouchStart(event: any) {
    const x = event.touches?.[0]?.clientX;
    if (typeof x !== "number") return;
    gesture.current = { startX: x, startedAt: Date.now() };
    lastMoveAt.current = 0;
    setDragging(true);
  }

  function handleTouchMove(event: any) {
    const x = event.touches?.[0]?.clientX;
    if (!gesture.current || typeof x !== "number") return;
    const now = Date.now();
    if (now - lastMoveAt.current < 16) return;
    lastMoveAt.current = now;
    const deltaRpx = (x - gesture.current.startX) * 750 / screenWidth;
    // The sprite follows the finger but slows as the pull grows.
    setDragRpx(Math.sign(deltaRpx) * 160 * (1 - Math.exp(-Math.abs(deltaRpx) / 160)));
  }

  function handleTouchEnd(event: any) {
    const touch = event.changedTouches?.[0];
    const active = gesture.current;
    gesture.current = undefined;
    setDragging(false);
    setDragRpx(0);
    if (!touch || !active) return;
    const delta = touch.clientX - active.startX;
    const elapsed = Math.max(1, Date.now() - active.startedAt);
    if (Math.abs(delta) > 34 || (Math.abs(delta) > 14 && Math.abs(delta) / elapsed > .45)) {
      lastSwipeAt.current = Date.now();
      moveSelection(delta < 0 ? 1 : -1);
    }
  }

  function selectChoice(index: number) {
    if (Date.now() - lastSwipeAt.current < 350) return;
    setHasChosenAvatar(true);
    setSelectedIndex(index);
  }

  function handleArrowClick(direction: number) {
    if (Date.now() - lastSwipeAt.current < 350) return;
    moveSelection(direction);
  }

  const visibleChoices = [-2, -1, 0, 1, 2].map((offset) => {
    const index = (selectedIndex + offset + choices.length) % choices.length;
    return { choice: choices[index], index, offset };
  });
  const visibleHeight = Math.max(1, viewportHeight - navigationHeight - keyboardHeight);
  return <View className={`first-mate-setup${keyboardHeight > 0 ? " keyboard-open" : ""}`} style={keyboardHeight > 0 ? { height: `${visibleHeight}px` } : undefined}>
    <View className="first-mate-card">
      <View className="first-mate-brand"><Text>{t("brand.title")}</Text><View className="first-mate-brand-dot" /></View>
      <Text className="first-mate-title">{t("home.firstMateTitle")}</Text>

      {busy ? <View key="provisioning" className="first-mate-provisioning">
        <View className="first-mate-provisioning-avatar"><Image mode="aspectFit" webp src={selected.previewUrl} /></View>
        <Text className="first-mate-provisioning-title">{t(`home.firstMateStep.${progressStep}`)}</Text>
        <View className="first-mate-provisioning-steps">{(["create", "configure", "publish", "open"] as const).map((step, index) => {
          const activeIndex = (["create", "configure", "publish", "open"] as const).indexOf(progressStep);
          return <View key={step} className={`first-mate-provisioning-step${index < activeIndex ? " done" : index === activeIndex ? " active" : ""}`}><Text className="first-mate-provisioning-number">{index < activeIndex ? "✓" : index + 1}</Text><Text>{t(`home.firstMateStepLabel.${step}`)}</Text></View>;
        })}</View>
      </View> : <View key="avatar-selection" className="first-mate-carousel" onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} onTouchCancel={() => { gesture.current = undefined; setDragging(false); setDragRpx(0); }}>
        <Text className="first-mate-carousel-arrow" onClick={() => handleArrowClick(-1)}>‹</Text>
        <View className={`first-mate-track${dragging ? " dragging" : ""}`}>
          {visibleChoices.map(({ choice, index, offset }) => {
            const centered = offset === 0;
            const animatedUrl = centered ? animatedMateAvatarUrl(choice.savedUrl) : "";
            return <View key={choice.id} className={`first-mate-choice${centered ? " selected" : ""}${Math.abs(offset) > 1 ? " far" : ""}`} style={{
              transform: `translate3d(${offset * 150 + dragRpx}rpx, 0, 0) scale(${centered ? 1 : .76})`,
              opacity: Math.abs(offset) <= 1 ? centered ? 1 : .72 : 0,
              zIndex: 3 - Math.abs(offset)
            }} onClick={() => selectChoice(index)}>
              <Image className="first-mate-choice-image" mode="aspectFit" webp src={choice.savedUrl} style={{ opacity: animatedUrl && animatedReadyId === choice.id ? 0 : 1 }} />
              {animatedUrl && <Image className="first-mate-choice-image animated" mode="aspectFit" webp src={animatedUrl} style={{ opacity: animatedReadyId === choice.id ? 1 : 0 }} onLoad={() => setAnimatedReadyId(choice.id)} />}
            </View>;
          })}
        </View>
        <Text className="first-mate-carousel-arrow" onClick={() => handleArrowClick(1)}>›</Text>
      </View>}
      {!busy && <Text className="first-mate-count">{hasChosenAvatar ? `${String(selectedIndex + 1).padStart(2, "0")} / ${choices.length}` : t("home.firstMateChoose")}</Text>}

      {hasChosenAvatar && !busy && <>
        <Input className="first-mate-name" adjustPosition={false} cursorSpacing={18} maxlength={30} value={displayName} onInput={(event) => setDisplayName(event.detail.value)} placeholder={t("home.firstMateName")} placeholderClass="first-mate-name-placeholder" />
        {error && <Text className="first-mate-error">{error}</Text>}
        <View className={`first-mate-create ${busy || !displayName.trim() ? "disabled" : ""}`} onClick={() => { if (!busy && displayName.trim()) { void Taro.hideKeyboard(); onCreate(displayName.trim(), selected.savedUrl); } }}>
          <Text>{busy ? t("home.firstMateBusy") : t("home.firstMateStart")}</Text>
          {!busy && <Text className="first-mate-arrow">›</Text>}
        </View>
      </>}
    </View>
  </View>;
}
