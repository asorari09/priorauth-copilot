import { NextRequest } from "next/server";

import { supabaseAdmin } from "@/lib/supabase";

function checkDemoKey(request: NextRequest): boolean {
  const expectedKey = process.env.DEMO_KEY;
  const providedKey = request.headers.get("x-demo-key");
  return Boolean(expectedKey && providedKey && providedKey === expectedKey);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!checkDemoKey(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const { id } = await context.params;
  const result = await supabaseAdmin
    .from("cases")
    .select("*")
    .eq("id", id)
    .single();

  if (result.error) {
    const status = result.error.code === "PGRST116" ? 404 : 500;
    return new Response(
      JSON.stringify({ error: status === 404 ? "Not found" : "Failed to fetch case" }),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    );
  }

  return new Response(JSON.stringify(result.data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
