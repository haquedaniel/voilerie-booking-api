export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/quote") {
      return Response.json({
        ok: true,
        message: "Quote endpoint working",
        property_id: url.searchParams.get("property_id"),
        check_in: url.searchParams.get("check_in"),
        check_out: url.searchParams.get("check_out"),
        guests: url.searchParams.get("guests"),
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
