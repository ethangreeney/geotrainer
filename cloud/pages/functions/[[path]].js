/**
 * The Pages project exists only to give the site a memorable hostname.
 * Every request is handed to the geocoach Worker over a service binding,
 * so the Worker sees the pages.dev origin and mints install links on it.
 */
export async function onRequest({ request, env }) {
  return env.API.fetch(request)
}
