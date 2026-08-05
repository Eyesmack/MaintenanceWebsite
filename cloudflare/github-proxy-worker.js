// Cloudflare Worker: authenticated read-only proxy for the status page's
// GitHub API calls. status.js can't hold a GitHub token itself (anything
// shipped to the browser is public), so this Worker holds it as an
// encrypted secret (GITHUB_TOKEN) instead and adds the Authorization header
// server-side. It only forwards the exact two endpoints the page needs, for
// this one repo, GET only — anything else is rejected so the token can't be
// used as an open relay for arbitrary GitHub API calls.

const ALLOWED_ORIGIN = 'https://status.isaacmason.co.nz';

const ALLOWED_PATHS = [
  /^\/repos\/Eyesmack\/MaintenanceWebsite\/issues$/,
  /^\/repos\/Eyesmack\/MaintenanceWebsite\/issues\/\d+\/comments$/,
];

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    if (!ALLOWED_PATHS.some((pattern) => pattern.test(url.pathname))) {
      return new Response('Forbidden', { status: 403 });
    }

    const upstream = await fetch(`https://api.github.com${url.pathname}${url.search}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'status-page-proxy',
      },
    });

    const response = new Response(upstream.body, upstream);
    response.headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    response.headers.set('Access-Control-Allow-Methods', 'GET');
    return response;
  },
};
