import { json } from "../http.ts";
import type { ApiRouteHandler } from "../routeTypes.ts";

export const dispatchForumRoutes: ApiRouteHandler = async (context, services, path) => {
  if (context.request.method === "GET" && path === "forum/link-preview") {
    return json(await services.forumApi.previewForumLink(context));
  }

  if (context.request.method === "GET" && path === "forum/topics") {
    return json(await services.forumApi.listForumTopics(context), {
      headers: { "Cache-Control": "private, no-store" }
    });
  }

  if (context.request.method === "POST" && path === "forum/media") {
    return json(await services.forumApi.uploadForumMedia(context), { status: 201 });
  }

  const mediaMatch = path.match(/^forum\/media\/(.+)$/);
  if (context.request.method === "GET" && mediaMatch?.[1]) {
    return await services.forumApi.getForumMedia(context, mediaMatch[1]);
  }
  if (context.request.method === "DELETE" && mediaMatch?.[1]) {
    return json(await services.forumApi.deleteForumMediaDraft(context, mediaMatch[1]));
  }

  if (context.request.method === "POST" && path === "forum/topics") {
    const created = await services.forumApi.createForumTopic(context);
    return json(created, {
      status: 201,
      headers: {
        Location: `/api/forum/topics/${encodeURIComponent(created.id)}`
      }
    });
  }

  const topicMatch = path.match(/^forum\/topics\/([^/]+)$/);
  if (context.request.method === "GET" && topicMatch?.[1]) {
    return json(await services.forumApi.getForumTopic(context, topicMatch[1]), {
      headers: { "Cache-Control": "private, no-store" }
    });
  }

  if (context.request.method === "PATCH" && topicMatch?.[1]) {
    return json(await services.forumApi.updateForumTopic(context, topicMatch[1]));
  }

  if (context.request.method === "DELETE" && topicMatch?.[1]) {
    return json(await services.forumApi.deleteForumTopic(context, topicMatch[1]));
  }

  const topicViewMatch = path.match(/^forum\/topics\/([^/]+)\/view$/);
  if (context.request.method === "POST" && topicViewMatch?.[1]) {
    return json(await services.forumApi.recordForumTopicView(context, topicViewMatch[1]));
  }

  const topicPinMatch = path.match(/^forum\/topics\/([^/]+)\/pin$/);
  if ((context.request.method === "POST" || context.request.method === "DELETE") && topicPinMatch?.[1]) {
    return json(await services.forumApi.setForumTopicPinned(context, topicPinMatch[1], context.request.method === "POST"));
  }

  const topicContributorAwardMatch = path.match(/^forum\/topics\/([^/]+)\/contributor-award$/);
  if (context.request.method === "POST" && topicContributorAwardMatch?.[1]) {
    return json(await services.forumApi.awardForumTopicContributor(context, topicContributorAwardMatch[1]), { status: 201 });
  }

  const topicLikeMatch = path.match(/^forum\/topics\/([^/]+)\/like$/);
  if ((context.request.method === "POST" || context.request.method === "DELETE") && topicLikeMatch?.[1]) {
    return json(await services.forumApi.setForumTopicLike(context, topicLikeMatch[1], context.request.method === "POST"));
  }

  const replyMatch = path.match(/^forum\/topics\/([^/]+)\/replies$/);
  if (context.request.method === "POST" && replyMatch?.[1]) {
    return json(await services.forumApi.createForumReply(context, replyMatch[1]));
  }

  const replyLikeMatch = path.match(/^forum\/topics\/([^/]+)\/replies\/([^/]+)\/like$/);
  if ((context.request.method === "POST" || context.request.method === "DELETE") && replyLikeMatch?.[1] && replyLikeMatch?.[2]) {
    return json(await services.forumApi.setForumReplyLike(context, replyLikeMatch[1], replyLikeMatch[2], context.request.method === "POST"));
  }

  const replyPinMatch = path.match(/^forum\/topics\/([^/]+)\/replies\/([^/]+)\/pin$/);
  if ((context.request.method === "POST" || context.request.method === "DELETE") && replyPinMatch?.[1] && replyPinMatch?.[2]) {
    return json(await services.forumApi.setForumReplyPinned(context, replyPinMatch[1], replyPinMatch[2], context.request.method === "POST"));
  }

  const replyContributorAwardMatch = path.match(/^forum\/topics\/([^/]+)\/replies\/([^/]+)\/contributor-award$/);
  if (context.request.method === "POST" && replyContributorAwardMatch?.[1] && replyContributorAwardMatch?.[2]) {
    return json(await services.forumApi.awardForumReplyContributor(
      context,
      replyContributorAwardMatch[1],
      replyContributorAwardMatch[2]
    ), { status: 201 });
  }

  const replyDeleteMatch = path.match(/^forum\/topics\/([^/]+)\/replies\/([^/]+)$/);
  if (context.request.method === "PATCH" && replyDeleteMatch?.[1] && replyDeleteMatch?.[2]) {
    return json(await services.forumApi.updateForumReply(context, replyDeleteMatch[1], replyDeleteMatch[2]));
  }

  if (context.request.method === "DELETE" && replyDeleteMatch?.[1] && replyDeleteMatch?.[2]) {
    return json(await services.forumApi.deleteForumReply(context, replyDeleteMatch[1], replyDeleteMatch[2]));
  }

  return undefined;
};
