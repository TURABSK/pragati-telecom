/**
 * Pragati Telecom - Cloudflare Worker / Pages Shared AI Backend Utility
 * 
 * Provides secure server-side AI processing with:
 * - Method & Content-Type validation
 * - Request size limits & abuse prevention
 * - Safe environment variable reading (env.GEMINI_API_KEY)
 * - Zero client-side credential exposure
 * - Sanitized user-friendly error responses
 */

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "X-Content-Type-Options": "nosniff"
};

// Max payload size: 10MB to prevent memory exhaustion / abuse
export const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Creates a JSON HTTP Response with CORS & Security headers
 */
export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

/**
 * Handles CORS Preflight OPTIONS requests
 */
export function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS
  });
}

/**
 * Validates incoming HTTP request
 */
export async function validateRequest(request) {
  if (request.method === "OPTIONS") {
    return { isOptions: true };
  }

  if (request.method !== "POST") {
    return {
      errorResponse: jsonResponse(
        { success: false, error: "Method not allowed. Only POST requests are supported." },
        405
      )
    };
  }

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      errorResponse: jsonResponse(
        { success: false, error: "Invalid Content-Type. Expected application/json." },
        400
      )
    };
  }

  const contentLength = parseInt(request.headers.get("Content-Length") || "0", 10);
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return {
      errorResponse: jsonResponse(
        { success: false, error: "Uploaded file or image payload is too large. Maximum size is 10 MB." },
        413
      )
    };
  }

  let body;
  try {
    const rawText = await request.text();
    if (rawText.length > MAX_PAYLOAD_BYTES) {
      return {
        errorResponse: jsonResponse(
          { success: false, error: "Uploaded file or image payload is too large. Maximum size is 10 MB." },
          413
        )
      };
    }
    body = JSON.parse(rawText);
  } catch (err) {
    return {
      errorResponse: jsonResponse(
        { success: false, error: "Malformed JSON payload." },
        400
      )
    };
  }

  if (!body || typeof body !== "object") {
    return {
      errorResponse: jsonResponse(
        { success: false, error: "Invalid request body." },
        400
      )
    };
  }

  return { body };
}

/**
 * Normalizes image base64 data and mime type
 */
export function extractImageData(body) {
  let image = body.image || body.data;
  if (!image || typeof image !== "string") {
    return { error: "Missing required 'image' field." };
  }

  let mimeType = body.mimeType || "image/jpeg";

  // If image is a data URL (e.g. data:image/png;base64,...), extract mime and base64
  if (image.startsWith("data:")) {
    const matches = image.match(/^data:([^;]+);base64,(.+)$/);
    if (matches) {
      mimeType = matches[1];
      image = matches[2];
    } else {
      const commaIdx = image.indexOf(",");
      if (commaIdx !== -1) {
        image = image.slice(commaIdx + 1);
      }
    }
  }

  // Allowed mime types for OCR & enhancement
  const allowedMimes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
  if (!allowedMimes.includes(mimeType.toLowerCase())) {
    return { error: "File type is not supported. Please provide JPEG, PNG, or WebP." };
  }

  // Basic base64 sanity check
  if (image.length < 50) {
    return { error: "Image data is too small or invalid." };
  }

  return { base64: image, mimeType };
}

/**
 * Calls Google Gemini Vision API securely using the server-side environment secret
 */
export async function callGeminiVision({ base64, mimeType, prompt, env }) {
  const apiKey = env?.GEMINI_API_KEY;
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim() === "") {
    return {
      status: 503,
      error: "AI service is not configured on this server. Please add GEMINI_API_KEY to your Cloudflare Worker / Pages secret settings."
    };
  }

  const rawModel = env?.GEMINI_MODEL;
  const preferredModel = (typeof rawModel === "string" && rawModel.trim()) ? rawModel.trim() : "gemini-3.6-flash";
  const candidateModels = [preferredModel, "gemini-3.5-flash", "gemini-3.0-flash", "gemini-2.5-flash", "gemini-2.0-flash"].filter((m, i, arr) => arr.indexOf(m) === i);

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 8192,
      responseMimeType: "application/json"
    }
  };

  let geminiRes = null;
  let resData = null;

  for (let i = 0; i < candidateModels.length; i++) {
    const currentModel = candidateModels[i];
    const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(currentModel)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
    try {
      geminiRes = await fetch(geminiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (geminiRes.status === 429) {
        return {
          status: 429,
          error: "AI service rate limit reached. Please wait a moment and try again."
        };
      }

      const resText = await geminiRes.text();
      try {
        resData = JSON.parse(resText);
      } catch {
        resData = null;
      }

      const errMsg = resData?.error?.message || resText;
      const recMatch = errMsg.match(/update your code to use (?:models\/)?([a-zA-Z0-9\.\-_]+)/i);
      if (recMatch && recMatch[1] && recMatch[1] !== currentModel) {
        const suggested = recMatch[1].trim();
        if (!candidateModels.includes(suggested)) {
          candidateModels.splice(i + 1, 0, suggested);
        }
        continue;
      }

      const isUnavailable =
        geminiRes.status === 404 ||
        geminiRes.status === 400 ||
        errMsg.includes("not found") ||
        errMsg.includes("no longer available") ||
        errMsg.includes("deprecated") ||
        errMsg.includes("update your code");

      if (isUnavailable && i < candidateModels.length - 1) {
        console.warn(`[Gemini API] Model ${currentModel} unavailable, trying fallback...`);
        continue;
      }

      if (!geminiRes.ok) {
        console.error(`[Gemini API Error] Status: ${geminiRes.status}, Body: ${resText.slice(0, 200)}`);
        return {
          status: 502,
          error: "AI request failed with provider: " + (resData?.error?.message || "Please try again.")
        };
      }

      break;
    } catch (err) {
      console.error(`[Gemini Fetch Error] on model ${currentModel}:`, err);
    }
  }

  if (!geminiRes || !geminiRes.ok || !resData) {
    return {
      status: 502,
      error: "AI service unavailable. Please try again."
    };
  }
    const candidate = resData?.candidates?.[0];
    const isTruncated = candidate?.finishReason === "MAX_TOKENS";
    const textOutput = candidate?.content?.parts?.map(p => p.text || "").join("") || "";

    // Parse JSON array from model output
    let jsonSlice = textOutput.trim();
    if (jsonSlice.startsWith("```")) {
      jsonSlice = jsonSlice.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    }
    const firstBracket = jsonSlice.indexOf("[");
    const lastBracket = jsonSlice.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      jsonSlice = jsonSlice.slice(firstBracket, lastBracket + 1);
    }

    let parsed = [];
    try {
      parsed = JSON.parse(jsonSlice);
    } catch {
      parsed = [];
    }

    const blocks = Array.isArray(parsed)
      ? parsed
          .filter(b => b && typeof b.text === "string" && Array.isArray(b.box) && b.box.length === 4)
          .map(b => ({
            text: b.text.normalize ? b.text.normalize("NFC") : b.text,
            box: b.box
          }))
      : [];

    return {
      status: 200,
      blocks,
      truncated: isTruncated
    };
  } catch (err) {
    console.error("[Gemini Connection Error]:", err.message || err);
    return {
      status: 500,
      error: "AI service temporarily unavailable. Please try again later."
    };
  }
}
