/**
 * Owys edge proxy.
 *
 * Cloud Run hands out a URL with the project number baked into it. This sits in
 * front and serves the app from a clean hostname, forwarding everything —
 * method, headers, body, and streaming responses — through untouched.
 *
 * Streaming matters: the dashboard holds a server-sent-events connection open
 * for live updates, so the response body is passed through as a stream rather
 * than buffered.
 */

const ORIGIN = "owys-527896532687.us-central1.run.app";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.protocol = "https:";
    url.hostname = ORIGIN;
    url.port = "";

    // Cloud Run routes on Host; leaving the edge hostname here 404s.
    const headers = new Headers(request.headers);
    headers.set("Host", ORIGIN);

    const upstream = await fetch(
      new Request(url.toString(), {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      }),
    );

    // Returning the body as-is keeps SSE flowing instead of buffering it.
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  },
};
