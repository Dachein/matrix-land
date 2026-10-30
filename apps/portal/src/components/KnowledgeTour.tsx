import { useI18n } from "../../../../src/portal/i18n";
import { ProductTour, type ProductTourScene } from "./ProductTour";

export function KnowledgeTour({ onClose }: { onClose: () => void }) {
  const { locale, t } = useI18n();
  const sceneKeys = [
    {
      eyebrow: "portal.home.knowledgeTour.scene1.eyebrow",
      imageAlt: "portal.home.knowledgeTour.scene1.imageAlt",
      imageSrc: "/tours/knowledge/scene-01.webp",
      narration: "portal.home.knowledgeTour.scene1.narration",
      summary: "portal.home.knowledgeTour.scene1.summary",
      title: "portal.home.knowledgeTour.scene1.title"
    },
    {
      eyebrow: "portal.home.knowledgeTour.scene2.eyebrow",
      imageAlt: "portal.home.knowledgeTour.scene2.imageAlt",
      imageSrc: "/tours/knowledge/scene-02.webp",
      narration: "portal.home.knowledgeTour.scene2.narration",
      summary: "portal.home.knowledgeTour.scene2.summary",
      title: "portal.home.knowledgeTour.scene2.title"
    },
    {
      eyebrow: "portal.home.knowledgeTour.scene3.eyebrow",
      imageAlt: "portal.home.knowledgeTour.scene3.imageAlt",
      imageSrc: "/tours/knowledge/scene-03.webp",
      narration: "portal.home.knowledgeTour.scene3.narration",
      summary: "portal.home.knowledgeTour.scene3.summary",
      title: "portal.home.knowledgeTour.scene3.title"
    },
  ] as const;
  const scenes: ProductTourScene[] = sceneKeys.map((scene) => ({
    eyebrow: t(scene.eyebrow),
    imageAlt: t(scene.imageAlt),
    imageSrc: scene.imageSrc,
    narration: t(scene.narration),
    summary: t(scene.summary),
    title: t(scene.title)
  }));

  return (
    <ProductTour
      kicker={t("portal.home.knowledgeTour.kicker")}
      labels={{
        close: t("portal.home.knowledgeTour.close"),
        finish: t("portal.home.knowledgeTour.finish"),
        next: t("portal.home.knowledgeTour.next"),
        pauseNarration: t("portal.home.knowledgeTour.pauseNarration"),
        playNarration: t("portal.home.knowledgeTour.playNarration"),
        previous: t("portal.home.knowledgeTour.previous"),
        progress: (current, total) => t("portal.home.knowledgeTour.progress", { current, total })
      }}
      locale={locale}
      onClose={onClose}
      scenes={scenes}
      title={t("portal.home.knowledgeTour.title")}
    />
  );
}
