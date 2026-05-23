async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const claimSet = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  if (!env.GOOGLE_PRIVATE_KEY) {
    throw new Error("Missing GOOGLE_PRIVATE_KEY secret");
  }

  const privateKey = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");

  const encoder = new TextEncoder();

  function base64url(obj) {
    const json = JSON.stringify(obj);
    const bytes = encoder.encode(json);
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  const unsignedToken = `${base64url(header)}.${base64url(claimSet)}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(unsignedToken)
  );

  const signedJwt =
    unsignedToken + "." + arrayBufferToBase64Url(signature);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedJwt,
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = await response.json();
  return data.access_token;
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

function arrayBufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function readSheet(env, tabName) {
  const token = await getAccessToken(env);

  const range = encodeURIComponent(`${tabName}!A:Z`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${range}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = await response.json();
  const rows = data.values || [];

  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => String(h).trim());

  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((header, i) => {
      obj[header] = row[i] ?? "";
    });
    return obj;
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/quote") {
      try {
        const reservations = await readSheet(env, "Reservations");
        const pricingRules = await readSheet(env, "Pricing Rules");
        const settings = await readSheet(env, "Widget Settings");

        return Response.json({
          ok: true,
          message: "Google Sheets connected",
          property_id: url.searchParams.get("property_id"),
          check_in: url.searchParams.get("check_in"),
          check_out: url.searchParams.get("check_out"),
          guests: url.searchParams.get("guests"),
          rows: {
            reservations: reservations.length,
            pricing_rules: pricingRules.length,
            widget_settings: settings.length,
          },
        });
      } catch (err) {
        return Response.json(
          {
            ok: false,
            error: String(err.message || err),
          },
          { status: 500 }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
};