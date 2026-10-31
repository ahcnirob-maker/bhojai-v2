// BhojAI v2 backend. The Gemini key is read only here, on the server.
const MODEL = "gemini-3.8-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const SYSTEM = `You are a nutrition expert for Bangladeshi food.
Identify every distinct food item visible in the photo and estimate the portion actually shown.
Use Bangladeshi household units where natural (বাটি, প্লেট, পিস, চামচ, গ্লাস) and also estimate grams.
Bangladeshi cooking is oil-rich: bhuna, jhol, kalia, fried items, biryani, tehari and sweets hold more fat than they look.
Give a best-estimate calorie value plus a realistic minimum and maximum.
Return ONLY valid JSON in this shape:
{"items":[{"name_bn":"","name_en":"","portion":"","grams":0,"calories":0,"calories_min":0,"calories_max":0,"protein_g":0,"carbs_g":0,"fat_g":0}],"confidence":"low|medium|high","note":""}
name_bn and portion must be in Bangla, name_en in English, note in Bangla (one short sentence, optional).
If the photo contains no food, return {"error":"not_food"}.`;

function callGemini(key, mime, b64, withThinking) {
  const generationConfig = { temperature: 0.2, responseMimeType: "application/json" };
  if (withThinking) generationConfig.thinkingConfig = { thinkingLevel: "low" };
  return fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [
        {
          parts: [
            { inlineData: { mimeType: mime, data: b64 } },
            { text: "Analyze this meal. Reply with JSON only." },
          ],
        },
      ],
      generationConfig,
    }),
    signal: AbortSignal.timeout(50000),
  });
}

const num = (v) => Math.max(0, Number(v) || 0);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  const key = process.env.GEMINI_API_KEY;
  console.log("[bhojai] key exists:", Boolean(key));
  if (!key) return res.status(500).json({ error: "no_key" });

  const body = req.body || {};
  let b64 = body.image || body.imageBase64 || "";
  let mime = body.mimeType || "image/jpeg";
  if (b64.startsWith("data:")) {
    mime = b64.slice(5, b64.indexOf(";"));
    b64 = b64.slice(b64.indexOf(",") + 1);
  }
  if (!b64) return res.status(400).json({ error: "no_image" });
  if (b64.length > 4000000) return res.status(413).json({ error: "too_big" });

  const t0 = Date.now();
  try {
    let r = await callGemini(key, mime, b64, true);
    if (r.status === 400) {
      console.warn("[bhojai] retrying without thinkingConfig");
      r = await callGemini(key, mime, b64, false);
    }
    if (!r.ok) {
      const txt = await r.text();
      console.error("[bhojai] gemini error", r.status, txt.slice(0, 500));
      return res.status(502).json({ error: "ai_failed", status: r.status });
    }

    const data = await r.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    let out;
    try {
      out = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      console.error("[bhojai] bad json:", text.slice(0, 300));
      return res.status(502).json({ error: "bad_json" });
    }
    if (out.error || !Array.isArray(out.items) || out.items.length === 0) {
      return res.status(422).json({ error: "not_food" });
    }

    const items = out.items.map((it) => {
      const calories = num(it.calories);
      return {
        name_bn: String(it.name_bn || ""),
        name_en: String(it.name_en || ""),
        portion: String(it.portion || ""),
        grams: num(it.grams),
        calories,
        calories_min: num(it.calories_min) || Math.round(calories * 0.85),
        calories_max: num(it.calories_max) || Math.round(calories * 1.15),
        protein_g: num(it.protein_g),
        carbs_g: num(it.carbs_g),
        fat_g: num(it.fat_g),
      };
    });

    console.log("[bhojai] ok in", Date.now() - t0, "ms,", items.length, "items");
    return res.status(200).json({
      items,
      confidence: out.confidence || "medium",
      note: String(out.note || ""),
    });
  } catch (e) {
    console.error("[bhojai]", e.name, e.message, "after", Date.now() - t0, "ms");
    const timeout = e.name === "TimeoutError" || e.name === "AbortError";
    return res.status(timeout ? 504 : 502).json({ error: timeout ? "timeout" : "ai_failed" });
  }
};
