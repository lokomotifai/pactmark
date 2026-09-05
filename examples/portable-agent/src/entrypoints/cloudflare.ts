import { runPortableAgent } from "../agent.js";
/** A Cloudflare Worker-compatible fetch export; bindings are deliberately unused. */
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ code: "KAF_HTTP_METHOD_INVALID" }, { status: 405 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ code: "KAF_EXAMPLE_INPUT_INVALID" }, { status: 400 });
    }
    const result = await runPortableAgent(body);
    return Response.json(result, { status: result.ok ? 200 : 400 });
  },
};
