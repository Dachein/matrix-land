import { knowledgeFetch } from "../../../../../src/portal/knowledge/utils";
import type { AdminKnowledgeServiceData } from "./types";

export async function loadAdminKnowledgeServices(signal?: AbortSignal) {
  const data = await knowledgeFetch<AdminKnowledgeServiceData>("/api/admin/knowledge-services", { signal });
  // Keep older Worker responses from exposing private entries during deployment.
  const services = data.services.filter((service) => service.permissionType === "company" || service.permissionType === "targeted");
  return {
    services,
    summary: {
      serviceCount: services.length,
      companyVisibleCount: services.filter((service) => service.permissionType === "company").length,
      fileCount: services.reduce((total, service) => total + service.fileCount, 0),
      requestCount: services.reduce((total, service) => total + service.requestCount, 0)
    }
  };
}
