import { ArrowRight, Check } from "lucide-react";
import { useState, type CSSProperties, type FocusEvent, type PointerEvent } from "react";
import { MATE_PET_OPTIONS, matePetMotionUrl, type MatePetId, type MatePetMotion } from "../../../../src/shared/matePet";
import "../styles/mate-intro.css";

const motions: MatePetMotion[] = ["waving", "running", "jumping", "waiting", "running-right", "idle", "review", "running-left", "failed", "waving"];
const anchors = [
  { x: 3, y: 7, size: 72 }, { x: 25, y: 1, size: 104 }, { x: 51, y: 10, size: 78 }, { x: 79, y: 5, size: 94 },
  { x: 12, y: 35, size: 112 }, { x: 41, y: 32, size: 82 }, { x: 70, y: 39, size: 122 },
  { x: 1, y: 72, size: 88 }, { x: 32, y: 72, size: 70 }, { x: 61, y: 70, size: 98 }
];
const mobileAnchors = [
  { x: 1, y: 2 }, { x: 27, y: 0 }, { x: 57, y: 4 }, { x: 81, y: 7 },
  { x: 8, y: 36 }, { x: 37, y: 33 }, { x: 69, y: 39 },
  { x: 0, y: 72 }, { x: 31, y: 75 }, { x: 69, y: 71 }
];

export function MateIntro({ zh, selectedAvatar, onSelect, onNext, onWeixinCreate }: {
  zh: boolean;
  selectedAvatar: string;
  onSelect: (avatarUrl: string) => void;
  onNext: () => void;
  onWeixinCreate: () => void;
}) {
  const [focusedId, setFocusedId] = useState<MatePetId | null>(null);
  const [motionSettings] = useState(() => MATE_PET_OPTIONS.map(() => ({
    duration: 4.2 + Math.random() * 3.8,
    delay: -(Math.random() * 5),
    dx: 6 + Math.random() * 14,
    dy: 4 + Math.random() * 11
  })));
  const selectedPath = selectedAvatar ? new URL(selectedAvatar, window.location.origin).pathname : "";
  const selectedPet = MATE_PET_OPTIONS.find((pet) => selectedPath === new URL(pet.avatarUrl).pathname);
  const focused = focusedId !== null;
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedId(null);
  };
  const select = (avatarUrl: string) => {
    onSelect(new URL(avatarUrl, window.location.origin).toString());
    setFocusedId(null);
  };
  return <section className="mate-intro" aria-labelledby="mate-intro-title" lang={zh ? "zh-CN" : "en"}>
    <div className="mate-intro-overline"><span className="mate-intro-signal" />Frontier Workspace<span className="mate-intro-edition">PERSONAL AGENT / 01</span></div>
    <div className="mate-intro-main">
      <div className="mate-intro-copy">
        <h1 id="mate-intro-title">Workspace<span>Mate<span className="mate-intro-period">.</span></span></h1>
        <h2>{zh ? <>开启你的<span>专属数字助理。</span></> : <>Start your<span>personal agent.</span></>}</h2>
        <p>{zh ? "连接你的知识与应用，让想法走向行动。" : "Connect your knowledge and apps. Put your ideas to work."}</p>
        <div className="mate-intro-selection-status" aria-live="polite">
          {selectedPet
            ? <><Check className="mate-intro-selection-check" size={17} /><img alt="" className="mate-intro-selection-avatar" draggable={false} src={new URL(matePetMotionUrl(selectedPet.id, "idle"), window.location.origin).toString()} /><span>{zh ? `已选择：${selectedPet.nameZh}` : `Selected: ${selectedPet.nameEn}`}</span></>
            : <span>{zh ? "选择一个形象" : "Choose a character"}</span>}
        </div>
        <button className="mate-intro-next" disabled={!selectedAvatar} onClick={onNext} type="button">
          {zh ? "下一步" : "Next"}<ArrowRight size={19} />
        </button>
        <button className="mate-intro-weixin-link" onClick={onWeixinCreate} type="button">
          {zh ? "通过微信登录并创建" : "Sign in and create in WeChat"}
        </button>
      </div>
      <div className={`mate-intro-characters${focused ? " is-spotlighting" : ""}`} onBlur={handleBlur}>
        <div className="mate-intro-character-orbit" aria-label={zh ? "选择 Mate 形象" : "Choose a Mate character"} role="group">
          {MATE_PET_OPTIONS.map((pet, index) => {
            const anchor = anchors[index];
            const mobileAnchor = mobileAnchors[index];
            const motionSetting = motionSettings[index];
            const isSelected = selectedPath === new URL(pet.avatarUrl).pathname;
            const motion = motions[index];
            const style = {
              "--mate-x": `${anchor.x}%`,
              "--mate-y": `${anchor.y}%`,
              "--mate-size": `${anchor.size}px`,
              "--mate-x-mobile": `${mobileAnchor.x}%`,
              "--mate-y-mobile": `${mobileAnchor.y}%`,
              "--mate-duration": `${motionSetting.duration}s`,
              "--mate-delay": `${motionSetting.delay}s`,
              "--mate-drift-x": `${motionSetting.dx}px`,
              "--mate-drift-y": `${motionSetting.dy}px`,
              "--mate-phase": `${index % 2 === 0 ? -1 : 1}`
            } as CSSProperties;
            const name = zh ? pet.nameZh : pet.nameEn;
            return <button
              aria-label={name}
              aria-pressed={isSelected}
              className={`mate-intro-pet${isSelected ? " is-selected" : ""}`}
              key={pet.id}
              onClick={() => select(new URL(pet.avatarUrl).pathname)}
              onFocus={() => setFocusedId(pet.id)}
              onMouseEnter={() => setFocusedId(pet.id)}
              onMouseLeave={() => setFocusedId(null)}
              onPointerDown={(event: PointerEvent<HTMLButtonElement>) => { if (event.pointerType !== "mouse") select(new URL(pet.avatarUrl).pathname); }}
              onTouchStart={() => setFocusedId(pet.id)}
              style={style}
              type="button"
            >
              <span className="mate-intro-pet-spotlight" />
              <img alt="" draggable={false} src={new URL(matePetMotionUrl(pet.id, motion)).pathname} />
              <span className="mate-intro-pet-name">{name}</span>
            </button>;
          })}
        </div>
      </div>
    </div>
  </section>;
}
