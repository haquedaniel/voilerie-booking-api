function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function parseDate(value) {
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseSheetDate(value) {
  if (!value) return null;

  const text = String(value).trim();

  // ISO / Google serialised date: 2026-05-23
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return parseDate(text);
  }

  // French / European date: 23/05/2026
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const [, dd, mm, yyyy] = match;
    return parseDate(`${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`);
  }

  // Last resort
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function nightsBetween(checkIn, checkOut) {
  return Math.round((checkOut - checkIn) / (1000 * 60 * 60 * 24));
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function toNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const cleaned = String(value).replace(",", ".").replace(/[^\d.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : fallback;
}

function settingsToObject(rows) {
  const out = {};
  for (const row of rows) {
    if (row.key) out[row.key] = row.value;
  }
  return out;
}

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
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
    const jsonText = JSON.stringify(obj);
    const bytes = encoder.encode(jsonText);
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  const unsignedToken = `${base64url(header)}.${base64url(claimSet)}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(unsignedToken)
  );

  const signedJwt = `${unsignedToken}.${arrayBufferToBase64Url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedJwt,
    }),
  });

  if (!response.ok) throw new Error(await response.text());

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
  for (const byte of bytes) binary += String.fromCharCode(byte);

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
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) throw new Error(await response.text());

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

function findBlockingReservation(reservations, propertyId, checkIn, checkOut) {
  return reservations.find((r) => {
    const listing = String(r.Listing || r.listing || "").trim();
    if (listing !== propertyId) return false;

    const resCheckIn = parseSheetDate(
      r["Check in Date"] || r["Check-in Date"] || r.checkin_date
    );    
    const nights = toNumber(r["Number of Nights"] || r.nights, 0);
    if (!resCheckIn || !nights) return false;

    const resCheckOut = new Date(resCheckIn);
    resCheckOut.setUTCDate(resCheckOut.getUTCDate() + nights);

    return overlaps(checkIn, checkOut, resCheckIn, resCheckOut);
  });
}

function findPricingRule(pricingRules, propertyId, checkIn) {
  return pricingRules.find((r) => {
    const listing = String(r.property_id || r.listing || r.Listing || "").trim();
    if (listing !== propertyId) return false;

    const start = parseDate(r.start_date);
    const end = parseDate(r.end_date);
    if (!start || !end) return false;

    return checkIn >= start && checkIn <= end;
  });
}

async function handleQuote(request, env) {
  const url = new URL(request.url);

  const propertyId = url.searchParams.get("property_id");
  const checkInRaw = url.searchParams.get("check_in");
  const checkOutRaw = url.searchParams.get("check_out");
  const guests = toNumber(url.searchParams.get("guests"), 1);

  if (!propertyId || !checkInRaw || !checkOutRaw) {
    return json(
      {
        ok: false,
        error: "Missing property_id, check_in or check_out",
      },
      400
    );
  }

  const checkIn = parseDate(checkInRaw);
  const checkOut = parseDate(checkOutRaw);

  if (!checkIn || !checkOut || checkOut <= checkIn) {
    return json({ ok: false, error: "Invalid dates" }, 400);
  }

  const stayNights = nightsBetween(checkIn, checkOut);

  const [reservations, pricingRules, settingsRows] = await Promise.all([
    readSheet(env, "Reservations"),
    readSheet(env, "Pricing Rules"),
    readSheet(env, "Widget Settings"),
  ]);

  const settings = settingsToObject(settingsRows);
  const currency = settings.default_currency || "EUR";
  const defaultMinNights = toNumber(settings.default_min_nights, 1);

  const matchingReservations = reservations.filter((r) =>
  String(r.Listing || r.listing || "").trim() === propertyId
);

const blocker = findBlockingReservation(
  reservations,
  propertyId,
  checkIn,
  checkOut
);

if (blocker) {
  return json({
    ok: true,
    available: false,
    reason: "occupied",
    property_id: propertyId,
    check_in: checkInRaw,
    check_out: checkOutRaw,
    nights: stayNights,
    debug: {
      matching_reservations: matchingReservations.length,
      blocker,
    },
  });
}

  const rule = findPricingRule(pricingRules, propertyId, checkIn);
  if (!rule) {
    return json({
      ok: true,
      available: false,
      reason: "no_pricing_rule",
      property_id: propertyId,
      check_in: checkInRaw,
      check_out: checkOutRaw,
      nights: stayNights,
    });
  }

  const nightlyPrice = toNumber(rule.nightly_price, 0);
  const cleaningFee = toNumber(rule.cleaning_fee, 0);
  const minNights = toNumber(rule.min_nights, defaultMinNights);

  if (stayNights < minNights) {
    return json({
      ok: true,
      available: false,
      reason: "min_stay_not_met",
      min_nights: minNights,
      property_id: propertyId,
      check_in: checkInRaw,
      check_out: checkOutRaw,
      nights: stayNights,
    });
  }

  const accommodationTotal = nightlyPrice * stayNights;
  const totalPrice = accommodationTotal + cleaningFee;

  return json({
    ok: true,
    available: true,
    debug: {
      matching_reservations: matchingReservations.length,
      //sample_reservation: matchingReservations[0],
    },
    property_id: propertyId,
    check_in: checkInRaw,
    check_out: checkOutRaw,
    nights: stayNights,
    guests,
    currency,
    nightly_price: nightlyPrice,
    accommodation_total: accommodationTotal,
    cleaning_fee: cleaningFee,
    total_price: totalPrice,
    pricing_rule: rule.rule_id || null,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    try {
      if (url.pathname === "/quote") {
        return await handleQuote(request, env);
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json(
        {
          ok: false,
          error: String(err.message || err),
        },
        500
      );
    }
  },
};