import { PageHeading } from "../../../../src/portal/components/PageHeading";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../../../src/portal/i18n";
import type { PortalCatalog } from "../../../../src/shared/types";
import { MiniappLoginModal } from "../components/MiniappLoginModal";
import { PortalKnowledgeWorkspace } from "../components/knowledge/PortalKnowledgeWorkspace";
import type { PortalKnowledgeSection } from "../routing/portalRoutes";
import "../styles/knowledge.css";

export function PortalKnowledge({
  catalog,
  onSectionChange,
  section
}: {
  catalog: PortalCatalog;
  onSectionChange: (section: PortalKnowledgeSection) => void;
  section: PortalKnowledgeSection;
}) {
  const { locale } = useI18n();
  const [miniappLoginOpen, setMiniappLoginOpen] = useState(false);

  return (
    <div className="portal-workspace-inner portal-knowledge-workspace">
      <section className="portal-page portal-knowledge-page" aria-labelledby="portal-knowledge-title">
        <PortalKnowledgeIntro onOpenMiniappLogin={() => setMiniappLoginOpen(true)} />

        <PortalKnowledgeWorkspace
          catalog={catalog}
          onSectionChange={onSectionChange}
          section={section}
        />
      </section>
      <MiniappLoginModal onClose={() => setMiniappLoginOpen(false)} open={miniappLoginOpen} zh={locale !== "en"} />
    </div>
  );
}

function PortalKnowledgeIntro({ onOpenMiniappLogin }: { onOpenMiniappLogin: () => void }) {
  const { t } = useI18n();

  return (
    <>
      <PageHeading
          id="portal-knowledge-title"
          className="portal-editorial-heading portal-knowledge-heading"
          title={t("portal.knowledge.title")}
          eyebrow={<><div className="portal-editorial-kicker">
            <span aria-hidden="true" className="portal-editorial-mark"><i /></span>
            <span>{t("portal.knowledge.kicker")}</span>
          </div></>}
        ><blockquote className="portal-editorial-quote">
            <p>{t("portal.knowledge.editorialQuote")}</p>
            <cite>{t("portal.knowledge.editorialSource")}</cite>
          </blockquote></PageHeading>

      <button className="portal-knowledge-mate-banner" onClick={onOpenMiniappLogin} type="button">
        <span aria-hidden="true" className="portal-knowledge-mate-icon">
          <svg fill="none" viewBox="0 0 48 48">
            <path d="M24 4C13.2 4 4.5 10.8 4.5 19.2c0 4.2 2.5 8 6.5 10.5l-1.5 6.1 7.2-3.5c2.2.7 4.6 1 7.3 1 10.8 0 19.5-6.8 19.5-15.2S34.8 4 24 4Z" fill="var(--fw-color-wechat)" />
            <circle cx="17.5" cy="18.5" r="2" fill="var(--fw-color-white)" />
            <circle cx="28.5" cy="18.5" r="2" fill="var(--fw-color-white)" />
            <path d="M34.6 27.2c-5.3 0-9.6 3.3-9.6 7.4s4.3 7.4 9.6 7.4c1.3 0 2.5-.2 3.6-.6l4.1 2-1-4.2c1.8-1.3 2.9-3.1 2.9-5.1 0-3.8-4.3-6.9-9.6-6.9Z" fill="var(--fw-color-wechat-secondary)" />
            <circle cx="32" cy="34.5" r="1.4" fill="var(--fw-color-white)" />
            <circle cx="38" cy="34.5" r="1.4" fill="var(--fw-color-white)" />
          </svg>
        </span>
        <span className="portal-knowledge-mate-copy">
          <strong>{t("portal.knowledge.mateBannerTitle")}</strong>
          <span>{t("portal.knowledge.mateBannerDescription")}</span>
        </span>
        <span className="portal-knowledge-mate-action">
          {t("portal.knowledge.mateBannerAction")}
          <ArrowUpRight aria-hidden="true" size={17} />
        </span>
      </button>
    </>
  );
}
