/**
 * Endpoint: POST /api/searchable-pdf-ai
 * 
 * Multi-Column Bengali & English OCR for Searchable PDF Maker
 * Securely calls Google Gemini Vision API without exposing keys to the browser.
 */

import {
  handleOptions,
  validateRequest,
  extractImageData,
  callGeminiVision,
  jsonResponse
} from "./_common.js";

const SEARCHABLE_PDF_PROMPT = `You are an expert multi-column OCR engine for Bengali and English documents. Extract EVERY visible line of text exactly. Return ONLY a valid JSON array of objects, no markdown. Example: [{"text": "নাম: সাজেমান", "box": [120, 350, 140, 600]}]`;

export async function onRequestOptions() {
  return handleOptions();
}

export async function onRequestPost(context) {
  const { request, env } = context;
  return handleSearchablePdfAI(request, env);
}

export async function handleSearchablePdfAI(request, env) {
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
    prompt: SEARCHABLE_PDF_PROMPT,
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
