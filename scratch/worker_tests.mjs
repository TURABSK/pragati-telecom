import { onRequestPost as searchablePdfPost, onRequestOptions as searchablePdfOptions, handleSearchablePdfAI } from "../functions/api/searchable-pdf-ai.js";
import { onRequestPost as pdfAiPost, onRequestOptions as pdfAiOptions, handlePdfAI } from "../functions/api/pdf-ai.js";
import { onRequestPost as photoEnhancePost, onRequestOptions as photoEnhanceOptions, handlePhotoEnhance } from "../functions/api/photo-enhance.js";

async function runTests() {
  console.log("=== STARTING CLOUDFLARE PAGES FUNCTIONS PRODUCTION TESTS ===\n");
  let passed = 0;
  let total = 0;

  function assert(condition, testName) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName}`);
    }
  }

  // TEST 1: OPTIONS Preflight for /api/searchable-pdf-ai
  {
    const res = await searchablePdfOptions();
    assert(res.status === 204, "OPTIONS /api/searchable-pdf-ai returns 204 No Content");
    assert(res.headers.get("Access-Control-Allow-Origin") === "*", "CORS Allow-Origin header is present");
  }

  // TEST 2: GET method rejection on /api/searchable-pdf-ai
  {
    const req = new Request("http://localhost/api/searchable-pdf-ai", { method: "GET" });
    const res = await handleSearchablePdfAI(req, {});
    const data = await res.json();
    assert(res.status === 405, "GET /api/searchable-pdf-ai returns 405 Method Not Allowed");
    assert(data.success === false, "GET response has success: false");
  }

  // TEST 3: Invalid Content-Type
  {
    const req = new Request("http://localhost/api/searchable-pdf-ai", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello"
    });
    const res = await searchablePdfPost({ request: req, env: {} });
    const data = await res.json();
    assert(res.status === 400, "Non-JSON Content-Type returns 400");
    assert(data.error.includes("Invalid Content-Type"), "Clear Content-Type error message");
  }

  // TEST 4: Missing image field
  {
    const req = new Request("http://localhost/api/searchable-pdf-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ other: "data" })
    });
    const res = await searchablePdfPost({ request: req, env: {} });
    const data = await res.json();
    assert(res.status === 400, "Missing image field returns 400");
    assert(data.error.includes("Missing required 'image' field"), "Clear missing image error message");
  }

  // TEST 5: Unsupported mimeType
  {
    const req = new Request("http://localhost/api/searchable-pdf-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: "data:application/pdf;base64,JVBERi0xLjQK...", mimeType: "application/pdf" })
    });
    const res = await searchablePdfPost({ request: req, env: {} });
    const data = await res.json();
    assert(res.status === 400, "Unsupported mimeType returns 400");
    assert(data.error.includes("File type is not supported"), "Clear unsupported file type error message");
  }

  // TEST 6: Missing GEMINI_API_KEY secret in environment (Safe Error)
  {
    const sampleBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const req = new Request("http://localhost/api/searchable-pdf-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: sampleBase64, mimeType: "image/png" })
    });
    const envWithoutKey = {};
    const res = await searchablePdfPost({ request: req, env: envWithoutKey });
    const data = await res.json();
    assert(res.status === 503, "Missing GEMINI_API_KEY returns 503 Service Unavailable");
    assert(data.success === false, "Missing key response has success: false");
    assert(data.error.includes("AI service is not configured on this server"), "Clear guidance for administrator to configure key in Cloudflare");
    assert(!JSON.stringify(data).includes("AIza"), "No secret or internal token is leaked");
  }

  // TEST 7: Missing GEMINI_API_KEY on /api/pdf-ai
  {
    const sampleBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const req = new Request("http://localhost/api/pdf-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: sampleBase64, mimeType: "image/png" })
    });
    const envWithoutKey = {};
    const res = await pdfAiPost({ request: req, env: envWithoutKey });
    const data = await res.json();
    assert(res.status === 503, "/api/pdf-ai with missing key returns 503");
    assert(data.success === false, "/api/pdf-ai missing key has success: false");
    assert(data.error.includes("AI service is not configured"), "Safe user-facing message");
  }

  // TEST 8: /api/photo-enhance without provider key
  {
    const sampleBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const req = new Request("http://localhost/api/photo-enhance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: sampleBase64, action: "hd" })
    });
    const env = {};
    const res = await photoEnhancePost({ request: req, env });
    const data = await res.json();
    assert(res.status === 501, "/api/photo-enhance without provider returns 501 Not Implemented");
    assert(data.configured === false, "/api/photo-enhance reports configured: false");
    assert(data.error.includes("AI Enhancement backend is not configured yet"), "Honest status message as requested by user");
  }

  // TEST 9: Gemini model configuration & fallback validation
  {
    const { callGeminiVision } = await import("../functions/api/_common.js");
    
    // 9a: Default model fallback
    const resultDefault = await callGeminiVision({
      base64: "dGVzdA==",
      mimeType: "image/jpeg",
      prompt: "test",
      env: {} // No GEMINI_API_KEY
    });
    assert(resultDefault.status === 503, "Default call cleanly validates key absence");

    // 9b: Custom model validation
    const customEnv = { GEMINI_MODEL: "gemini-2.0-flash", GEMINI_API_KEY: "" };
    const resultCustom = await callGeminiVision({
      base64: "dGVzdA==",
      mimeType: "image/jpeg",
      prompt: "test",
      env: customEnv
    });
    assert(resultCustom.status === 503, "Custom model call cleanly validates key absence");
  }

  // TEST 10: Payload size limit (>10MB)
  {
    const hugeBody = "a".repeat(11 * 1024 * 1024);
    const req = new Request("http://localhost/api/searchable-pdf-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(hugeBody.length) },
      body: hugeBody
    });
    const res = await searchablePdfPost({ request: req, env: {} });
    const data = await res.json();
    assert(res.status === 413, "Payload exceeding 10MB returns 413 Payload Too Large");
    assert(data.error.includes("too large. Maximum size is 10 MB"), "Clear payload size error");
  }

  console.log(`\n=== TEST RESULTS: ${passed}/${total} TESTS PASSED ===`);
  if (passed === total) {
    console.log("🎉 ALL PRODUCTION PAGES FUNCTIONS TESTS PASSED WITH 100% SUCCESS!\n");
    process.exit(0);
  } else {
    console.error("⚠️ SOME TESTS FAILED!\n");
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
