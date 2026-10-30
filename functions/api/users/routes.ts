import { json } from "../http.ts";
import type { ApiRouteHandler } from "../routeTypes.ts";

export const dispatchUsersRoutes: ApiRouteHandler = async (context, services, path) => {
  if (context.request.method === "GET" && path === "users/directory") {
    return json({ users: await services.userDirectoryApi.listUserDirectory(context) });
  }

  if (context.request.method === "GET" && path === "users/departments") {
    return json({ departments: await services.usersApi.listUserDepartments(context) });
  }

  if (context.request.method === "GET" && path === "admin/users") {
    return json({ users: await services.adminUsersApi.listAdminUsers(context) });
  }

  const adminUserRoleMatch = path.match(/^admin\/users\/([^/]+)\/roles?$/);
  if (context.request.method === "PATCH" && adminUserRoleMatch?.[1]) {
    return json({ user: await services.usersApi.updateAdminUserRole(context, decodeURIComponent(adminUserRoleMatch[1])) });
  }

  if (context.request.method === "GET" && path === "users/batch") {
    return json({ users: await services.usersApi.readUserBatch(context) });
  }

  const userAvatarMatch = path.match(/^users\/([^/]+)\/avatar$/);
  if (context.request.method === "GET" && userAvatarMatch?.[1]) {
    return services.usersApi.readUserAvatar(context, decodeURIComponent(userAvatarMatch[1]));
  }

  const userProfileMatch = path.match(/^users\/([^/]+)\/profile$/);
  if (context.request.method === "GET" && userProfileMatch?.[1]) {
    return json({ user: await services.usersApi.readUserProfile(context, decodeURIComponent(userProfileMatch[1])) });
  }

  if (context.request.method === "PATCH" && userProfileMatch?.[1]) {
    return json({ user: await services.usersApi.updateUserProfile(context, decodeURIComponent(userProfileMatch[1])) });
  }

  return undefined;
};
