/**
 * Endpoint: POST /api/pdf-ai
 * 
 * Line-by-Line OCR for Drag & Drop PDF Maker
 * Securely calls Google Gemini Vision API without exposing keys to the browser.
 */

import {
  handleOptions,
  validateRequest,
  extractImageData,
  callGeminiVision,
  jsonResponse
} from "./_common.js";

const PDF_MAKER_PROMPT = `You are an expert OCR engine. Extract EVERY visible line of text exactly. Break text STRICTLY LINE-BY-LINE. Provide accurate [ymin, xmin, ymax, xmax] coordinates scaled 0 to 1000. Return ONLY a valid JSON array of objects. Example: [{"text": "Example", "box": [100, 200, 120, 400]}]`;

export async function onRequestOptions() {
  return handleOptions();
}

export async function onRequestPost(context) {
  const { request, env } = context;
  return handlePdfAI(request, env);
}

export async function handlePdfAI(request, env) {
  const validation = await validateRequest(request);
  if (validation.isOptions) return handleOptions();
  if (validation.errorResponse) return validation.errorResponse;

  const imageResult = extractImageData(validation.body);
  if (imageResult.error) {
    return jsonResponse({ success: false, error: imageResult.error }, 400);
  }

  const result = await callGeminiVision({
    base64: imageResult.base64,
    mimeType: imageResult.mimeType,
    prompt: PDF_MAKER_PROMPT,
    env
  });

  if (result.status !== 200) {
    return jsonResponse({ success: false, error: result.error }, result.status);
  }

  return jsonResponse({
    success: true,
    blocks: result.blocks,
    truncated: result.truncated
  });
}
