import useEmblaCarousel from "embla-carousel-react";
import {
  ArrowLeft,
  ArrowRight,
  Pause,
  Play,
  Volume2,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState
} from "react";
import "../styles/product-tour.css";

export type ProductTourScene = {
  eyebrow: string;
  imageAlt: string;
  imageSrc: string;
  narration: string;
  summary: string;
  title: string;
};

type ProductTourLabels = {
  close: string;
  finish: string;
  next: string;
  pauseNarration: string;
  playNarration: string;
  previous: string;
  progress: (current: number, total: number) => string;
};

type ProductTourProps = {
  kicker: string;
  labels: ProductTourLabels;
  locale: string;
  onClose: () => void;
  scenes: ProductTourScene[];
  title: string;
};

const focusableSelector = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function ProductTour({ kicker, labels, locale, onClose, scenes, title }: ProductTourProps) {
  const [viewportRef, emblaApi] = useEmblaCarousel({ align: "start", loop: false, skipSnaps: false });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isNarrating, setIsNarrating] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const scene = scenes[selectedIndex];
  const isFirst = selectedIndex === 0;
  const isLast = selectedIndex === scenes.length - 1;

  const stopNarration = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setIsNarrating(false);
  }, []);

  const closeTour = useCallback(() => {
    stopNarration();
    onClose();
  }, [onClose, stopNarration]);

  useEffect(() => {
    if (!emblaApi) return;

    const updateSelected = () => {
      setSelectedIndex(emblaApi.selectedScrollSnap());
      stopNarration();
    };

    updateSelected();
    emblaApi.on("select", updateSelected);
    emblaApi.on("reInit", updateSelected);

    return () => {
      emblaApi.off("select", updateSelected);
      emblaApi.off("reInit", updateSelected);
    };
  }, [emblaApi, stopNarration]);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => closeRef.current?.focus());

    return () => {
      document.body.style.overflow = previousOverflow;
      stopNarration();
      returnFocusRef.current?.focus();
    };
  }, [stopNarration]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeTour();
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        emblaApi?.scrollPrev();
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        emblaApi?.scrollNext();
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeTour, emblaApi]);

  function toggleNarration() {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;

    if (isNarrating) {
      stopNarration();
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(scene.narration);
    utterance.lang = locale.startsWith("zh") ? "zh-CN" : "en-US";
    utterance.rate = 0.96;
    utterance.onend = () => setIsNarrating(false);
    utterance.onerror = () => setIsNarrating(false);
    setIsNarrating(true);
    window.speechSynthesis.speak(utterance);
  }

  function goForward() {
    if (isLast) {
      closeTour();
      return;
    }
    emblaApi?.scrollNext();
  }

  return (
    <div className="product-tour-backdrop">
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="product-tour"
        ref={dialogRef}
        role="dialog"
      >
        <header className="product-tour-header">
          <div className="product-tour-heading">
            <small>{kicker}</small>
            <h2 id={titleId}>{title}</h2>
          </div>
          <div className="product-tour-header-actions">
            <span aria-live="polite" className="product-tour-progress-copy">
              {labels.progress(selectedIndex + 1, scenes.length)}
            </span>
            <button
              aria-label={labels.close}
              className="product-tour-icon-button"
              onClick={closeTour}
              ref={closeRef}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="product-tour-body">
          <div className="product-tour-viewport" ref={viewportRef}>
            <div className="product-tour-container">
              {scenes.map((item, index) => (
                <article
                  aria-hidden={index !== selectedIndex}
                  className="product-tour-slide"
                  key={item.title}
                >
                  <img alt={item.imageAlt} draggable="false" src={item.imageSrc} />
                </article>
              ))}
            </div>
          </div>

          <aside className="product-tour-story" aria-live="polite">
            <div>
              <small>{scene.eyebrow}</small>
              <h3>{scene.title}</h3>
              <p className="product-tour-summary">{scene.summary}</p>
            </div>
            <div className="product-tour-narration">
              <Volume2 aria-hidden="true" />
              <p>{scene.narration}</p>
            </div>
            <button className="product-tour-narration-button" onClick={toggleNarration} type="button">
              {isNarrating ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              {isNarrating ? labels.pauseNarration : labels.playNarration}
            </button>
          </aside>
        </div>

        <footer className="product-tour-footer">
          <nav aria-label={labels.progress(selectedIndex + 1, scenes.length)} className="product-tour-scene-nav">
            {scenes.map((item, index) => (
              <button
                aria-current={index === selectedIndex ? "step" : undefined}
                className={index === selectedIndex ? "active" : ""}
                key={item.title}
                onClick={() => emblaApi?.scrollTo(index)}
                type="button"
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{item.title}</strong>
              </button>
            ))}
          </nav>
          <div className="product-tour-paging">
            <button disabled={isFirst} onClick={() => emblaApi?.scrollPrev()} type="button">
              <ArrowLeft aria-hidden="true" />
              {labels.previous}
            </button>
            <button className="primary" onClick={goForward} type="button">
              {isLast ? labels.finish : labels.next}
              <ArrowRight aria-hidden="true" />
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
