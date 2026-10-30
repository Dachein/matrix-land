import { json } from "../http.ts";
import type { AssetManageType } from "./normalizers.ts";
import type { ApiRouteHandler } from "../routeTypes.ts";

export const dispatchPublicationRoutes: ApiRouteHandler = async (context, services, path) => {
  if (context.request.method === "GET" && path === "publication/listings") {
    return json(await services.publicationListingsApi.listPublicationListings(context));
  }

  if (context.request.method === "GET" && path === "publication/hub-listings") {
    return json(await services.publicationListingsApi.listHubPublicationListings(context));
  }

  if (context.request.method === "POST" && path === "publication/interactions") {
    return json(await services.publicationListingsApi.recordPublicationInteraction(context), { status: 201 });
  }

  if (context.request.method === "POST" && path === "skills") {
    return json(await services.publicationSubmissionsApi.createSkillListing(context), { status: 201 });
  }

  if (context.request.method === "POST" && path === "market/submissions") {
    return json(await services.publicationSubmissionsApi.createPublicationSubmission(context), { status: 201 });
  }

  const assetStatusMatch = path.match(/^assets\/(app|skill|mcp)\/([^/]+)\/status$/);
  if (context.request.method === "PATCH" && assetStatusMatch?.[1] && assetStatusMatch[2]) {
    return json(await services.publicationAssetsApi.updateAssetLifecycleStatus(context, assetStatusMatch[1] as AssetManageType, decodeURIComponent(assetStatusMatch[2])));
  }

  const assetDeleteMatch = path.match(/^assets\/(app|skill|mcp)\/([^/]+)$/);
  if (context.request.method === "DELETE" && assetDeleteMatch?.[1] && assetDeleteMatch[2]) {
    return json(await services.publicationAssetsApi.deleteAsset(context, assetDeleteMatch[1] as AssetManageType, decodeURIComponent(assetDeleteMatch[2])));
  }

  const listingInstallMatch = path.match(/^listings\/([^/]+)\/install$/);
  if (context.request.method === "POST" && listingInstallMatch?.[1]) {
    return json(await services.publicationListingsApi.installPublicationListing(context, listingInstallMatch[1]));
  }

  const listingDownloadMatch = path.match(/^listings\/([^/]+)\/download$/);
  if (context.request.method === "GET" && listingDownloadMatch?.[1]) {
    return await services.publicationListingsApi.downloadPublicationListing(context, decodeURIComponent(listingDownloadMatch[1]));
  }

  const listingDeleteMatch = path.match(/^listings\/([^/]+)$/);
  if (context.request.method === "DELETE" && listingDeleteMatch?.[1]) {
    return json(await services.publicationListingsApi.deletePublicationListing(context, decodeURIComponent(listingDeleteMatch[1])));
  }

  const homeDisplayMatch = path.match(/^listings\/([^/]+)\/home-display$/);
  if (context.request.method === "PATCH" && homeDisplayMatch?.[1]) {
    return json(await services.publicationListingsApi.updateHomeApplicationDisplay(context, decodeURIComponent(homeDisplayMatch[1])));
  }

  const listingStatusMatch = path.match(/^listings\/([^/]+)\/status$/);
  if (context.request.method === "PATCH" && listingStatusMatch?.[1]) {
    return json(await services.publicationListingsApi.updatePublicationListingStatus(context, decodeURIComponent(listingStatusMatch[1])));
  }

  const listingPublicationRetryMatch = path.match(/^listings\/([^/]+)\/publication\/retry$/);
  if (context.request.method === "POST" && listingPublicationRetryMatch?.[1]) {
    return json(await services.publicationListingsApi.retryPublicationListingPublication(
      context,
      decodeURIComponent(listingPublicationRetryMatch[1])
    ));
  }

  return undefined;
};
