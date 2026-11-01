// Tenth: food, training and body fat tracking.
// Plain JavaScript module, no build step. Talks to Supabase (data + Edge Functions)
// and Open Food Facts (barcodes).

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY, APP_NAME } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const MEALS = ["breakfast", "lunch", "dinner", "snack"];
const NUTRIENTS = ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"];

const state = {
  session: null,
  profile: null,
  tab: "day",
  day: today(),
  installPrompt: null,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Build an element. Children that are strings become text, never HTML. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "value") value = v;
    else if (k === "checked") el.checked = !!v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  if (value !== undefined) el.value = value; // after options exist, so selects pick it up
  return el;
}

/** Replace an element's children, skipping empty slots (replaceChildren would print them as "null"). */
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

/** Build an SVG element. */
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const kid of kids.flat(Infinity)) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

function today() {
  return new Date().toLocaleDateString("en-CA"); // local YYYY-MM-DD
}
function addDays(day, n) {
  const d = new Date(day + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
}
function fmtDay(day, opts = { weekday: "short", day: "numeric", month: "short" }) {
  return new Date(day + "T12:00:00").toLocaleDateString(undefined, opts);
}
const r0 = (v) => Math.round(Number(v) || 0);
const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const numOrNull = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

function guessMeal() {
  const hr = new Date().getHours() + new Date().getMinutes() / 60;
  if (hr < 10.5) return "breakfast";
  if (hr < 15) return "lunch";
  if (hr < 17.5) return "snack";
  if (hr < 22) return "dinner";
  return "snack";
}

function toast(msg, isError = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = "toast"), isError ? 5000 : 2500);
}

/** Run an async action with the button showing a spinner; errors become a toast. */
async function busy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  fill(btn, h("span", { class: "spinner" }), label);
  try {
    return await fn();
  } catch (e) {
    toast(e.message || String(e), true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/** Throw on a Supabase error, return data otherwise. */
function must({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

/** Call an Edge Function and surface its error message. */
async function callFn(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try {
      const j = await error.context.json();
      if (j?.error) msg = j.error;
    } catch { /* keep generic message */ }
    throw new Error(msg);
  }
  return data;
}

/** Shrink an image and return base64 JPEG. Tall share images keep their height. */
async function imageToBase64(file) {
  const looksLikeImage = file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name || "");
  if (!looksLikeImage) throw new Error("That file isn't an image. Pick a photo, or the image Mi Fitness saved.");
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error("Couldn't open that image. Try sharing it as a JPEG or PNG.");
  }
  const scale = Math.min(1, 1280 / bmp.width, 4096 / bmp.height);
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(bin), mime: "image/jpeg", url: URL.createObjectURL(blob) };
}

/** Camera / Photos / Files buttons. Files opens Android's file browser for images saved there. */
function picker(onFile, { camera = true } = {}) {
  const make = (label, attrs) => {
    const input = h("input", {
      type: "file", class: "hidden", ...attrs,
      onchange: (e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) onFile(f);
      },
    });
    return [h("button", { class: "pick", type: "button", onclick: () => input.click() }, label), input];
  };
  return h("div", { class: "picker", style: camera ? null : "grid-template-columns: 1fr 1fr" },
    camera ? make("📷 Camera", { accept: "image/*", capture: "environment" }) : null,
    make("🖼 Photos", { accept: "image/*" }),
    make("📁 Files", {}),
  );
}

// ---------------------------------------------------------------------------
// Bottom sheet
// ---------------------------------------------------------------------------

const sheet = document.getElementById("sheet");
let sheetCleanup = null;

function openSheet(title, ...content) {
  closeSheetCleanup();
  document.getElementById("sheet-title").textContent = title;
  fill(document.getElementById("sheet-body"), ...content);
  if (!sheet.open) sheet.showModal();
  document.getElementById("sheet-body").scrollTop = 0;
}
function closeSheet() {
  closeSheetCleanup();
  if (sheet.open) sheet.close();
}
function closeSheetCleanup() {
  if (sheetCleanup) { const f = sheetCleanup; sheetCleanup = null; f(); }
}
document.getElementById("sheet-close").addEventListener("click", closeSheet);
sheet.addEventListener("close", closeSheetCleanup);
sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); }); // tap outside

// ---------------------------------------------------------------------------
// Items: [{name, grams, kcal, protein_g, carbs_g, fat_g, fiber_g}]
// ---------------------------------------------------------------------------

function sumItems(items) {
  const t = { grams: 0, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
  for (const it of items) for (const k of Object.keys(t)) t[k] += Number(it[k]) || 0;
  return t;
}

function cleanItems(items) {
  return items
    .filter((it) => (it.name || "").trim() || it.kcal)
    .map((it) => ({
      name: (it.name || "Item").trim(),
      grams: r1(it.grams),
      kcal: r1(it.kcal),
      protein_g: r1(it.protein_g),
      carbs_g: r1(it.carbs_g),
      fat_g: r1(it.fat_g),
      fiber_g: r1(it.fiber_g),
    }));
}

/** Editable list of items. Changing grams rescales that item's calories and macros. */
function itemsEditor(items) {
  const wrap = h("div");
  const totalsEl = h("div", { class: "totals num" });

  const updateTotals = () => {
    const t = sumItems(items);
    totalsEl.textContent = `Total ${r0(t.kcal)} kcal · P ${r0(t.protein_g)} · C ${r0(t.carbs_g)} · F ${r0(t.fat_g)}`;
  };

  const numInput = (it, key) =>
    h("input", {
      type: "number", inputmode: "decimal", step: "any", value: it[key] === undefined ? "" : r1(it[key]),
      oninput: (e) => { it[key] = Number(e.target.value) || 0; updateTotals(); },
    });

  const render = () => {
    fill(wrap, 
      ...items.map((it, i) => {
        const grams = h("input", {
          type: "number", inputmode: "decimal", step: "any", value: it.grams ? r1(it.grams) : "",
          onchange: (e) => {
            const g = Number(e.target.value);
            if (!(g > 0)) return;
            if (it.grams > 0) {
              const f = g / it.grams;
              for (const k of NUTRIENTS) it[k] = (Number(it[k]) || 0) * f;
            }
            it.grams = g;
            render();
          },
        });
        return h("div", { class: "item" },
          h("div", { class: "item-top" },
            h("input", { value: it.name || "", placeholder: "Food", oninput: (e) => (it.name = e.target.value) }),
            h("button", { class: "icon-btn", type: "button", "aria-label": "Remove", onclick: () => { items.splice(i, 1); render(); } }, "✕"),
          ),
          h("div", { class: "item-nums" },
            h("div", {}, h("label", {}, "grams"), grams),
            h("div", {}, h("label", {}, "kcal"), numInput(it, "kcal")),
            h("div", {}, h("label", {}, "protein"), numInput(it, "protein_g")),
            h("div", {}, h("label", {}, "carbs"), numInput(it, "carbs_g")),
            h("div", {}, h("label", {}, "fat"), numInput(it, "fat_g")),
          ),
        );
      }),
      h("button", { class: "link", type: "button", onclick: () => { items.push({ name: "", grams: 0, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 }); render(); } }, "+ Add item"),
      totalsEl,
    );
    updateTotals();
  };
  render();
  return wrap;
}

// ---------------------------------------------------------------------------
// Food review: the one screen every food entry passes through before saving
// ---------------------------------------------------------------------------

function openFoodReview(opts) {
  const items = (opts.items || []).map((it) => ({ ...it }));
  if (!items.length) items.push({ name: "", grams: 0, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 });

  const desc = h("input", { value: opts.description || items.map((i) => i.name).filter(Boolean).join(", ") });
  const date = h("input", { type: "date", value: opts.day || state.day });
  const meal = h("select", { value: opts.meal || guessMeal() }, ...MEALS.map((m) => h("option", { value: m }, cap(m))));
  const planned = h("input", {
    type: "checkbox",
    checked: opts.status ? opts.status === "planned" : (opts.day || state.day) > today(),
  });
  date.addEventListener("change", () => { if (date.value > today()) planned.checked = true; });

  // New meals built by the AI or by hand are worth keeping; untick to skip
  const offerSave = !opts.savedMeal && !opts.editId && ["photo", "text", "manual"].includes(opts.source || "manual");
  const saveAs = h("input", { type: "checkbox", checked: offerSave });
  const saveName = h("input", { placeholder: "Meal name, e.g. Usual breakfast", class: offerSave ? null : "hidden" });
  const syncSaveName = () => {
    saveName.classList.toggle("hidden", !saveAs.checked);
    if (saveAs.checked && !saveName.value) saveName.value = desc.value;
  };
  saveAs.addEventListener("change", syncSaveName);
  desc.addEventListener("input", () => { if (saveAs.checked) saveName.value = desc.value; });
  syncSaveName();

  const answer = h("input", { placeholder: "Your answer" });
  const saveBtn = h("button", { class: "btn" }, opts.editId ? "Save changes" : "Save");

  saveBtn.addEventListener("click", () => busy(saveBtn, async () => {
    const clean = cleanItems(items);
    if (!clean.length) throw new Error("Add at least one item.");
    const t = sumItems(clean);
    const row = {
      eaten_on: date.value || state.day,
      meal: meal.value,
      description: desc.value.trim() || clean.map((i) => i.name).join(", "),
      grams: t.grams ? r1(t.grams) : null,
      kcal: r1(t.kcal),
      protein_g: r1(t.protein_g),
      carbs_g: r1(t.carbs_g),
      fat_g: r1(t.fat_g),
      fiber_g: t.fiber_g ? r1(t.fiber_g) : null,
      source: opts.source || "manual",
      confidence: opts.confidence || null,
      food_id: opts.foodId || null,
      items: clean,
      status: planned.checked ? "planned" : "eaten",
    };
    if (row.status === "eaten" && opts.status === "planned") row.eaten_at = new Date().toISOString();
    if (opts.editId) must(await sb.from("food_logs").update(row).eq("id", opts.editId));
    else must(await sb.from("food_logs").insert(row));

    if (saveAs.checked) {
      const name = saveName.value.trim() || row.description;
      must(await sb.from("saved_meals").upsert({ name, meal: row.meal, items: clean }, { onConflict: "user_id,name" }));
    }
    if (opts.savedMeal) {
      must(await sb.from("saved_meals")
        .update({ use_count: (opts.savedMeal.use_count || 0) + 1, last_used_at: new Date().toISOString() })
        .eq("id", opts.savedMeal.id));
    }
    closeSheet();
    toast(opts.editId ? "Updated" : `${row.status === "planned" ? "Planned" : "Logged"} ${r0(row.kcal)} kcal`);
    if (row.eaten_on !== state.day) state.day = row.eaten_on;
    if (opts.afterSave) opts.afterSave(row);
    else render();
  }));

  openSheet(opts.title || "Check and log",
    ...(opts.warnings || []).map((w) => h("div", { class: "warn" }, w)),
    opts.confidence ? h("div", { class: "small muted" }, `AI confidence: ${opts.confidence}`) : null,
    ...(opts.assumptions || []).map((a) => h("div", { class: "note" }, "Assumed: ", a)),
    opts.question && opts.rerun
      ? h("div", { class: "note stack" },
          h("div", {}, opts.question),
          answer,
          h("button", {
            class: "btn secondary", type: "button",
            onclick: (e) => busy(e.currentTarget, () => opts.rerun(answer.value)),
          }, "Answer and re-estimate"))
      : null,
    h("label", {}, "Description"), desc,
    h("div", { class: "grid-2" },
      h("div", {}, h("label", {}, "Meal"), meal),
      h("div", {}, h("label", {}, "Day"), date)),
    h("label", { class: "check" }, planned, "Planned (not eaten yet)"),
    h("label", {}, "Items (change grams to rescale)"),
    itemsEditor(items),
    opts.savedMeal ? null : h("label", { class: "check" }, saveAs, "Save as a meal for next time"),
    saveName,
    h("div", { style: "height:8px" }),
    saveBtn,
  );
}

// ---------------------------------------------------------------------------
// Food: photo, typed, saved, barcode
// ---------------------------------------------------------------------------

function openPhotoFood(initialFile) {
  let img = null;
  const preview = h("img", { class: "preview hidden", alt: "" });
  const note = h("textarea", { placeholder: "Ingredients and weights, e.g. 180 g grilled chicken breast, 150 g cooked basmati rice, 1 tbsp olive oil" });
  const go = h("button", { class: "btn", disabled: true }, "Estimate");

  const setFile = async (f) => {
    try {
      img = await imageToBase64(f);
      preview.src = img.url;
      preview.classList.remove("hidden");
      go.disabled = false;
    } catch (e) { toast(e.message, true); }
  };

  const run = async (extra = "") => {
    const fullNote = [note.value.trim(), extra && `Answer to your question: ${extra}`].filter(Boolean).join("\n");
    const out = await callFn("ai", { mode: "food_photo", image: img.data, mime_type: img.mime, note: fullNote });
    note.value = fullNote;
    openFoodReview({
      title: "Check the estimate",
      items: out.items, confidence: out.confidence, assumptions: out.assumptions, warnings: out.warnings,
      question: out.question, rerun: (ans) => run(ans), source: "photo",
    });
  };
  go.addEventListener("click", () => busy(go, () => run()));

  openSheet("Food photo",
    picker(setFile), preview,
    h("label", {}, "What's in it (weights make it far more accurate)"), note,
    h("div", { style: "height:10px" }), go);
  if (initialFile) setFile(initialFile);
}

function openTypedFood(ctx = {}) {
  const note = h("textarea", { placeholder: "e.g. 2 eggs scrambled in 5 g butter, 1 slice sourdough 40 g, 150 g Greek yogurt 2%" });
  const go = h("button", { class: "btn" }, "Estimate");
  const run = async (extra = "") => {
    const text = [note.value.trim(), extra && `Answer to your question: ${extra}`].filter(Boolean).join("\n");
    if (!text) throw new Error("Describe the meal first.");
    const out = await callFn("ai", { mode: "food_text", note: text });
    note.value = text;
    openFoodReview({
      title: "Check the estimate",
      items: out.items, confidence: out.confidence, assumptions: out.assumptions, warnings: out.warnings,
      question: out.question, rerun: (ans) => run(ans), source: "text", ...ctx,
    });
  };
  go.addEventListener("click", () => busy(go, () => run()));
  openSheet("Type a meal",
    h("label", {}, "What did you eat?"), note,
    h("div", { style: "height:10px" }), go,
    h("button", { class: "link", onclick: () => openFoodReview({ title: "Enter numbers", source: "manual", ...ctx }) }, "Or enter the numbers yourself"));
}

async function openSavedPicker() {
  const meals = must(await sb.from("saved_meals").select("*").order("last_used_at", { ascending: false, nullsFirst: false }).order("name"));
  if (!meals.length) {
    openSheet("Saved meals", h("p", { class: "muted" }, "No saved meals yet. Tick “Save as a meal” when you log something, or use Save as meal on any entry."));
    return;
  }
  openSheet("Saved meals", ...meals.map((m) => savedMealRow(m)));
}

function savedMealRow(m) {
  const t = sumItems(m.items);
  return h("button", { class: "entry", onclick: () => logSavedMeal(m) },
    h("span", { class: "desc" }, m.name, h("div", { class: "small muted" }, m.meal ? cap(m.meal) : "", m.items.length > 1 ? ` · ${m.items.length} items` : "")),
    h("span", { class: "num" }, `${r0(t.kcal)} kcal`));
}

function logSavedMeal(m) {
  openFoodReview({
    title: m.name,
    description: m.name,
    items: m.items,
    meal: m.meal || guessMeal(),
    source: "saved",
    savedMeal: m,
  });
}

// --- Barcode ---

async function openScan() {
  const video = h("video", { class: "scanner", playsinline: true, muted: true });
  const status = h("div", { class: "small muted" }, "Point the camera at the barcode.");
  const manual = h("input", { inputmode: "numeric", placeholder: "Or type the barcode number" });
  const lookBtn = h("button", { class: "btn secondary" }, "Look up");
  let stream = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    stream?.getTracks().forEach((t) => t.stop());
  };
  lookBtn.addEventListener("click", () => busy(lookBtn, async () => {
    const code = manual.value.replace(/\D/g, "");
    if (code.length < 8) throw new Error("Barcodes are 8 to 14 digits.");
    stop();
    await lookupBarcode(code);
  }));

  openSheet("Scan barcode", video, status, h("label", {}, "Barcode"), manual, h("div", { style: "height:8px" }), lookBtn);
  sheetCleanup = stop;

  if (!("BarcodeDetector" in window)) {
    video.classList.add("hidden");
    status.textContent = "This browser can't scan barcodes. Type the number instead.";
    return;
  }
  try {
    const supported = await BarcodeDetector.getSupportedFormats();
    const formats = ["ean_13", "ean_8", "upc_a", "upc_e"].filter((f) => supported.includes(f));
    const detector = new BarcodeDetector({ formats });
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
    if (stopped) { stop(); return; }
    video.srcObject = stream;
    await video.play();
    const tick = async () => {
      if (stopped) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          stop();
          navigator.vibrate?.(60);
          status.textContent = `Found ${codes[0].rawValue}. Looking it up…`;
          try { await lookupBarcode(codes[0].rawValue); } catch (e) { toast(e.message, true); }
          return;
        }
      } catch { /* frame not ready */ }
      setTimeout(tick, 250);
    };
    tick();
  } catch (e) {
    video.classList.add("hidden");
    status.textContent = "Camera not available. Type the barcode instead.";
  }
}

async function fetchOpenFoodFacts(code) {
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,brands,nutriments,serving_quantity`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = await res.json();
  const p = j.product;
  if (!p) return null;
  const n = p.nutriments || {};
  let kcal = n["energy-kcal_100g"];
  if (kcal == null && n["energy_100g"] != null) kcal = n["energy_100g"] / 4.184; // kJ to kcal
  if (kcal == null) return null;
  return {
    barcode: code,
    name: p.product_name || "Unnamed product",
    brand: (p.brands || "").split(",")[0].trim() || null,
    serving_g: Number(p.serving_quantity) || null,
    kcal_100g: r1(kcal),
    protein_100g: r1(n.proteins_100g),
    carbs_100g: r1(n.carbohydrates_100g),
    fat_100g: r1(n.fat_100g),
    fiber_100g: n.fiber_100g != null ? r1(n.fiber_100g) : null,
    source: "openfoodfacts",
  };
}

async function lookupBarcode(code) {
  // Your own library first (instant, and includes labels you photographed)
  let food = must(await sb.from("foods").select("*").eq("barcode", code).maybeSingle());
  if (!food) {
    const off = await fetchOpenFoodFacts(code).catch(() => null);
    if (off) food = must(await sb.from("foods").insert(off).select().single());
  }
  if (food) openProduct(food);
  else openLabelCapture(code);
}

function openProduct(food) {
  const grams = h("input", { type: "number", inputmode: "decimal", value: food.serving_g || 100 });
  const per = (k) => r1(food[k]);
  openSheet(food.name,
    food.brand ? h("div", { class: "muted" }, food.brand) : null,
    h("div", { class: "note num" },
      `Per 100 g: ${per("kcal_100g")} kcal · P ${per("protein_100g")} · C ${per("carbs_100g")} · F ${per("fat_100g")}`),
    h("label", {}, "How many grams?"), grams,
    h("div", { style: "height:10px" }),
    h("button", {
      class: "btn",
      onclick: () => {
        const g = Number(grams.value) || 0;
        const f = g / 100;
        openFoodReview({
          title: "Log product",
          description: food.brand ? `${food.name} (${food.brand})` : food.name,
          items: [{
            name: food.name, grams: g,
            kcal: food.kcal_100g * f, protein_g: food.protein_100g * f, carbs_g: food.carbs_100g * f,
            fat_g: food.fat_100g * f, fiber_g: (food.fiber_100g || 0) * f,
          }],
          source: food.source === "label_photo" ? "label" : "barcode",
          foodId: food.id,
        });
      },
    }, "Next"),
    h("button", { class: "link", onclick: () => openFoodEditor(food) }, "Numbers look wrong? Edit this product"));
}

function openLabelCapture(code) {
  let img = null;
  const preview = h("img", { class: "preview hidden", alt: "" });
  const go = h("button", { class: "btn", disabled: true }, "Read label");
  go.addEventListener("click", () => busy(go, async () => {
    const out = await callFn("ai", { mode: "label", image: img.data, mime_type: img.mime });
    openFoodEditor({
      barcode: code, name: out.name || "", brand: out.brand || "", serving_g: out.serving_g,
      kcal_100g: out.kcal_100g, protein_100g: out.protein_100g, carbs_100g: out.carbs_100g,
      fat_100g: out.fat_100g, fiber_100g: out.fiber_100g, source: "label_photo",
    }, out.warnings);
  }));
  openSheet("Not in the database",
    h("p", { class: "muted" }, code ? `Barcode ${code} isn't in Open Food Facts. Photograph the nutrition label and it'll be saved for next time.` : "Photograph the nutrition label."),
    picker(async (f) => {
      try {
        img = await imageToBase64(f);
        preview.src = img.url;
        preview.classList.remove("hidden");
        go.disabled = false;
      } catch (e) { toast(e.message, true); }
    }),
    preview, h("div", { style: "height:10px" }), go);
}

function openFoodEditor(food, warnings = []) {
  const f = { ...food };
  const field = (key, label, type = "number") =>
    h("div", {}, h("label", {}, label), h("input", {
      type, inputmode: type === "number" ? "decimal" : null, step: "any", value: f[key] ?? "",
      oninput: (e) => (f[key] = type === "number" ? numOrNull(e.target.value) : e.target.value),
    }));
  const save = h("button", { class: "btn" }, "Save product");
  save.addEventListener("click", () => busy(save, async () => {
    if (!f.name || f.kcal_100g == null) throw new Error("Name and calories are needed.");
    const row = {
      barcode: f.barcode || null, name: f.name, brand: f.brand || null, serving_g: f.serving_g || null,
      kcal_100g: f.kcal_100g, protein_100g: f.protein_100g || 0, carbs_100g: f.carbs_100g || 0,
      fat_100g: f.fat_100g || 0, fiber_100g: f.fiber_100g ?? null, source: f.source || "manual",
    };
    const saved = f.id
      ? must(await sb.from("foods").update(row).eq("id", f.id).select().single())
      : must(await sb.from("foods").insert(row).select().single());
    openProduct(saved);
  }));
  openSheet("Product",
    ...warnings.map((w) => h("div", { class: "warn" }, w)),
    field("name", "Name", "text"), field("brand", "Brand", "text"),
    h("div", { class: "small muted", style: "margin-top:10px" }, "Per 100 g (or 100 ml)"),
    h("div", { class: "grid-3" },
      field("kcal_100g", "kcal"), field("protein_100g", "Protein g"), field("carbs_100g", "Carbs g")),
    h("div", { class: "grid-3" },
      field("fat_100g", "Fat g"), field("fiber_100g", "Fibre g"), field("serving_g", "Serving g")),
    h("div", { style: "height:10px" }), save);
}

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

function openWorkoutUpload(initialFile) {
  let img = null;
  const preview = h("img", { class: "preview hidden", alt: "" });
  const note = h("textarea", { placeholder: "What you did, e.g. CrossFit: 5 rounds of 10 thrusters 40 kg, 10 pull-ups, 400 m run" });
  const go = h("button", { class: "btn", disabled: true }, "Read workout");

  const setFile = async (f) => {
    try {
      img = await imageToBase64(f);
      preview.src = img.url;
      preview.classList.remove("hidden");
      go.disabled = false;
    } catch (e) { toast(e.message, true); }
  };
  go.addEventListener("click", () => busy(go, async () => {
    const out = await callFn("ai", { mode: "workout", image: img.data, mime_type: img.mime, note: note.value.trim() });
    openWorkoutForm(out);
  }));

  openSheet("Add workout",
    h("p", { class: "small muted" }, "In Mi Fitness, open the workout, tap Share and pick this app. Or save the image and choose it here."),
    picker(setFile, { camera: false }), preview,
    h("label", {}, "What did you do? (optional, helps the review)"), note,
    h("div", { style: "height:10px" }), go,
    h("button", { class: "link", onclick: () => openWorkoutForm({ description: note.value.trim() }) }, "Enter it by hand instead"));
  if (initialFile) setFile(initialFile);
}

function openWorkoutForm(w) {
  const startDefault = w.started_at_local || `${state.day}T${new Date().toTimeString().slice(0, 5)}`;
  const v = {
    type: w.type || "",
    start: startDefault,
    minutes: w.duration_s ? r1(w.duration_s / 60) : "",
    active_kcal: w.active_kcal ?? "",
    total_kcal: w.total_kcal ?? "",
    avg_hr: w.avg_hr ?? "",
    max_hr: w.max_hr ?? "",
    training_load: w.training_load ?? "",
    recovery_h: w.recovery_h ?? "",
    kcal_used: w.kcal_used ?? w.active_kcal ?? "",
    description: w.description || "",
  };
  const field = (key, label, type = "number") =>
    h("div", {}, h("label", {}, label), h("input", {
      type, inputmode: type === "number" ? "numeric" : null, value: v[key],
      oninput: (e) => (v[key] = e.target.value),
    }));
  const desc = h("textarea", { value: v.description, oninput: (e) => (v.description = e.target.value) });
  const save = h("button", { class: "btn" }, "Save workout");

  save.addEventListener("click", () => busy(save, async () => {
    if (!v.type.trim()) throw new Error("Give the workout a type.");
    const used = numOrNull(v.kcal_used) ?? numOrNull(v.active_kcal);
    if (used == null) throw new Error("Enter the calories burned (active kcal).");
    const z = w.zones_s || {};
    const row = {
      done_on: v.start ? v.start.slice(0, 10) : state.day,
      started_at: v.start ? new Date(v.start).toISOString() : null,
      type: v.type.trim(),
      description: v.description.trim() || null,
      duration_s: numOrNull(v.minutes) ? Math.round(Number(v.minutes) * 60) : null,
      active_kcal: numOrNull(v.active_kcal),
      total_kcal: numOrNull(v.total_kcal),
      avg_hr: numOrNull(v.avg_hr),
      max_hr: numOrNull(v.max_hr),
      zone_light_s: z.light ?? null,
      zone_intensive_s: z.intensive ?? null,
      zone_aerobic_s: z.aerobic ?? null,
      zone_anaerobic_s: z.anaerobic ?? null,
      zone_vo2max_s: z.vo2max ?? null,
      aerobic_te: w.aerobic_te ?? null,
      anaerobic_te: w.anaerobic_te ?? null,
      training_load: numOrNull(v.training_load),
      recovery_h: numOrNull(v.recovery_h),
      kcal_used: Math.round(used),
      source: w.type && w.zones_s ? "mi_fitness_image" : "manual",
      ai_raw: w.zones_s ? w : null,
    };
    const { error } = await sb.from("workouts").insert(row);
    if (error?.code === "23505") throw new Error("That workout is already saved.");
    if (error) throw new Error(error.message);
    closeSheet();
    toast(`Workout saved: ${row.kcal_used} kcal`);
    state.day = row.done_on;
    render();
  }));

  openSheet("Check workout",
    ...(w.warnings || []).map((x) => h("div", { class: "warn" }, x)),
    field("type", "Type", "text"),
    h("div", {}, h("label", {}, "Start"), h("input", { type: "datetime-local", value: v.start, oninput: (e) => (v.start = e.target.value) })),
    h("div", { class: "grid-3" }, field("minutes", "Minutes"), field("active_kcal", "Active kcal"), field("total_kcal", "Total kcal")),
    h("div", { class: "grid-3" }, field("avg_hr", "Avg HR"), field("max_hr", "Max HR"), field("training_load", "Load")),
    h("div", { class: "grid-2" }, field("recovery_h", "Recovery h"), field("kcal_used", "Burn the plan uses")),
    h("div", { class: "small muted" }, "The plan eats this burn back the next day. Lower it if you think the watch overestimates."),
    h("label", {}, "What you did"), desc,
    h("div", { style: "height:10px" }), save);
}

// ---------------------------------------------------------------------------
// Weigh-in and steps
// ---------------------------------------------------------------------------

async function openWeighIn() {
  const day = state.day;
  const existing = must(await sb.from("body_metrics").select("*").eq("measured_on", day).maybeSingle()) || {};
  const female = state.profile?.sex === "female";
  const v = {
    date: day,
    weight: existing.weight_kg ?? "",
    waist: existing.waist_cm ?? "",
    neck: existing.neck_cm ?? "",
    hip: existing.hip_cm ?? "",
    chest: existing.chest_cm ?? "",
    arm: existing.arm_cm ?? "",
    thigh: existing.thigh_cm ?? "",
    bf: existing.bf_method === "manual" ? existing.body_fat_pct : "",
  };
  const field = (key, label, type = "number") =>
    h("div", {}, h("label", {}, label), h("input", {
      type, inputmode: type === "number" ? "decimal" : null, step: "any", value: v[key],
      oninput: (e) => (v[key] = e.target.value),
    }));
  const save = h("button", { class: "btn" }, "Save");
  save.addEventListener("click", () => busy(save, async () => {
    const weight = numOrNull(v.weight);
    if (!weight) throw new Error("Enter your weight.");
    const manualBf = numOrNull(v.bf);
    const row = {
      measured_on: v.date,
      weight_kg: weight,
      waist_cm: numOrNull(v.waist),
      neck_cm: numOrNull(v.neck),
      hip_cm: numOrNull(v.hip),
      chest_cm: numOrNull(v.chest),
      arm_cm: numOrNull(v.arm),
      thigh_cm: numOrNull(v.thigh),
      body_fat_pct: manualBf,
      bf_method: manualBf != null ? "manual" : null,
    };
    const saved = must(await sb.from("body_metrics").upsert(row, { onConflict: "user_id,measured_on" }).select().single());
    closeSheet();
    toast(saved.body_fat_pct != null ? `Saved: ${saved.weight_kg} kg, body fat ${saved.body_fat_pct}%` : `Saved: ${saved.weight_kg} kg`);
    render();
  }));

  openSheet("Weigh-in",
    h("div", { class: "grid-2" }, field("date", "Day", "date"), field("weight", "Weight kg")),
    h("div", { class: "small muted", style: "margin-top:12px" },
      "Body fat from a tape (weekly is enough): measure first thing, relaxed, same spot each time. ",
      female ? "Waist at the narrowest point, hips at the widest, neck just below the larynx." : "Waist level with the navel, neck just below the Adam's apple."),
    h("div", { class: female ? "grid-3" : "grid-2" },
      field("waist", "Waist cm"), field("neck", "Neck cm"), female ? field("hip", "Hips cm") : null),
    field("bf", "Or body fat % from another method (overrides tape)"),
    h("details", { style: "margin-top:12px", open: [v.chest, v.arm, v.thigh, female ? "" : v.hip].some((x) => x !== "") },
      h("summary", { class: "muted" }, "More measurements (optional)"),
      h("div", { class: "small muted" }, "Track these to see where the inches come off. Same side, same spot, relaxed except the arm (flexed)."),
      h("div", { class: "grid-2" },
        field("chest", "Chest cm"), female ? null : field("hip", "Hips cm"),
        field("arm", "Arm cm (flexed)"), field("thigh", "Thigh cm"))),
    h("div", { style: "height:10px" }), save);
}

async function openSteps() {
  const existing = must(await sb.from("daily_activity").select("steps").eq("day", state.day).maybeSingle());
  const date = h("input", { type: "date", value: state.day });
  const steps = h("input", { type: "number", inputmode: "numeric", value: existing?.steps ?? "" });
  const save = h("button", { class: "btn" }, "Save");
  save.addEventListener("click", () => busy(save, async () => {
    const n = numOrNull(steps.value);
    if (n == null) throw new Error("Enter your steps.");
    must(await sb.from("daily_activity").upsert({ day: date.value, steps: Math.round(n) }, { onConflict: "user_id,day" }));
    closeSheet();
    toast("Steps saved");
    render();
  }));
  openSheet("Steps",
    h("p", { class: "small muted" }, "End-of-day total from Mi Fitness. The plan compares it to your usual so normal walking isn't counted twice."),
    h("div", { class: "grid-2" }, h("div", {}, h("label", {}, "Day"), date), h("div", {}, h("label", {}, "Steps"), steps)),
    h("div", { style: "height:10px" }), save);
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

async function runPlan(btn) {
  await busy(btn, async () => {
    const forDate = addDays(state.day, 1);
    const p = await callFn("plan", { today: state.day, for_date: forDate });
    const line = (label, val, cls = "") => h("div", { class: "row num " + cls }, h("span", {}, label), h("span", {}, val));
    openSheet(`Plan for ${fmtDay(forDate)}`,
      h("div", { class: "big num" }, `${p.kcal} kcal`),
      h("div", { class: "num" }, `Protein ${p.protein_g} g · Carbs ${p.carbs_g} g · Fat ${p.fat_g} g`),
      h("div", { class: "card stack", style: "background:var(--card-2)" },
        line("Everyday burn", `${p.neat_kcal}`),
        line("+ Workout today", `${p.exercise_kcal}`),
        p.steps_adjust_kcal ? line(p.steps_adjust_kcal > 0 ? "+ Extra steps" : "− Fewer steps than usual", `${Math.abs(p.steps_adjust_kcal)}`) : null,
        line("− Deficit", `${p.deficit_kcal}`),
        h("div", { class: "small muted" }, `Method: ${p.method}. Trend ${p.detail.trend_kg_per_week ?? "–"} kg/week.`)),
      p.timeline ? h("div", { class: "note" },
        `Goal weight ${p.timeline.goal_weight_kg} kg at ${state.profile?.target_bf_pct ?? 10}% · ${p.timeline.kg_to_lose} kg to go · about ${p.timeline.weeks} weeks (${fmtDay(p.timeline.eta, { day: "numeric", month: "short", year: "numeric" })}).`) : null,
      ...p.notes.map((n) => h("div", { class: "note" }, n)),
    );
  });
}

// ---------------------------------------------------------------------------
// Entry actions
// ---------------------------------------------------------------------------

function entryItems(e) {
  if (Array.isArray(e.items) && e.items.length) return e.items;
  return [{ name: e.description, grams: e.grams || 0, kcal: e.kcal, protein_g: e.protein_g, carbs_g: e.carbs_g, fat_g: e.fat_g, fiber_g: e.fiber_g || 0 }];
}

const isPlanned = (e) => e.status === "planned";

/** One tap: save an entry as a reusable meal named after its description. */
async function quickSaveMeal(e) {
  const name = (e.description || "Meal").trim().slice(0, 80);
  must(await sb.from("saved_meals").upsert({ name, meal: e.meal, items: entryItems(e) }, { onConflict: "user_id,name" }));
  toast(`★ Saved “${name}” to Meals`);
}

async function markEaten(e) {
  must(await sb.from("food_logs").update({ status: "eaten", eaten_at: new Date().toISOString() }).eq("id", e.id));
  toast(`Ate it: ${r0(e.kcal)} kcal`);
}

/** Add a saved meal straight to a day, no review screen. */
async function addSavedMealTo(m, day, slot, status) {
  const t = sumItems(m.items);
  must(await sb.from("food_logs").insert({
    eaten_on: day,
    meal: slot || m.meal || guessMeal(),
    description: m.name,
    grams: t.grams ? r1(t.grams) : null,
    kcal: r1(t.kcal),
    protein_g: r1(t.protein_g),
    carbs_g: r1(t.carbs_g),
    fat_g: r1(t.fat_g),
    fiber_g: t.fiber_g ? r1(t.fiber_g) : null,
    source: "saved",
    items: m.items,
    status,
  }));
  must(await sb.from("saved_meals")
    .update({ use_count: (m.use_count || 0) + 1, last_used_at: new Date().toISOString() })
    .eq("id", m.id));
}

/** Copy every entry from one day onto another as planned meals. */
async function copyDay(fromDay, toDay) {
  const src = must(await sb.from("food_logs").select("*").eq("eaten_on", fromDay).order("eaten_at"));
  if (!src.length) throw new Error(`Nothing logged on ${fmtDay(fromDay)}.`);
  must(await sb.from("food_logs").insert(src.map((e) => ({
    eaten_on: toDay, meal: e.meal, description: e.description, grams: e.grams, kcal: e.kcal,
    protein_g: e.protein_g, carbs_g: e.carbs_g, fat_g: e.fat_g, fiber_g: e.fiber_g,
    source: "saved", confidence: e.confidence, food_id: e.food_id, items: e.items, status: "planned",
  }))));
  return src.length;
}

/** A food entry row: tap to open actions; ✓ marks a planned meal eaten; ★ saves it as a meal. */
function entryRow(e, after = render) {
  const planned = isPlanned(e);
  return h("div", { class: "entry" + (planned ? " planned" : "") },
    h("button", { class: "entry-main", onclick: () => openEntryActions(e, after) },
      h("span", { class: "desc" }, e.description),
      h("span", { class: "num muted" }, `${r0(e.kcal)} · P${r0(e.protein_g)}`)),
    planned
      ? h("button", {
          class: "entry-btn ate", title: "Ate it",
          onclick: (ev) => busy(ev.currentTarget, async () => { await markEaten(e); after(); }),
        }, "✓")
      : null,
    h("button", {
      class: "entry-btn", title: "Save as a meal",
      onclick: (ev) => busy(ev.currentTarget, () => quickSaveMeal(e)),
    }, "★"));
}

function openEntryActions(e, after = render) {
  const saveName = h("input", { value: e.description });
  const t = today();
  const planned = isPlanned(e);
  openSheet(e.description,
    h("div", { class: "note num" },
      planned ? "Planned · " : "",
      `${r0(e.kcal)} kcal · P ${r0(e.protein_g)} · C ${r0(e.carbs_g)} · F ${r0(e.fat_g)}`),
    planned
      ? h("button", {
          class: "btn",
          onclick: (ev) => busy(ev.currentTarget, async () => { await markEaten(e); closeSheet(); after(); }),
        }, "Ate it")
      : null,
    h("button", {
      class: "btn secondary",
      onclick: () => openFoodReview({
        title: planned ? "Edit planned meal" : "Edit entry", editId: e.id, items: entryItems(e),
        description: e.description, meal: e.meal, day: e.eaten_on, source: e.source,
        confidence: e.confidence, foodId: e.food_id, status: e.status || "eaten",
        afterSave: after === render ? null : after,
      }),
    }, planned ? "Change portions" : "Edit"),
    h("button", {
      class: "btn secondary",
      onclick: () => openFoodReview({
        title: "Log again", items: entryItems(e), description: e.description, meal: e.meal,
        day: t, source: "saved", status: "eaten",
      }),
    }, e.eaten_on === t ? "Log another" : "Log again today"),
    h("label", {}, "Save as a meal"),
    h("div", { class: "row" }, saveName,
      h("button", {
        class: "btn secondary", style: "width:auto",
        onclick: (ev) => busy(ev.currentTarget, async () => {
          must(await sb.from("saved_meals").upsert({ name: saveName.value.trim() || e.description, meal: e.meal, items: entryItems(e) }, { onConflict: "user_id,name" }));
          toast("Saved to Meals");
        }),
      }, "Save")),
    h("div", { style: "height:16px" }),
    h("button", {
      class: "btn danger",
      onclick: (ev) => busy(ev.currentTarget, async () => {
        must(await sb.from("food_logs").delete().eq("id", e.id));
        closeSheet();
        toast("Deleted");
        after();
      }),
    }, "Delete"),
  );
}

// ---------------------------------------------------------------------------
// AI feedback
// ---------------------------------------------------------------------------

function reviewCard(r, title) {
  return h("div", { class: "card stack" },
    h("h3", {}, title),
    h("div", {}, r.summary),
    ...(r.wins || []).map((w) => h("div", { class: "note" }, "✓ ", w)),
    ...(r.recommendations || []).map((x) => h("div", {}, h("b", {}, x.title), h("div", { class: "small muted" }, x.detail))),
    r.at ? h("div", { class: "small muted" }, `From ${fmtDay(r.at)}`) : null);
}

/** AI feedback on one day, counting planned meals as if eaten. */
async function dayFeedback(btn, day) {
  await busy(btn, async () => {
    const r = await callFn("ai", { mode: "review", today: day, days: 1 });
    openSheet(`Feedback · ${day === today() ? "Today" : fmtDay(day)}`, reviewCard(r, "What the AI sees"));
  });
}

// ---------------------------------------------------------------------------
// Meal planner
// ---------------------------------------------------------------------------

async function openMealPlanner(day = state.day) {
  const [logs, target, lastTarget, saved] = await Promise.all([
    sb.from("food_logs").select("*").eq("eaten_on", day).order("eaten_at"),
    sb.from("daily_targets").select("*").eq("for_date", day).maybeSingle(),
    sb.from("daily_targets").select("*").lte("for_date", day).order("for_date", { ascending: false }).limit(1).maybeSingle(),
    sb.from("saved_meals").select("*").order("use_count", { ascending: false }).order("name"),
  ]).then((rs) => rs.map(must));

  const tgt = target || lastTarget;
  const reopen = () => { render(); openMealPlanner(day); };
  const total = sumItems(logs.map((e) => ({ kcal: e.kcal, protein_g: e.protein_g, carbs_g: e.carbs_g, fat_g: e.fat_g })));
  const left = tgt ? tgt.kcal - total.kcal : null;

  const summary = h("div", { class: "card stack", style: "background:var(--card-2);margin-top:4px" },
    h("div", { class: "row" },
      h("div", {}, h("div", { class: "big num", style: "font-size:30px" }, r0(total.kcal)),
        h("div", { class: "small muted" }, tgt ? `of ${tgt.kcal} kcal planned and eaten` : "kcal planned and eaten")),
      tgt ? h("div", { style: "text-align:right" },
        h("div", { class: "num", style: `font-size:22px;font-weight:700;color:${left < 0 ? "var(--danger)" : "var(--accent)"}` }, r0(Math.abs(left))),
        h("div", { class: "small muted" }, left < 0 ? "kcal over" : "kcal to plan")) : null),
    bar("Protein", total.protein_g, tgt?.protein_g, "var(--protein)"),
    bar("Carbs", total.carbs_g, tgt?.carbs_g, "var(--carbs)"),
    bar("Fat", total.fat_g, tgt?.fat_g, "var(--fat)"),
    !target && lastTarget ? h("div", { class: "small muted" }, `Using the target from ${fmtDay(lastTarget.for_date)} until this day's is set.`) : null,
    !tgt ? h("div", { class: "small muted" }, "No targets yet. Tap Targets on the Day screen to get one.") : null);

  const copyFrom = h("input", { type: "date", value: addDays(day, -1) });
  const copyBtn = h("button", { class: "btn secondary", style: "width:auto;white-space:nowrap" }, "Copy day");
  copyBtn.addEventListener("click", () => busy(copyBtn, async () => {
    const n = await copyDay(copyFrom.value, day);
    toast(`Copied ${n} item${n === 1 ? "" : "s"} as planned`);
    reopen();
  }));

  const slots = MEALS.map((slot) => {
    const es = logs.filter((e) => e.meal === slot);
    const kcal = es.reduce((t, e) => t + Number(e.kcal), 0);
    return h("div", {},
      h("div", { class: "meal-head" }, h("span", {}, slot), h("span", { class: "num" }, es.length ? `${r0(kcal)} kcal` : "")),
      ...es.map((e) => entryRow(e, reopen)),
      h("button", { class: "add-slot", onclick: () => openAddToSlot(day, slot, saved, reopen) }, `+ Add ${slot}`));
  });

  openSheet(`Plan · ${day === today() ? "Today" : fmtDay(day)}`,
    summary,
    ...slots,
    h("button", { class: "btn secondary", style: "margin-top:12px", onclick: (ev) => dayFeedback(ev.currentTarget, day) }, "Check this plan with AI"),
    h("label", {}, "Repeat a whole day"),
    h("div", { class: "row" }, copyFrom, copyBtn),
    h("div", { class: "small muted", style: "margin-top:6px" }, "Planned meals don't count until you tap ✓ Ate it."));
}

function openAddToSlot(day, slot, saved, reopen) {
  const ctx = { day, meal: slot, status: "planned", afterSave: reopen };
  const forSlot = saved.filter((m) => m.meal === slot);
  const others = saved.filter((m) => m.meal !== slot);
  const row = (m) => {
    const t = sumItems(m.items);
    return h("div", { class: "entry" },
      h("button", {
        class: "entry-main",
        onclick: (ev) => busy(ev.currentTarget, async () => {
          await addSavedMealTo(m, day, slot, "planned");
          toast(`Planned ${m.name}`);
          reopen();
        }),
      }, h("span", { class: "desc" }, m.name), h("span", { class: "num muted" }, `${r0(t.kcal)} · P${r0(t.protein_g)}`)),
      h("button", {
        class: "entry-btn", title: "Change portions first",
        onclick: () => openFoodReview({ ...ctx, title: m.name, description: m.name, items: m.items, source: "saved", savedMeal: m }),
      }, "⚖"));
  };
  openSheet(`Add ${slot}`,
    saved.length
      ? h("div", { class: "small muted" }, "Tap a meal to plan it as is, or ⚖ to change portions first.")
      : h("div", { class: "small muted" }, "No saved meals yet. Build one below; it's saved for next time automatically."),
    ...forSlot.map(row),
    others.length && forSlot.length ? h("div", { class: "meal-head" }, h("span", {}, "Other saved meals")) : null,
    ...others.map(row),
    h("div", { style: "height:8px" }),
    h("button", { class: "btn secondary", onclick: () => openTypedFood(ctx) }, "Describe a new meal (AI)"),
    h("button", { class: "btn secondary", onclick: () => openFoodReview({ ...ctx, title: "Build a meal", source: "manual" }) }, "Enter numbers myself"),
    h("button", { class: "link", onclick: reopen }, "‹ Back to plan"));
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function ring(eaten, target) {
  const R = 50, C = 2 * Math.PI * R;
  const frac = target ? Math.min(1, eaten / target) : 0;
  const over = target && eaten > target;
  return s("svg", { viewBox: "0 0 120 120", width: 120, height: 120 },
    s("circle", { cx: 60, cy: 60, r: R, fill: "none", stroke: "var(--card-2)", "stroke-width": 12 }),
    s("circle", {
      cx: 60, cy: 60, r: R, fill: "none", stroke: over ? "var(--danger)" : "var(--accent)", "stroke-width": 12,
      "stroke-linecap": "round", "stroke-dasharray": `${C * frac} ${C}`, transform: "rotate(-90 60 60)",
    }),
  );
}

function bar(label, value, target, color) {
  const pct = target ? Math.min(100, (value / target) * 100) : 0;
  return h("div", { class: "bar-row num" },
    h("span", {}, label),
    h("div", { class: "bar" }, h("span", { style: `width:${pct}%;background:${color}` })),
    h("span", {}, target ? `${r0(value)}/${target}` : `${r0(value)} g`));
}

async function renderDay(view) {
  const d = state.day;
  const t = today();
  const isToday = d === t;
  const maxDay = addDays(t, 7); // plan up to a week ahead
  const [logs, works, target, metric, steps] = await Promise.all([
    sb.from("food_logs").select("*").eq("eaten_on", d).order("eaten_at"),
    sb.from("workouts").select("*").eq("done_on", d).order("started_at"),
    sb.from("daily_targets").select("*").eq("for_date", d).maybeSingle(),
    sb.from("body_metrics").select("*").eq("measured_on", d).maybeSingle(),
    sb.from("daily_activity").select("*").eq("day", d).maybeSingle(),
  ]).then((rs) => rs.map(must));

  const sum = (list) => list.reduce((acc, e) => {
    for (const k of ["kcal", "protein_g", "carbs_g", "fat_g"]) acc[k] += Number(e[k]) || 0;
    return acc;
  }, { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
  const eaten = sum(logs.filter((e) => !isPlanned(e)));
  const planned = sum(logs.filter(isPlanned));

  const targetCard = h("div", { class: "card" },
    h("div", { class: "target" },
      h("div", { style: "position:relative;width:120px;height:120px" },
        ring(eaten.kcal, target?.kcal),
        h("div", { style: "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center" },
          h("div", { class: "ring-label num" }, target ? r0(Math.abs(target.kcal - eaten.kcal)) : r0(eaten.kcal)),
          h("div", { class: "small muted" }, target ? (eaten.kcal > target.kcal ? "kcal over" : "kcal left") : "kcal eaten"))),
      h("div", { class: "bars" },
        bar("Protein", eaten.protein_g, target?.protein_g, "var(--protein)"),
        bar("Carbs", eaten.carbs_g, target?.carbs_g, "var(--carbs)"),
        bar("Fat", eaten.fat_g, target?.fat_g, "var(--fat)"),
        target
          ? h("div", { class: "small muted num" }, `${r0(eaten.kcal)} of ${target.kcal} kcal `, h("span", { class: "badge" }, target.method))
          : h("div", { class: "small muted" }, "No target for this day. Tap Targets the evening before."),
        planned.kcal
          ? h("div", { class: "small num", style: "color:var(--accent)" },
              `+ ${r0(planned.kcal)} planned → ${r0(eaten.kcal + planned.kcal)}${target ? ` of ${target.kcal}` : ""} kcal`)
          : null)));

  const act = (icon, label, fn) => h("button", { class: "action", onclick: fn }, h("b", {}, icon), label);
  const actions = h("div", { class: "actions" },
    act("▥", "Scan", () => openScan()),
    act("📷", "Photo", () => openPhotoFood()),
    act("✎", "Type", () => openTypedFood()),
    act("★", "Saved", () => openSavedPicker()),
    act("🗓", "Plan meals", (e) => busy(e.currentTarget, () => openMealPlanner(d))),
    act("🏋", "Workout", () => openWorkoutUpload()),
    act("⚖", "Weigh-in", () => openWeighIn()),
    act("👣", "Steps", () => openSteps()),
    act("✓", "Targets", (e) => runPlan(e.currentTarget)));

  const chips = h("div", { class: "chips" },
    metric ? h("button", { class: "chip num", onclick: openWeighIn }, `⚖ ${r1(metric.weight_kg)} kg${metric.body_fat_pct != null ? ` · ${metric.body_fat_pct}%` : ""}`) : null,
    steps ? h("button", { class: "chip num", onclick: openSteps }, `👣 ${Number(steps.steps).toLocaleString()} steps`) : null,
    ...works.map((w) => h("button", {
      class: "chip num",
      onclick: () => openSheet(w.type,
        h("div", { class: "note num" }, `${w.duration_s ? r0(w.duration_s / 60) + " min · " : ""}${w.kcal_used} kcal used${w.avg_hr ? ` · avg HR ${w.avg_hr}` : ""}${w.training_load ? ` · load ${w.training_load}` : ""}`),
        w.description ? h("p", {}, w.description) : null,
        h("button", {
          class: "btn danger",
          onclick: (ev) => busy(ev.currentTarget, async () => {
            must(await sb.from("workouts").delete().eq("id", w.id));
            closeSheet(); toast("Workout deleted"); render();
          }),
        }, "Delete workout")),
    }, `🏋 ${w.type} · ${w.kcal_used} kcal`)));

  const mealBlocks = MEALS.map((m) => {
    const es = logs.filter((e) => e.meal === m);
    if (!es.length) return null;
    const kcal = es.filter((e) => !isPlanned(e)).reduce((acc, e) => acc + Number(e.kcal), 0);
    const plannedKcal = es.filter(isPlanned).reduce((acc, e) => acc + Number(e.kcal), 0);
    return h("div", {},
      h("div", { class: "meal-head" }, h("span", {}, m),
        h("span", { class: "num" }, `${r0(kcal)} kcal${plannedKcal ? ` (+${r0(plannedKcal)} planned)` : ""}`)),
      ...es.map((e) => entryRow(e)));
  });

  const label = isToday ? `Today · ${fmtDay(d, { day: "numeric", month: "short" })}`
    : d === addDays(t, 1) ? `Tomorrow · ${fmtDay(d, { day: "numeric", month: "short" })}`
    : fmtDay(d);

  fill(view,
    h("div", { class: "day-nav" },
      h("button", { class: "icon-btn", "aria-label": "Previous day", onclick: () => { state.day = addDays(d, -1); render(); } }, "‹"),
      h("h1", {}, label),
      h("button", { class: "icon-btn", "aria-label": "Next day", disabled: d >= maxDay, onclick: () => { state.day = addDays(d, 1); render(); } }, "›")),
    targetCard,
    actions,
    chips,
    ...mealBlocks,
    logs.length ? null : h("p", { class: "muted", style: "text-align:center" }, d > t ? "Nothing planned yet. Tap Plan meals." : "Nothing logged yet."),
    logs.length ? h("button", { class: "btn secondary", style: "margin-top:12px", onclick: (ev) => dayFeedback(ev.currentTarget, d) }, "AI feedback on this day") : null,
    target?.notes ? h("div", { class: "note small" }, target.notes) : null,
  );
}

function weightChart(points) {
  // points: [{day, w}] sorted. Dots = weigh-ins; line = 7-day average.
  const W = 340, H = 170, P = { l: 34, r: 8, t: 10, b: 22 };
  const xs = points.map((p) => new Date(p.day + "T12:00:00").getTime());
  const ys = points.map((p) => p.w);
  const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1;
  const y0 = Math.floor(Math.min(...ys) - 0.5), y1 = Math.ceil(Math.max(...ys) + 0.5);
  const X = (t) => P.l + ((t - x0) / Math.max(1, x1 - x0)) * (W - P.l - P.r);
  const Y = (v) => P.t + (1 - (v - y0) / Math.max(0.1, y1 - y0)) * (H - P.t - P.b);

  const avg = points.map((p, i) => {
    const t = xs[i];
    const win = points.filter((_, j) => xs[j] <= t && xs[j] > t - 7 * 86400000);
    return [X(t), Y(win.reduce((a, q) => a + q.w, 0) / win.length)];
  });
  const ticks = [y0, (y0 + y1) / 2, y1];
  return s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart" },
    ...ticks.map((v) => [
      s("line", { x1: P.l, x2: W - P.r, y1: Y(v), y2: Y(v), stroke: "var(--line)", "stroke-width": 1 }),
      s("text", { x: P.l - 6, y: Y(v) + 4, "text-anchor": "end", "font-size": 10, fill: "var(--muted)" }, r1(v)),
    ]),
    s("polyline", { points: avg.map((p) => p.join(",")).join(" "), fill: "none", stroke: "var(--accent)", "stroke-width": 2.5, "stroke-linejoin": "round" }),
    ...points.map((p, i) => s("circle", { cx: X(xs[i]), cy: Y(p.w), r: 2.5, fill: "var(--muted)" })),
    s("text", { x: P.l, y: H - 6, "font-size": 10, fill: "var(--muted)" }, fmtDay(points[0].day, { day: "numeric", month: "short" })),
    s("text", { x: W - P.r, y: H - 6, "text-anchor": "end", "font-size": 10, fill: "var(--muted)" }, fmtDay(points.at(-1).day, { day: "numeric", month: "short" })),
  );
}

async function renderProgress(view) {
  const t = today();
  const [metrics, summary] = await Promise.all([
    sb.from("body_metrics").select("*").gte("measured_on", addDays(t, -120)).order("measured_on"),
    sb.from("daily_summary").select("*").gte("day", addDays(t, -13)).order("day", { ascending: false }),
  ]).then((rs) => rs.map(must));

  const weights = metrics.map((m) => ({ day: m.measured_on, w: Number(m.weight_kg) }));
  const bfs = metrics.filter((m) => m.body_fat_pct != null).map((m) => ({ day: m.measured_on, w: Number(m.body_fat_pct) }));

  const statsBox = h("div", { class: "stats" }, h("div", { class: "small muted" }, "Loading…"));

  // First and latest reading of each tape measurement
  const tape = [["waist_cm", "Waist"], ["neck_cm", "Neck"], ["hip_cm", "Hips"], ["chest_cm", "Chest"], ["arm_cm", "Arm"], ["thigh_cm", "Thigh"]]
    .map(([k, label]) => {
      const rows = metrics.filter((m) => m[k] != null);
      if (!rows.length) return null;
      const first = Number(rows[0][k]), last = Number(rows.at(-1)[k]);
      return { label, first, last, firstDay: rows[0].measured_on, lastDay: rows.at(-1).measured_on };
    })
    .filter(Boolean);
  const tapeCard = tape.length
    ? h("div", { class: "card" }, h("h3", {}, "Measurements"),
        h("table", { class: "num" },
          h("tr", {}, h("th", {}, ""), h("th", {}, "First"), h("th", {}, "Latest"), h("th", {}, "Change")),
          ...tape.map((m) => h("tr", {},
            h("td", {}, m.label),
            h("td", {}, r1(m.first)),
            h("td", {}, r1(m.last)),
            h("td", { style: `color:${m.last < m.first ? "var(--accent)" : m.last > m.first ? "var(--warn)" : "inherit"}` },
              `${m.last - m.first > 0 ? "+" : ""}${r1(m.last - m.first)}`)))),
        h("div", { class: "small muted", style: "margin-top:6px" }, "cm, over the last 4 months. Arms going up while waist comes down is the goal."))
    : null;
  const reviewBox = h("div");
  const reviewBtn = h("button", { class: "btn secondary" }, "Weekly review (AI)");

  const showReview = (r) => fill(reviewBox, reviewCard(r, "Weekly review"));

  try {
    const cached = JSON.parse(localStorage.getItem("tenth-review") || "null");
    if (cached) showReview(cached);
  } catch { /* storage unavailable */ }

  reviewBtn.addEventListener("click", () => busy(reviewBtn, async () => {
    const r = await callFn("ai", { mode: "review", today: t, days: 7 });
    r.at = t;
    try { localStorage.setItem("tenth-review", JSON.stringify(r)); } catch { /* fine */ }
    showReview(r);
  }));

  fill(view, 
    h("div", { class: "card" }, h("h3", {}, "Weight"),
      weights.length >= 2 ? weightChart(weights) : h("p", { class: "muted" }, "Two or more weigh-ins draw the chart."),
      h("div", { class: "small muted" }, "Dots are weigh-ins; the line is the 7-day average.")),
    bfs.length >= 2 ? h("div", { class: "card" }, h("h3", {}, "Body fat %"), weightChart(bfs)) : null,
    tapeCard,
    h("div", { class: "card" }, h("h3", {}, "Where you're heading"), statsBox),
    reviewBtn, reviewBox,
    h("div", { class: "card" }, h("h3", {}, "Last 14 days"),
      summary.length
        ? h("table", { class: "num" },
            h("tr", {}, h("th", {}, "Day"), h("th", {}, "Eaten"), h("th", {}, "Target"), h("th", {}, "Workout"), h("th", {}, "Steps"), h("th", {}, "kg")),
            ...summary.map((r) => h("tr", {},
              h("td", {}, fmtDay(r.day, { weekday: "short", day: "numeric" })),
              h("td", {}, r.food_entries ? r0(r.intake_kcal) : "–"),
              h("td", {}, r.target_kcal ?? "–"),
              h("td", {}, r.exercise_kcal ? r0(r.exercise_kcal) : "–"),
              h("td", {}, r.steps != null ? (r.steps / 1000).toFixed(1) + "k" : "–"),
              h("td", {}, r.weight_kg != null ? r1(r.weight_kg) : "–"))))
        : h("p", { class: "muted" }, "Nothing logged yet.")),
  );

  // Timeline without saving a target
  try {
    const p = await callFn("plan", { today: t, for_date: addDays(t, 1), save: false });
    const stat = (val, label) => h("div", { class: "stat num" }, h("b", {}, val), h("span", {}, label));
    fill(statsBox, 
      stat(`${p.detail.weight_used_kg}`, "kg (trend)"),
      stat(p.detail.trend_kg_per_week != null ? `${p.detail.trend_kg_per_week}` : "–", "kg / week"),
      stat(p.detail.body_fat_pct_used != null ? `${p.detail.body_fat_pct_used}%` : "–", "body fat"),
      stat(p.timeline ? `${p.timeline.goal_weight_kg}` : "–", "goal kg"),
      stat(p.timeline ? `${p.timeline.weeks}` : "–", "weeks left"),
      stat(p.timeline ? fmtDay(p.timeline.eta, { day: "numeric", month: "short" }) : "–", "ETA"),
    );
    if (!p.timeline) statsBox.after(h("div", { class: "small muted" }, "Add waist and neck to a weigh-in to get the timeline."));
  } catch (e) {
    fill(statsBox, h("div", { class: "small muted", style: "grid-column:1/-1" }, e.message));
  }
}

async function renderMeals(view) {
  const meals = must(await sb.from("saved_meals").select("*").order("name"));
  fill(view, 
    h("h1", { style: "font-size:20px;margin:8px 0" }, "Saved meals"),
    h("p", { class: "small muted" }, "Tap to log; change any item's grams before saving and everything rescales."),
    ...(meals.length ? meals.map((m) => {
      const t = sumItems(m.items);
      return h("div", { class: "card" },
        h("div", { class: "row" },
          h("div", {}, h("b", {}, m.name), h("div", { class: "small muted num" },
            `${m.meal ? cap(m.meal) + " · " : ""}${r0(t.kcal)} kcal · P ${r0(t.protein_g)} · used ${m.use_count}×`)),
          h("button", { class: "btn", style: "width:auto;padding:10px 16px", onclick: () => logSavedMeal(m) }, "Log")),
        h("div", { class: "small muted", style: "margin-top:6px" }, m.items.map((i) => `${i.name} ${r0(i.grams)} g`).join(", ")),
        h("button", {
          class: "link", style: "color:var(--danger)",
          onclick: (ev) => busy(ev.currentTarget, async () => {
            must(await sb.from("saved_meals").delete().eq("id", m.id));
            toast("Removed"); render();
          }),
        }, "Remove"));
    }) : [h("p", { class: "muted" }, "None yet. Tick “Save as a meal” when logging, or use Save as meal on any entry.")]),
  );
}

async function renderSettings(view) {
  const p = state.profile || {};
  const v = {
    sex: p.sex || "male",
    birth_date: p.birth_date || "",
    height_cm: p.height_cm ?? "",
    target_bf_pct: p.target_bf_pct ?? 10,
    loss_rate_pct: p.loss_rate_pct ?? 0.5,
    protein_g_per_kg: p.protein_g_per_kg ?? 2.0,
    fat_g_per_kg: p.fat_g_per_kg ?? 0.8,
    activity_factor: p.activity_factor ?? 1.35,
    max_hr: p.max_hr ?? "",
  };
  const field = (key, label, type = "number", extra = {}) =>
    h("div", {}, h("label", {}, label), h("input", {
      type, inputmode: type === "number" ? "decimal" : null, step: "any", value: v[key], ...extra,
      oninput: (e) => (v[key] = e.target.value),
    }));
  const sex = h("select", { value: v.sex, onchange: (e) => (v.sex = e.target.value) },
    h("option", { value: "male" }, "Male"), h("option", { value: "female" }, "Female"));
  const save = h("button", { class: "btn" }, "Save profile");
  save.addEventListener("click", () => busy(save, async () => {
    if (!v.birth_date || !numOrNull(v.height_cm)) throw new Error("Birth date and height are needed.");
    const row = {
      sex: v.sex, birth_date: v.birth_date, height_cm: Number(v.height_cm),
      target_bf_pct: Number(v.target_bf_pct), loss_rate_pct: Number(v.loss_rate_pct),
      protein_g_per_kg: Number(v.protein_g_per_kg), fat_g_per_kg: Number(v.fat_g_per_kg),
      activity_factor: Number(v.activity_factor), max_hr: numOrNull(v.max_hr),
    };
    state.profile = must(await sb.from("profile").upsert(row, { onConflict: "user_id" }).select().single());
    toast("Profile saved");
  }));

  const exportBtn = h("button", { class: "btn secondary" }, "Export all data (JSON)");
  exportBtn.addEventListener("click", () => busy(exportBtn, async () => {
    const tables = ["profile", "body_metrics", "daily_activity", "foods", "food_logs", "saved_meals", "workouts", "daily_targets"];
    const out = { exported_at: new Date().toISOString() };
    for (const t of tables) out[t] = must(await sb.from(t).select("*"));
    const blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `tenth-backup-${today()}.json` });
    document.body.append(a); a.click(); a.remove();
  }));

  const installBtn = state.installPrompt
    ? h("button", { class: "btn secondary", onclick: async () => { state.installPrompt.prompt(); state.installPrompt = null; render(); } }, "Install app on this phone")
    : null;

  fill(view, 
    h("div", { class: "card" },
      h("h3", {}, "Profile"),
      !state.profile ? h("div", { class: "warn" }, "Fill this in first; the plan needs it.") : null,
      h("div", { class: "grid-2" }, h("div", {}, h("label", {}, "Sex"), sex), field("birth_date", "Birth date", "date")),
      h("div", { class: "grid-2" }, field("height_cm", "Height cm"), field("max_hr", "Max heart rate (observed)")),
      h("div", { class: "grid-2" }, field("target_bf_pct", "Target body fat %"), field("loss_rate_pct", "Loss rate % of weight / week")),
      h("div", { class: "small muted" }, "0.5% a week is gentle on muscle; 1.0% is the fastest allowed."),
      h("div", { class: "grid-3" }, field("protein_g_per_kg", "Protein g/kg"), field("fat_g_per_kg", "Fat g/kg"), field("activity_factor", "Daily movement")),
      h("div", { class: "small muted" }, "Daily movement covers life outside logged workouts: 1.2 desk job, 1.35 on your feet some of the day, 1.5 on your feet most of it."),
      h("div", { style: "height:10px" }), save),
    h("div", { class: "card stack" },
      h("h3", {}, "App"),
      installBtn,
      !installBtn ? h("div", { class: "small muted" }, "To install: Chrome menu ⋮ → Add to Home screen (or Install app). Once installed, it shows up in the Android share sheet for Mi Fitness images.") : null,
      exportBtn,
      h("button", { class: "btn danger", onclick: async () => { await sb.auth.signOut(); } }, "Sign out")),
  );
}

function renderSignIn(view) {
  const email = h("input", { type: "email", autocomplete: "username", placeholder: "Email" });
  const pass = h("input", { type: "password", autocomplete: "current-password", placeholder: "Password" });
  const go = h("button", { class: "btn" }, "Sign in");
  go.addEventListener("click", () => busy(go, async () => {
    const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
    if (error) throw new Error(error.message);
  }));
  pass.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
  fill(view, 
    h("div", { class: "card stack", style: "margin-top:40px" },
      h("h1", {}, APP_NAME),
      h("p", { class: "muted" }, "Sign in with the account you created in Supabase."),
      email, pass, go));
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const view = document.getElementById("view");
const tabs = document.getElementById("tabs");

async function render() {
  document.getElementById("brand").textContent = APP_NAME;
  if (!state.session) {
    tabs.hidden = true;
    renderSignIn(view);
    return;
  }
  tabs.hidden = false;
  for (const b of tabs.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === state.tab);
  try {
    if (state.tab === "day") await renderDay(view);
    else if (state.tab === "progress") await renderProgress(view);
    else if (state.tab === "meals") await renderMeals(view);
    else await renderSettings(view);
  } catch (e) {
    fill(view, h("div", { class: "warn" }, e.message || String(e)));
  }
}

tabs.addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b) return;
  state.tab = b.dataset.tab;
  if (state.tab === "day") state.day = today();
  window.scrollTo(0, 0);
  render();
});

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  state.installPrompt = e;
});

/** An image shared from another app arrives via the service worker. */
async function handleSharedImage() {
  const params = new URLSearchParams(location.search);
  if (!params.has("shared")) return;
  history.replaceState(null, "", location.pathname);
  try {
    const cache = await caches.open("tenth-shared");
    const key = new URL("./__shared-image", location.href).href;
    const res = await cache.match(key);
    if (!res) return;
    await cache.delete(key);
    const blob = await res.blob();
    const name = decodeURIComponent(res.headers.get("X-File-Name") || "shared.jpg");
    const file = new File([blob], name, { type: blob.type || "image/jpeg" });
    openSheet("Shared image",
      h("p", { class: "muted" }, "What is it?"),
      h("button", { class: "btn", onclick: () => openWorkoutUpload(file) }, "Workout (Mi Fitness)"),
      h("button", { class: "btn secondary", onclick: () => openPhotoFood(file) }, "Food photo"),
      h("button", { class: "btn secondary", onclick: () => openLabelCapture(null) }, "Nutrition label"));
  } catch (e) {
    toast("Couldn't open the shared image: " + e.message, true);
  }
}

async function loadProfile() {
  state.profile = must(await sb.from("profile").select("*").maybeSingle());
  if (!state.profile) state.tab = "settings";
}

sb.auth.onAuthStateChange(async (event, session) => {
  const wasSignedIn = !!state.session;
  state.session = session;
  if (session && !wasSignedIn) {
    // Supabase recommends not awaiting other Supabase calls inside this callback
    setTimeout(async () => {
      try { await loadProfile(); } catch (e) { toast(e.message, true); }
      await render();
      handleSharedImage();
    }, 0);
  } else if (!session) {
    state.profile = null;
    render();
  }
});

// Wait for Supabase to report the saved session before drawing anything
fill(view, h("p", { class: "muted", style: "text-align:center;margin-top:40px" }, "Loading…"));
