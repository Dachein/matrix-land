import { redirect } from "../http.ts";

export function redirectToAuthPath(request: Request, pathname: string) {
  const source = new URL(request.url);
  const target = new URL(pathname, source.origin);
  target.search = source.search;
  return redirect(target.toString());
}
