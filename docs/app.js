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
  tab: "today",
  foodTab: "saved",
  progressTab: "goal",
  goal: null,
  thread: null,
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
  toast.timer = setTimeout(() => (t.className = "toast"), isError ? 12000 : 2500);
  t.onclick = () => (t.className = "toast"); // tap to dismiss
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

/** Call an Edge Function; show its real error and status, and give up after 60 seconds. */
async function callFn(name, body, timeoutMs = 90000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} took longer than ${timeoutMs / 1000} s. Check the function's logs in Supabase.`)), timeoutMs);
  });
  try {
    const { data, error } = await Promise.race([sb.functions.invoke(name, { body }), timeout]);
    if (error) {
      let msg = error.message;
      const res = error.context;
      if (res && typeof res.text === "function") {
        let text = "";
        try { text = await res.text(); } catch { /* body already read */ }
        try {
          const j = JSON.parse(text);
          msg = j.error || j.message || j.msg || text;
        } catch {
          if (text) msg = text.slice(0, 200);
        }
        msg = `${name}: ${msg} (status ${res.status})`;
      }
      throw new Error(msg);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
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

/** Breakfast / Lunch / Dinner / Snack buttons. Returns the element; read .value for the choice. */
function mealChooser(initial = guessMeal()) {
  const wrap = h("div", { class: "segmented", role: "radiogroup", "aria-label": "Meal" });
  wrap.value = initial;
  const draw = () => fill(wrap, ...MEALS.map((m) => h("button", {
    type: "button", role: "radio", "aria-checked": String(wrap.value === m),
    class: wrap.value === m ? "on" : null,
    onclick: () => { wrap.value = m; draw(); },
  }, cap(m))));
  draw();
  return wrap;
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

  // Correct the meal in words and let the AI recalculate from the current items
  const change = h("textarea", { placeholder: "e.g. it was 200 g chicken, not 150 · add 1 tbsp olive oil · swap rice for 150 g potatoes", style: "min-height:60px" });
  const reestimate = h("button", { class: "btn secondary", type: "button" }, "Re-estimate with AI");
  reestimate.addEventListener("click", () => busy(reestimate, async () => {
    const note = change.value.trim();
    if (!note) throw new Error("Say what to change first.");
    const out = await callFn("ai", { mode: "revise", items: cleanItems(items), note, meal: meal.value, day: date.value || state.day });
    openFoodReview({
      ...opts,
      items: out.items, warnings: out.warnings, assumptions: out.assumptions, confidence: out.confidence,
      balanceTip: out.balance_tip, question: null,
      description: desc.value, meal: meal.value, day: date.value, status: planned.checked ? "planned" : "eaten",
      title: "Re-estimated",
    });
  }));

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
    opts.balanceTip ? h("div", { class: "note", style: "border-left:3px solid var(--accent)" }, "⚖ ", opts.balanceTip) : null,
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
    h("details", { style: "margin:4px 0 8px" },
      h("summary", { class: "muted" }, "Change it and re-estimate"),
      change, h("div", { style: "height:8px" }), reestimate),
    opts.savedMeal ? null : h("label", { class: "check" }, saveAs, "Save as a meal for next time"),
    saveName,
    h("div", { style: "height:8px" }),
    saveBtn,
  );
}

// ---------------------------------------------------------------------------
// Food: photo, typed, saved, barcode
// ---------------------------------------------------------------------------

function openPhotoFood(initialFile, ctx = {}) {
  let img = null;
  const meal = mealChooser(ctx.meal || guessMeal());
  const day = ctx.day || state.day;
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
    const out = await callFn("ai", { mode: "food_photo", image: img.data, mime_type: img.mime, note: fullNote, meal: meal.value, day });
    note.value = fullNote;
    openFoodReview({
      ...ctx,
      title: "Check the estimate",
      items: out.items, confidence: out.confidence, assumptions: out.assumptions, warnings: out.warnings,
      question: out.question, rerun: (ans) => run(ans), source: "photo",
      meal: meal.value, day, balanceTip: out.balance_tip,
    });
  };
  go.addEventListener("click", () => busy(go, () => run()));

  openSheet("Food photo",
    h("label", {}, "Which meal?"), meal,
    h("div", { style: "height:10px" }),
    picker(setFile), preview,
    h("label", {}, "What's in it (weights make it far more accurate)"), note,
    h("div", { style: "height:10px" }), go);
  if (initialFile) setFile(initialFile);
}

function openTypedFood(ctx = {}) {
  const meal = mealChooser(ctx.meal || guessMeal());
  const day = ctx.day || state.day;
  const note = h("textarea", { placeholder: "e.g. 2 eggs scrambled in 5 g butter, 1 slice sourdough 40 g, 150 g Greek yogurt 2%" });
  const go = h("button", { class: "btn" }, "Estimate");
  const run = async (extra = "") => {
    const text = [note.value.trim(), extra && `Answer to your question: ${extra}`].filter(Boolean).join("\n");
    if (!text) throw new Error("Describe the meal first.");
    const out = await callFn("ai", { mode: "food_text", note: text, meal: meal.value, day });
    note.value = text;
    openFoodReview({
      ...ctx,
      title: "Check the estimate",
      items: out.items, confidence: out.confidence, assumptions: out.assumptions, warnings: out.warnings,
      question: out.question, rerun: (ans) => run(ans), source: "text",
      meal: meal.value, day, balanceTip: out.balance_tip,
    });
  };
  go.addEventListener("click", () => busy(go, () => run()));
  openSheet("Type a meal",
    h("label", {}, "Which meal?"), meal,
    h("label", {}, "What did you eat?"), note,
    h("div", { style: "height:10px" }), go,
    h("button", { class: "link", onclick: () => openFoodReview({ title: "Enter numbers", source: "manual", ...ctx, meal: meal.value, day }) }, "Or enter the numbers yourself"));
}

async function openSavedPicker(slot = null, ctx = {}) {
  const meals = must(await sb.from("saved_meals").select("*").order("last_used_at", { ascending: false, nullsFirst: false }).order("name"));
  if (!meals.length) {
    openSheet("Saved meals", h("p", { class: "muted" }, "No saved meals yet. Tap ★ on a meal, or keep “Save as a meal” ticked when you log something."));
    return;
  }
  const first = slot || guessMeal();
  const groups = [first, ...MEALS.filter((m) => m !== first), null];
  openSheet(slot ? `Saved · ${cap(slot)}` : "Saved meals",
    ...groups.map((g) => {
      const list = meals.filter((m) => (m.meal || null) === g);
      if (!list.length) return null;
      return h("div", {},
        h("div", { class: "meal-head" }, h("span", {}, g ? g : "Unsorted")),
        ...list.map((m) => savedMealRow(m, { ...ctx, meal: slot || m.meal || guessMeal() })));
    }));
}

function savedMealRow(m, ctx = {}) {
  const t = sumItems(m.items);
  return h("button", { class: "entry", style: "padding:12px 14px;justify-content:space-between", onclick: () => logSavedMeal(m, ctx) },
    h("span", { class: "desc" }, m.name, h("div", { class: "small muted" }, m.items.length > 1 ? `${m.items.length} items · P ${r0(t.protein_g)}` : `P ${r0(t.protein_g)}`)),
    h("span", { class: "num" }, `${r0(t.kcal)} kcal`));
}

function logSavedMeal(m, ctx = {}) {
  openFoodReview({
    title: m.name,
    description: m.name,
    items: m.items,
    meal: ctx.meal || m.meal || guessMeal(),
    day: ctx.day,
    status: ctx.status,
    afterSave: ctx.afterSave,
    source: "saved",
    savedMeal: m,
  });
}

/** Rename, re-categorise, re-weigh or re-estimate a saved meal. */
function openSavedMealEdit(m) {
  const items = m.items.map((i) => ({ ...i }));
  const name = h("input", { value: m.name });
  const cat = h("select", { value: m.meal || "" },
    h("option", { value: "" }, "Unsorted"), ...MEALS.map((x) => h("option", { value: x }, cap(x))));
  const editorBox = h("div", {}, itemsEditor(items));
  const change = h("textarea", { placeholder: "e.g. use 80 g oats · add 10 g honey", style: "min-height:60px" });
  const re = h("button", { class: "btn secondary", type: "button" }, "Re-estimate with AI");
  re.addEventListener("click", () => busy(re, async () => {
    if (!change.value.trim()) throw new Error("Say what to change first.");
    const out = await callFn("ai", { mode: "revise", items: cleanItems(items), note: change.value.trim() });
    items.splice(0, items.length, ...out.items);
    fill(editorBox, itemsEditor(items));
    change.value = "";
    if (out.warnings?.length) toast(out.warnings[0], true);
  }));
  const save = h("button", { class: "btn" }, "Save meal");
  save.addEventListener("click", () => busy(save, async () => {
    const clean = cleanItems(items);
    if (!clean.length) throw new Error("A meal needs at least one item.");
    must(await sb.from("saved_meals").update({ name: name.value.trim() || m.name, meal: cat.value || null, items: clean }).eq("id", m.id));
    closeSheet(); toast("Saved meal updated"); render();
  }));
  openSheet("Edit saved meal",
    h("div", { class: "grid-2" }, h("div", {}, h("label", {}, "Name"), name), h("div", {}, h("label", {}, "Category"), cat)),
    h("label", {}, "Items (change grams to rescale)"), editorBox,
    h("details", { style: "margin:4px 0 8px" }, h("summary", { class: "muted" }, "Change it and re-estimate"), change, h("div", { style: "height:8px" }), re),
    save,
    h("button", {
      class: "btn danger",
      onclick: (ev) => busy(ev.currentTarget, async () => {
        must(await sb.from("saved_meals").delete().eq("id", m.id));
        closeSheet(); toast("Removed"); render();
      }),
    }, "Delete saved meal"));
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
    // The band may already have recorded this session: merge into it rather than double-count
    let merged = false;
    if (row.started_at) {
      const t0 = new Date(row.started_at).getTime();
      const near = must(await sb.from("workouts").select("id, source")
        .gte("started_at", new Date(t0 - 20 * 60000).toISOString())
        .lte("started_at", new Date(t0 + 20 * 60000).toISOString())
        .neq("status", "dismissed").limit(1));
      if (near.length) {
        const { started_at, ...rest } = row;
        must(await sb.from("workouts").update({ ...rest, status: "confirmed", kcal_locked: true }).eq("id", near[0].id));
        merged = true;
      }
    }
    if (!merged) {
      const { error } = await sb.from("workouts").insert({ ...row, kcal_locked: true });
      if (error?.code === "23505") throw new Error("That workout is already saved.");
      if (error) throw new Error(error.message);
    }
    closeSheet();
    toast(merged ? `Merged with the band's session: ${row.kcal_used} kcal` : `Workout saved: ${row.kcal_used} kcal`);
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
      h("button", { class: "btn secondary", onclick: (ev) => fineTuneTargets(ev.currentTarget, state.day, forDate) }, "Fine-tune macros with AI"),
    );
  });
}

/** Ask the AI to reshape the math target; save only if you accept. */
async function fineTuneTargets(btn, day, forDate) {
  await busy(btn, async () => {
    const r = await callFn("ai", { mode: "targets", today: day, for_date: forDate });
    const row = (label, a, b, unit) => h("tr", {},
      h("td", {}, label), h("td", {}, `${a}${unit}`), h("td", {}, `${b}${unit}`),
      h("td", { style: `color:${b > a ? "var(--accent)" : b < a ? "var(--warn)" : "inherit"}` }, b === a ? "–" : `${b > a ? "+" : ""}${b - a}`));
    const use = h("button", { class: "btn" }, "Use these");
    use.addEventListener("click", () => busy(use, async () => {
      must(await sb.from("daily_targets").update({
        kcal: r.suggested.kcal, protein_g: r.suggested.protein_g, carbs_g: r.suggested.carbs_g, fat_g: r.suggested.fat_g,
        source: "ai", ai_reason: r.reason || null,
      }).eq("for_date", forDate));
      closeSheet();
      toast("AI-tuned targets saved");
      render();
    }));
    openSheet(`AI targets · ${fmtDay(forDate)}`,
      h("div", { class: "note" }, r.reason || "No reason given."),
      h("table", { class: "num" },
        h("tr", {}, h("th", {}, ""), h("th", {}, "Math"), h("th", {}, "AI"), h("th", {}, "Change")),
        row("Calories", r.math.kcal, r.suggested.kcal, ""),
        row("Protein", r.math.protein_g, r.suggested.protein_g, " g"),
        row("Carbs", r.math.carbs_g, r.suggested.carbs_g, " g"),
        row("Fat", r.math.fat_g, r.suggested.fat_g, " g")),
      h("div", { style: "display:flex;gap:16px;align-items:center;margin:12px 0" },
        donut(macroParts(r.suggested), 110, `${r.suggested.kcal}`, "kcal"),
        macroLegend(macroParts(r.suggested))),
      ...(r.guardrails || []).map((g) => h("div", { class: "small muted" }, "Guardrail: ", g)),
      h("div", { style: "height:8px" }),
      use,
      h("button", { class: "btn secondary", onclick: closeSheet }, "Keep the math targets"));
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
    h("button", { class: "btn secondary", onclick: () => openPhotoFood(null, ctx) }, "Photo of a new meal (AI)"),
    h("button", { class: "btn secondary", onclick: () => openFoodReview({ ...ctx, title: "Build a meal", source: "manual" }) }, "Enter numbers myself"),
    h("button", { class: "link", onclick: reopen }, "‹ Back to plan"));
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const MACROS = [
  { key: "protein_g", label: "Protein", kcalPerG: 4, color: "var(--protein)" },
  { key: "carbs_g", label: "Carbs", kcalPerG: 4, color: "var(--carbs)" },
  { key: "fat_g", label: "Fat", kcalPerG: 9, color: "var(--fat)" },
];

/** Macro grams -> slices by calories, with each macro's share of the total. */
function macroParts(m, target = null) {
  const kcals = MACROS.map((x) => (Number(m[x.key]) || 0) * x.kcalPerG);
  const total = kcals.reduce((a, b) => a + b, 0);
  const tKcals = target ? MACROS.map((x) => (Number(target[x.key]) || 0) * x.kcalPerG) : null;
  const tTotal = tKcals ? tKcals.reduce((a, b) => a + b, 0) : 0;
  return MACROS.map((x, i) => ({
    ...x,
    grams: Number(m[x.key]) || 0,
    value: kcals[i],
    pct: total ? Math.round((kcals[i] / total) * 100) : 0,
    targetPct: tTotal ? Math.round((tKcals[i] / tTotal) * 100) : null,
    targetGrams: target ? Number(target[x.key]) || 0 : null,
  }));
}

/** Donut chart: slices separated by a thin gap, centre label. */
function donut(parts, size = 120, centre = "", sub = "") {
  const R = size / 2 - 9, C = 2 * Math.PI * R, cx = size / 2;
  const total = parts.reduce((a, p) => a + p.value, 0);
  const gap = total ? 2 : 0;
  let offset = 0;
  const arcs = total
    ? parts.filter((p) => p.value > 0).map((p) => {
        const len = (p.value / total) * C;
        const arc = s("circle", {
          cx, cy: cx, r: R, fill: "none", stroke: p.color, "stroke-width": 16,
          "stroke-dasharray": `${Math.max(0, len - gap)} ${C}`, "stroke-dashoffset": -offset,
          transform: `rotate(-90 ${cx} ${cx})`,
        }, s("title", {}, `${p.label}: ${r0(p.grams)} g, ${p.pct}% of calories`));
        offset += len;
        return arc;
      })
    : [s("circle", { cx, cy: cx, r: R, fill: "none", stroke: "var(--card-2)", "stroke-width": 16 })];
  return s("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: "img", "aria-label": parts.map((p) => `${p.label} ${p.pct}%`).join(", ") },
    ...arcs,
    s("text", { x: cx, y: cx + 2, "text-anchor": "middle", "font-size": 18, "font-weight": 700, fill: "var(--text)" }, centre),
    sub ? s("text", { x: cx, y: cx + 18, "text-anchor": "middle", "font-size": 10, fill: "var(--muted)" }, sub) : null);
}

/** Legend beside a donut: swatch, grams, share of calories, and the target share when known. */
function macroLegend(parts) {
  return h("div", { class: "legend" },
    ...parts.map((p) => h("div", { class: "legend-row num" },
      h("span", { class: "swatch", style: `background:${p.color}` }),
      h("span", { class: "legend-label" }, p.label),
      h("span", {}, `${r0(p.grams)} g`),
      h("b", {}, `${p.pct}%`),
      p.targetPct != null ? h("span", { class: "muted small" }, `goal ${p.targetPct}%`) : null)));
}

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

// ---------------------------------------------------------------------------
// Icons (stroke SVG)
// ---------------------------------------------------------------------------

const ICONS = {
  plus: ["M12 5v14M5 12h14"],
  chevL: ["M15 6l-6 6 6 6"],
  chevR: ["M9 6l6 6-6 6"],
  settings: ["M4 7h10M18 7h2M4 17h4M12 17h8", { c: [16, 7, 2] }, { c: [10, 17, 2] }],
  today: [{ c: [12, 12, 8] }, { c: [12, 12, 3] }],
  food: ["M7 3v8a2 2 0 0 0 4 0V3M9 11v10M17 21V3c-2 1-3 4-3 7h3"],
  progress: ["M3 17l6-6 4 4 8-8M15 7h6v6"],
  coach: ["M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"],
  moon: ["M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"],
  heart: ["M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"],
  steps: ["M4 16v-2.4C4 11.5 3 10.5 3 8c0-2.7 1.5-6 4.5-6C9.4 2 10 3.8 10 5.5c0 3.1-2 5.7-2 8.7V16a2 2 0 1 1-4 0z",
          "M20 20v-2.4c0-2.1 1-3.1 1-5.6 0-2.7-1.5-6-4.5-6C14.6 6 14 7.8 14 9.5c0 3.1 2 5.7 2 8.7V20a2 2 0 1 0 4 0z"],
  dumbbell: ["M6.5 6.5v11M17.5 6.5v11M3 9v6M21 9v6M6.5 12h11"],
  star: ["M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"],
  camera: ["M4 8h3l2-3h6l2 3h3v11H4z", { c: [12, 13, 3.5] }],
  pencil: ["M4 20h4L19 9l-4-4L4 16z"],
  barcode: ["M4 6v12M7 6v12M11 6v12M14 6v12M17 6v12M20 6v12"],
  calendar: ["M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"],
  scale: ["M5 20h14M12 4v16M6 8h12M6 8l-3 6h6zM18 8l-3 6h6z"],
  target: [{ c: [12, 12, 8] }, { c: [12, 12, 4] }, { c: [12, 12, 0.8] }],
  send: ["M5 12h14M13 6l6 6-6 6"],
  check: ["M5 12l5 5 9-10"],
};

function icon(name, size = 20, sw = 2) {
  return s("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": sw,
    "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
    ...(ICONS[name] || []).map((p) => typeof p === "string" ? s("path", { d: p }) : s("circle", { cx: p.c[0], cy: p.c[1], r: p.c[2] })));
}

const localTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const minsToHM = (m) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}`;
const SLOT_TIME = { breakfast: "07:00", lunch: "13:00", snack: "16:00", dinner: "19:30" };

// ---------------------------------------------------------------------------
// Goal maths (shared by the Today strip and the Goal screen)
// ---------------------------------------------------------------------------

/** Plan output (no saving) plus milestones, cached per day. */
async function goalInfo(force = false) {
  const t = today();
  if (!force && state.goal?.day === t) return state.goal;
  const [p, firstBf] = await Promise.all([
    callFn("plan", { today: t, for_date: addDays(t, 1), save: false }),
    sb.from("body_metrics").select("measured_on, weight_kg, body_fat_pct").not("body_fat_pct", "is", null)
      .order("measured_on").limit(1).maybeSingle().then(must),
  ]);
  const prof = state.profile || {};
  const target = Number(prof.target_bf_pct ?? 10);
  const rate = Number(prof.loss_rate_pct ?? 0.5);
  const weight = p.detail.weight_used_kg;
  const bf = p.detail.body_fat_pct_used;
  const info = { day: t, plan: p, target, rate, weight, bf, start: firstBf };
  if (bf != null) {
    const lean = weight * (1 - bf / 100);
    info.lean = lean;
    info.goalWeight = lean / (1 - target / 100);
    const weeksTo = (w) => Math.log(weight / w) / -Math.log(1 - rate / 100);
    const eta = p.timeline?.eta;
    info.milestones = [15, 12, target]
      .filter((x, i, arr) => x < bf && x >= target && arr.indexOf(x) === i)
      .map((x) => {
        const w = lean / (1 - x / 100);
        // the goal itself uses the plan's own date so every screen agrees
        return { pct: x, weight: x === target && p.timeline ? p.timeline.goal_weight_kg : w, date: x === target && eta ? eta : addDays(t, Math.ceil(weeksTo(w) * 7)) };
      });
    if (firstBf) {
      info.startBf = Number(firstBf.body_fat_pct);
      info.startLean = Number(firstBf.weight_kg) * (1 - info.startBf / 100);
      const span = info.startBf - target;
      info.fraction = span > 0 ? Math.max(0, Math.min(1, (info.startBf - bf) / span)) : 1;
    }
    const planned = -(weight * rate) / 100;
    const actual = p.detail.trend_kg_per_week;
    info.plannedPace = planned;
    info.pace = actual;
    info.status = actual == null ? "Building trend"
      : actual <= planned * 1.4 ? "Faster than planned"
      : actual <= planned * 0.7 ? "On pace"
      : "Behind plan";
  }
  state.goal = info;
  return info;
}

function goalBar(info, height = 8) {
  const span = (info.startBf ?? info.bf) - info.target;
  const pos = (x) => span > 0 ? Math.max(0, Math.min(100, (((info.startBf ?? info.bf) - x) / span) * 100)) : 100;
  return h("div", { class: "goalbar", style: `height:${height}px` },
    h("span", { class: "goalbar-fill", style: `width:${Math.max(2, (info.fraction ?? 0) * 100)}%` }),
    ...(info.milestones || []).filter((m) => m.pct !== info.target).map((m) => h("i", { class: "goalbar-tick", style: `left:${pos(m.pct)}%` })));
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

/** First open of a day: make today's target from yesterday's data; redo it if yesterday changed since. */
async function ensureTodayTarget(target, yesterdayWorkoutsChangedAt) {
  const t = today();
  state.autoTarget ??= {};
  if (state.autoTarget[t] === "busy" || !state.profile) return false;
  const stale = target && target.source === "math" && yesterdayWorkoutsChangedAt && yesterdayWorkoutsChangedAt > target.created_at
    && state.autoTarget[t + ":stale"] !== yesterdayWorkoutsChangedAt;
  if (target && !stale) return false;
  if (!target && state.autoTarget[t] === "done") return false;
  if (stale) state.autoTarget[t + ":stale"] = yesterdayWorkoutsChangedAt;
  state.autoTarget[t] = "busy";
  try {
    await callFn("plan", { today: addDays(t, -1), for_date: t });
    state.autoTarget[t] = "done";
    state.goal = null;
    return true;
  } catch (e) {
    state.autoTarget[t] = "done";
    if (!/weigh-in|profile/i.test(e.message)) toast(e.message, true);
    return false;
  }
}

async function renderToday(view) {
  const d = state.day;
  const t = today();
  const isToday = d === t;
  const yday = addDays(d, -1);
  const [logs, works, target, metric, act, sleepRec, yWorks, recent] = await Promise.all([
    sb.from("food_logs").select("*").eq("eaten_on", d).order("eaten_at"),
    sb.from("workouts").select("*").eq("done_on", d).neq("status", "dismissed").order("started_at"),
    sb.from("daily_targets").select("*").eq("for_date", d).maybeSingle(),
    sb.from("body_metrics").select("*").eq("measured_on", d).maybeSingle(),
    sb.from("daily_activity").select("*").eq("day", d).maybeSingle(),
    sb.from("hc_records").select("start_at, end_at").eq("kind", "sleep")
      .gte("end_at", new Date(d + "T00:00:00").toISOString()).lt("end_at", new Date(addDays(d, 1) + "T00:00:00").toISOString())
      .order("end_at", { ascending: false }).limit(1),
    sb.from("workouts").select("created_at").eq("done_on", yday).order("created_at", { ascending: false }).limit(1),
    // the last week of logs, for "Same as yesterday?"
    sb.from("food_logs").select("*").eq("status", "eaten").gte("eaten_on", addDays(d, -7)).lt("eaten_on", d).order("eaten_on", { ascending: false }),
  ]).then((rs) => rs.map(must));

  if (isToday && await ensureTodayTarget(target, yWorks[0]?.created_at)) return renderToday(view);

  const isPlannedE = (e) => e.status === "planned";
  const sum = (list) => list.reduce((acc, e) => {
    for (const k of ["kcal", "protein_g", "carbs_g", "fat_g"]) acc[k] += Number(e[k]) || 0;
    return acc;
  }, { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
  const eaten = sum(logs.filter((e) => !isPlannedE(e)));
  const planned = sum(logs.filter(isPlannedE));
  const confirmed = works.filter((w) => w.status === "confirmed");
  const suggested = works.filter((w) => w.status === "suggested");
  const trained = confirmed.reduce((a, w) => a + (Number(w.kcal_used) || 0), 0);

  // Day navigation
  const label = isToday ? "Today" : d === addDays(t, 1) ? "Tomorrow" : d === addDays(t, -1) ? "Yesterday" : fmtDay(d, { weekday: "long" });
  const nav = h("div", { class: "day-nav" },
    h("button", { class: "icon-btn", "aria-label": "Previous day", onclick: () => { state.day = addDays(d, -1); render(); } }, icon("chevL")),
    h("button", { class: "day-title", onclick: () => { if (!isToday) { state.day = t; render(); } } },
      h("b", {}, label), h("span", { class: "small muted" }, fmtDay(d, { weekday: "short", day: "numeric", month: "short" }))),
    h("button", { class: "icon-btn", "aria-label": "Next day", disabled: d >= addDays(t, 7), onclick: () => { state.day = addDays(d, 1); render(); } }, icon("chevR")));

  // Goal strip (filled in when the goal maths returns)
  const goalStrip = h("button", { class: "card goal-strip", onclick: () => { state.tab = "progress"; state.progressTab = "goal"; render(); } },
    h("span", { class: "small muted" }, "Loading goal…"));

  // Calories and macros
  const left = target ? target.kcal - eaten.kcal : null;
  const ringCard = h("div", { class: "card target" },
    h("div", { style: "position:relative;width:120px;height:120px" },
      ring(eaten.kcal, target?.kcal),
      h("div", { class: "ring-centre" },
        h("div", { class: "ring-label num" }, target ? r0(Math.abs(left)).toLocaleString() : r0(eaten.kcal).toLocaleString()),
        h("div", { class: "small muted" }, target ? (left < 0 ? "kcal over" : "kcal left") : "kcal eaten"))),
    h("div", { class: "bars" },
      bar("Protein", eaten.protein_g, target?.protein_g, "var(--protein)"),
      bar("Carbs", eaten.carbs_g, target?.carbs_g, "var(--carbs)"),
      bar("Fat", eaten.fat_g, target?.fat_g, "var(--fat)"),
      h("div", { class: "small muted num" },
        target ? `${r0(eaten.kcal).toLocaleString()} of ${target.kcal.toLocaleString()} ` : "No target yet ",
        target ? h("span", { class: "badge" }, target.source === "ai" ? "AI-tuned" : target.method) : null,
        planned.kcal ? h("span", { style: "color:var(--accent)" }, ` · +${r0(planned.kcal)} planned`) : null)));

  // Recovery and activity strip
  const tile = (ic, value, lbl, onclick) => h("button", { class: "tile", onclick }, icon(ic, 18), h("b", { class: "num" }, value), h("span", {}, lbl));
  const strip = h("div", { class: "tiles" },
    tile("moon", act?.sleep_min != null ? minsToHM(act.sleep_min) : "–", "sleep", () => act?.sleep_min != null && toast(
      `Sleep ${minsToHM(act.sleep_min)}${act.deep_min != null ? ` · deep ${minsToHM(act.deep_min)}` : ""}${act.rem_min != null ? ` · REM ${minsToHM(act.rem_min)}` : ""}${act.awake_min ? ` · awake ${act.awake_min} min` : ""}`)),
    tile("heart", act?.low_hr ?? "–", "resting HR"),
    tile("steps", act?.steps != null ? Number(act.steps).toLocaleString() : "–", "steps", () => openSteps()),
    tile("dumbbell", trained ? r0(trained) : "–", "trained kcal", () => openWorkoutUpload()));

  // Sessions the band noticed that need a label
  const unlogged = suggested.map((w) => h("div", { class: "card attention" },
    h("div", {}, h("b", {}, `Unlogged session at ${localTime(w.started_at)}`),
      h("div", { class: "small muted" }, `${w.duration_s ? r0(w.duration_s / 60) + " min" : ""}${w.avg_hr ? ` · avg ${w.avg_hr} bpm` : ""}${w.max_hr ? ` · max ${w.max_hr}` : ""} · from your band`)),
    h("div", { class: "row", style: "gap:8px" },
      h("button", { class: "btn", onclick: () => openWorkoutEdit(w) }, "What was it?"),
      h("button", {
        class: "btn secondary",
        onclick: (ev) => busy(ev.currentTarget, async () => {
          must(await sb.from("workouts").update({ status: "dismissed" }).eq("id", w.id));
          await workoutChanged(w);
          toast("Dismissed"); render();
        }),
      }, "Not a workout"))));

  // Timeline: sleep, meals (grouped), workouts, empty slots
  const nodes = [];
  if (act?.sleep_min != null) {
    const st = sleepRec[0]?.start_at;
    nodes.push({ sort: "00:00", time: st ? localTime(st) : "night", el: h("div", { class: "tl-text" },
      `Slept ${minsToHM(act.sleep_min)}${act.deep_min != null ? ` · deep ${minsToHM(act.deep_min)}` : ""}${act.rem_min != null ? ` · REM ${minsToHM(act.rem_min)}` : ""}`), dot: "muted" });
  }
  for (const slot of MEALS) {
    const es = logs.filter((e) => e.meal === slot);
    const eatenEs = es.filter((e) => !isPlannedE(e));
    if (es.length) {
      const first = eatenEs[0]?.eaten_at;
      const allPlanned = !eatenEs.length;
      const kc = sum(es);
      nodes.push({
        sort: first ? localTime(first) : SLOT_TIME[slot],
        time: first ? localTime(first) : "—",
        dot: allPlanned ? "planned" : "food",
        el: h("div", { class: "meal-card" + (allPlanned ? " planned" : "") },
          h("div", { class: "meal-card-head" },
            h("span", {}, h("b", {}, cap(slot)), h("span", { class: "muted num" }, ` · ${allPlanned ? "planned " : ""}${r0(kc.kcal)} · P${r0(kc.protein_g)}`)),
            h("span", { class: "meal-card-actions" },
              allPlanned ? h("button", {
                class: "chip-btn",
                onclick: (ev) => busy(ev.currentTarget, async () => {
                  for (const e of es) await markEaten(e);
                  render();
                }),
              }, "Ate it") : null,
              h("button", { class: "icon-btn ghost", "aria-label": `Save ${slot} as a meal`, onclick: () => openSaveMealGroup(slot, es) }, icon("star", 18)),
              h("button", { class: "icon-btn ghost accent", "aria-label": `Add to ${slot}`, onclick: () => openAddFood(slot, d) }, icon("plus", 20)))),
          ...es.map((e) => h("button", { class: "meal-line" + (isPlannedE(e) ? " planned" : ""), onclick: () => openEntryActions(e) },
            h("span", { class: "desc" }, e.description), h("span", { class: "muted num" }, r0(e.kcal))))),
      });
    } else if (d >= t) {
      // Empty slot: offer the most recent time you had this meal
      const prevDay = recent.find((e) => e.meal === slot)?.eaten_on;
      const prev = prevDay ? recent.filter((e) => e.meal === slot && e.eaten_on === prevDay) : [];
      const pk = sum(prev);
      nodes.push({
        sort: SLOT_TIME[slot], time: "—", dot: "planned",
        el: h("div", { class: "meal-card planned" },
          h("div", { class: "meal-card-head" },
            h("b", {}, cap(slot)),
            h("button", { class: "icon-btn ghost accent", "aria-label": `Add to ${slot}`, onclick: () => openAddFood(slot, d) }, icon("plus", 20))),
          prev.length ? h("div", { class: "row small", style: "padding:0 10px 6px 0" },
            h("span", { class: "muted" }, `Same as ${prevDay === addDays(d, -1) ? "yesterday" : fmtDay(prevDay, { weekday: "long" })}? `,
              h("span", { style: "color:var(--text)" }, prev.map((e) => e.description).join(", ")), ` · ${r0(pk.kcal)}`),
            h("button", {
              class: "chip-btn",
              onclick: (ev) => busy(ev.currentTarget, async () => {
                must(await sb.from("food_logs").insert(prev.map((e) => ({
                  eaten_on: d, meal: slot, description: e.description, grams: e.grams, kcal: e.kcal, protein_g: e.protein_g,
                  carbs_g: e.carbs_g, fat_g: e.fat_g, fiber_g: e.fiber_g, source: "saved", items: e.items, food_id: e.food_id,
                  status: d > t ? "planned" : "eaten",
                }))));
                toast(`${cap(slot)} added: ${r0(pk.kcal)} kcal`); render();
              }),
            }, "Add")) : null),
      });
    }
  }
  for (const w of confirmed) {
    const tm = w.started_at ? localTime(w.started_at) : "—";
    nodes.push({
      sort: w.started_at ? tm : "12:00", time: tm, dot: "workout",
      el: h("button", { class: "meal-card workout", onclick: () => openWorkoutEdit(w) },
        h("div", {}, h("b", {}, w.type), w.duration_s ? ` · ${r0(w.duration_s / 60)} min` : ""),
        h("div", { class: "small muted" },
          `${w.kcal_used} kcal${w.avg_hr ? ` · avg ${w.avg_hr}` : ""}${w.max_hr ? ` · max ${w.max_hr} bpm` : ""}${w.source === "health_connect" ? " · from band" : ""}`),
        !w.description && w.source !== "manual" ? h("div", { class: "small", style: "color:var(--accent)" }, "Add what you did") : null,
        w.description ? h("div", { class: "small" }, w.description) : null),
    });
  }
  for (const w of suggested) {
    nodes.push({ sort: localTime(w.started_at), time: localTime(w.started_at), dot: "attention",
      el: h("div", { class: "meal-card attention-dashed small muted" }, "Session waiting for a label (see above)") });
  }
  nodes.sort((a, b) => a.sort.localeCompare(b.sort));

  const timeline = h("section", { class: "timeline", "aria-label": "Your day" },
    ...nodes.map((n) => h("div", { class: "tl-row" },
      h("span", { class: "tl-time num" }, n.time),
      h("span", { class: `tl-dot ${n.dot}` }),
      n.el)));

  fill(view,
    nav,
    goalStrip,
    ringCard,
    strip,
    ...unlogged,
    metric ? h("button", { class: "chip num", style: "align-self:flex-start", onclick: openWeighIn },
      `⚖ ${r1(metric.weight_kg)} kg${metric.body_fat_pct != null ? ` · ${metric.body_fat_pct}%` : ""}`) : null,
    timeline,
    logs.length && d <= t ? h("button", { class: "btn secondary", onclick: (ev) => dayFeedback(ev.currentTarget, d) }, "AI feedback on this day") : null,
    target?.ai_reason ? h("div", { class: "note small" }, "AI: ", target.ai_reason) : null,
    target?.notes ? h("div", { class: "note small muted" }, target.notes) : null,
  );

  // Goal strip, after the rest is on screen
  goalInfo().then((g) => {
    if (g.bf == null) {
      fill(goalStrip, h("span", { class: "small" }, "Add waist and neck to a weigh-in to start tracking your body fat goal."));
      return;
    }
    fill(goalStrip,
      h("div", { class: "row small" },
        h("span", {}, h("b", { class: "num", style: "font-size:15px" }, `${g.bf}%`), h("span", { class: "muted" }, " now · goal "), h("b", { style: "font-size:15px" }, `${g.target}%`)),
        h("span", { class: "muted" }, `${g.status.toLowerCase()} · `, h("b", { style: "color:var(--text)" }, g.plan.timeline ? fmtDay(g.plan.timeline.eta, { day: "numeric", month: "short" }) : "–"))),
      goalBar(g));
  }).catch((e) => fill(goalStrip, h("span", { class: "small muted" }, /weigh-in|profile/i.test(e.message) ? e.message : "Goal unavailable right now.")));
}

/** Add to one meal slot: saved meals for that slot first, then photo, type, scan. */
function openAddFood(slot, day = state.day) {
  const status = day > today() ? "planned" : "eaten";
  const ctx = { meal: slot, day, status };
  openSheet(`Add to ${slot}`,
    h("div", { class: "add-grid" },
      h("button", { class: "add-option", onclick: () => openSavedPicker(slot, ctx) }, icon("star", 22), "Saved"),
      h("button", { class: "add-option", onclick: () => openPhotoFood(null, ctx) }, icon("camera", 22), "Photo"),
      h("button", { class: "add-option", onclick: () => openTypedFood(ctx) }, icon("pencil", 22), "Type"),
      h("button", { class: "add-option", onclick: () => openScan() }, icon("barcode", 22), "Scan")));
}

/** Save every entry in a meal (e.g. a three-part breakfast) as one reusable meal. */
function openSaveMealGroup(slot, entries) {
  const items = entries.flatMap((e) => entryItems(e));
  const name = h("input", { value: entries.length > 1 ? `${cap(slot)}: ${entries.map((e) => e.description).join(", ")}`.slice(0, 80) : entries[0].description });
  const t = sumItems(items);
  const save = h("button", { class: "btn" }, "Save meal");
  save.addEventListener("click", () => busy(save, async () => {
    must(await sb.from("saved_meals").upsert({ name: name.value.trim() || cap(slot), meal: slot, items: cleanItems(items) }, { onConflict: "user_id,name" }));
    closeSheet(); toast(`★ Saved to ${cap(slot)}`);
  }));
  openSheet(`Save ${slot} as a meal`,
    h("div", { class: "note num" }, `${items.length} item${items.length === 1 ? "" : "s"} · ${r0(t.kcal)} kcal · P ${r0(t.protein_g)}`),
    h("div", { class: "small muted" }, items.map((i) => `${i.name}${i.grams ? ` ${r0(i.grams)} g` : ""}`).join(", ")),
    h("label", {}, "Name"), name, h("div", { style: "height:10px" }), save);
}

/** Recalculate today's target from yesterday's data (after correcting yesterday's workouts, say). */
async function recalcToday({ quiet = false } = {}) {
  const t = today();
  const cur = must(await sb.from("daily_targets").select("source").eq("for_date", t).maybeSingle());
  if (cur?.source === "ai" && quiet) return; // keep an AI-tuned target unless asked directly
  await callFn("plan", { today: addDays(t, -1), for_date: t });
  state.goal = null;
  if (!quiet) toast("Today's targets recalculated");
}

/** A workout on yesterday (or today, for tomorrow's target) changed: keep the affected target in step. */
async function workoutChanged(w) {
  const t = today();
  try {
    if (w.done_on === addDays(t, -1)) await recalcToday({ quiet: true });
  } catch { /* the Targets button can still redo it */ }
}

/** Label, describe or correct a workout (including ones the band detected). */
function openWorkoutEdit(w) {
  const type = h("input", { value: w.status === "suggested" ? "" : w.type, placeholder: "e.g. CrossFit" });
  const quick = ["CrossFit", "Weights", "Run", "Walk", "Cycling", "Padel", "Swim"].map((x) =>
    h("button", { class: "chip", type: "button", onclick: () => { type.value = x; } }, x));
  const desc = h("textarea", { value: w.description || "", placeholder: "What you did, e.g. 5 rounds: 10 thrusters 40 kg, 10 pull-ups, 400 m run" });
  const kcal = h("input", { type: "number", inputmode: "numeric", value: w.kcal_used ?? "" });
  const save = h("button", { class: "btn" }, w.status === "suggested" ? "Save workout" : "Save changes");
  save.addEventListener("click", () => busy(save, async () => {
    if (!type.value.trim()) throw new Error("Say what it was.");
    const k = numOrNull(kcal.value);
    const row = { type: type.value.trim(), description: desc.value.trim() || null, status: "confirmed" };
    if (k != null && k !== Number(w.kcal_used)) { row.kcal_used = Math.round(k); row.kcal_locked = true; }
    must(await sb.from("workouts").update(row).eq("id", w.id));
    await workoutChanged(w);
    closeSheet(); toast("Workout saved"); render();
  }));
  openSheet(w.status === "suggested" ? "What was it?" : w.type,
    h("div", { class: "note num" },
      `${w.started_at ? localTime(w.started_at) + " · " : ""}${w.duration_s ? r0(w.duration_s / 60) + " min" : ""}` +
      `${w.avg_hr ? ` · avg ${w.avg_hr}` : ""}${w.max_hr ? ` · max ${w.max_hr} bpm` : ""}${w.active_kcal ? ` · band ${w.active_kcal} kcal` : ""}`),
    h("label", {}, "Type"), type, h("div", { class: "chips" }, ...quick),
    h("label", {}, "What you did (helps the coach)"), desc,
    h("label", {}, "Burn the plan uses (kcal)"), kcal,
    h("div", { class: "small muted" }, "Eaten back in tomorrow's target. Change it if the band's figure looks wrong."),
    h("div", { style: "height:10px" }), save,
    w.status !== "suggested" ? h("button", {
      class: "btn danger",
      onclick: (ev) => busy(ev.currentTarget, async () => {
        must(await sb.from("workouts").update({ status: "dismissed" }).eq("id", w.id));
        await workoutChanged(w);
        closeSheet(); toast("Workout removed"); render();
      }),
    }, "Remove workout") : null);
}

/** The + button: everything you can add, grouped. */
function openAddSheet() {
  const opt = (ic, lbl, fn) => h("button", { class: "add-option", onclick: fn }, icon(ic, 22), lbl);
  const day = state.tab === "today" ? state.day : today();
  const slot = guessMeal();
  const ctx = { meal: slot, day, status: day > today() ? "planned" : "eaten" };
  openSheet("Add",
    h("div", { class: "add-group" }, "Food"),
    h("div", { class: "add-grid" },
      opt("star", "Saved meal", () => openSavedPicker(slot, ctx)),
      opt("camera", "Photo", () => openPhotoFood(null, ctx)),
      opt("pencil", "Type", () => openTypedFood(ctx)),
      opt("barcode", "Scan", () => openScan()),
      opt("calendar", "Plan meals", (e) => busy(e.currentTarget, () => openMealPlanner(day > today() ? day : addDays(today(), 1))))),
    h("div", { class: "add-group" }, "Activity"),
    h("div", { class: "add-grid" },
      opt("dumbbell", "Workout", () => openWorkoutUpload()),
      opt("steps", "Steps", () => openSteps())),
    h("div", { class: "add-group" }, "Body and targets"),
    h("div", { class: "add-grid" },
      opt("scale", "Weigh-in", () => openWeighIn()),
      opt("target", "Redo today's targets", (e) => busy(e.currentTarget, async () => { await recalcToday(); closeSheet(); render(); })),
      opt("calendar", "Tomorrow's targets", (e) => runPlan(e.currentTarget))));
}

// ---------------------------------------------------------------------------
// Food tab: saved meals by category, and planning ahead
// ---------------------------------------------------------------------------

async function renderFood(view) {
  const seg = state.foodTab || "saved";
  const segBtn = (key, lbl) => h("button", { role: "tab", "aria-selected": String(seg === key), class: seg === key ? "on" : null,
    onclick: () => { state.foodTab = key; render(); } }, lbl);
  const head = h("div", { class: "segmented two", role: "tablist" }, segBtn("saved", "Saved meals"), segBtn("plan", "Plan ahead"));

  if (seg === "plan") {
    const t = today();
    const days = Array.from({ length: 8 }, (_, i) => addDays(t, i));
    const [logs, targets] = await Promise.all([
      sb.from("food_logs").select("eaten_on, meal, kcal, protein_g, status").gte("eaten_on", t).lte("eaten_on", days.at(-1)),
      sb.from("daily_targets").select("for_date, kcal, protein_g").gte("for_date", t).lte("for_date", days.at(-1)),
    ]).then((rs) => rs.map(must));
    fill(view, h("h1", { class: "screen-title" }, "Food"), head,
      h("p", { class: "small muted" }, "Plan meals ahead; they count once you tap Ate it."),
      ...days.map((d) => {
        const ls = logs.filter((l) => l.eaten_on === d);
        const kc = ls.reduce((a, l) => a + Number(l.kcal), 0);
        const pr = ls.reduce((a, l) => a + Number(l.protein_g), 0);
        const tg = targets.find((x) => x.for_date === d);
        const slots = MEALS.filter((m) => ls.some((l) => l.meal === m));
        return h("button", { class: "entry plan-day", onclick: (ev) => busy(ev.currentTarget, () => openMealPlanner(d)) },
          h("span", {}, h("b", {}, d === t ? "Today" : d === addDays(t, 1) ? "Tomorrow" : fmtDay(d, { weekday: "long" })),
            h("div", { class: "small muted" }, slots.length ? slots.map(cap).join(" · ") : "Nothing planned")),
          h("span", { class: "num", style: "text-align:right" }, ls.length ? `${r0(kc)} kcal` : "",
            h("div", { class: "small muted" }, ls.length ? `P ${r0(pr)}${tg ? ` / ${tg.protein_g}` : ""}` : "")));
      }));
    return;
  }

  const meals = must(await sb.from("saved_meals").select("*").order("use_count", { ascending: false }).order("name"));
  const groups = [...MEALS, null];
  fill(view, h("h1", { class: "screen-title" }, "Food"), head,
    meals.length ? null : h("p", { class: "muted" }, "No saved meals yet. Tap ★ on any meal on the Today screen to keep it here."),
    ...groups.map((g) => {
      const list = meals.filter((m) => (m.meal || null) === g);
      if (!list.length) return null;
      return h("section", {},
        h("div", { class: "meal-head" }, h("span", {}, g || "Unsorted"), h("span", {}, `${list.length}`)),
        ...list.map((m) => {
          const t = sumItems(m.items);
          return h("div", { class: "card saved-meal" },
            h("div", { class: "row" },
              h("button", { class: "saved-meal-main", onclick: () => openSavedMealEdit(m) },
                h("b", {}, m.name),
                h("div", { class: "small muted num" }, `${r0(t.kcal)} kcal · P ${r0(t.protein_g)} C ${r0(t.carbs_g)} F ${r0(t.fat_g)} · used ${m.use_count}×`),
                h("div", { class: "small muted" }, m.items.map((i) => `${i.name}${i.grams ? ` ${r0(i.grams)} g` : ""}`).join(", "))),
              h("button", { class: "btn", style: "width:auto;padding:10px 16px", onclick: () => logSavedMeal(m, { meal: m.meal || guessMeal() }) }, "Log")));
        }));
    }));
}

// ---------------------------------------------------------------------------
// Progress: Goal, Body, Food, Training
// ---------------------------------------------------------------------------

function weightChart(points, opts = {}) {
  // points: [{day, w}] sorted. Dots = readings; line = 7-day average. opts.plan: [{day, w}] dashed path.
  const W = 340, H = 170, P = { l: 34, r: 8, t: 10, b: 22 };
  const all = [...points, ...(opts.plan || [])];
  const xs = all.map((p) => new Date(p.day + "T12:00:00").getTime());
  const ys = all.map((p) => p.w);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.floor(Math.min(...ys) - 0.5), y1 = Math.ceil(Math.max(...ys) + 0.5);
  const X = (t) => P.l + ((t - x0) / Math.max(1, x1 - x0)) * (W - P.l - P.r);
  const Y = (v) => P.t + (1 - (v - y0) / Math.max(0.1, y1 - y0)) * (H - P.t - P.b);
  const T = (d) => new Date(d + "T12:00:00").getTime();
  const avg = points.map((p) => {
    const t = T(p.day);
    const win = points.filter((q) => T(q.day) <= t && T(q.day) > t - 7 * 86400000);
    return [X(t), Y(win.reduce((a, q) => a + q.w, 0) / win.length)];
  });
  const ticks = [y0, (y0 + y1) / 2, y1];
  const first = all.reduce((a, p) => (p.day < a ? p.day : a), all[0].day);
  const last = all.reduce((a, p) => (p.day > a ? p.day : a), all[0].day);
  return s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart" },
    ...ticks.map((v) => [
      s("line", { x1: P.l, x2: W - P.r, y1: Y(v), y2: Y(v), stroke: "var(--line)", "stroke-width": 1 }),
      s("text", { x: P.l - 6, y: Y(v) + 4, "text-anchor": "end", "font-size": 10, fill: "var(--muted)" }, r1(v)),
    ]),
    opts.plan ? s("polyline", { points: opts.plan.map((p) => `${X(T(p.day))},${Y(p.w)}`).join(" "), fill: "none", stroke: "var(--muted)", "stroke-width": 2, "stroke-dasharray": "5 5" }) : null,
    ...(opts.marks || []).map((m) => [
      s("circle", { cx: X(T(m.day)), cy: Y(m.w), r: 4, fill: "var(--bg)", stroke: "var(--muted)", "stroke-width": 2 }),
      s("text", { x: X(T(m.day)), y: Y(m.w) - 8, "text-anchor": "middle", "font-size": 10, fill: "var(--muted)" }, m.label),
    ]),
    avg.length > 1 ? s("polyline", { points: avg.map((p) => p.join(",")).join(" "), fill: "none", stroke: "var(--accent)", "stroke-width": 2.5, "stroke-linejoin": "round" }) : null,
    ...points.map((p) => s("circle", { cx: X(T(p.day)), cy: Y(p.w), r: 2.5, fill: "var(--muted)" })),
    s("text", { x: P.l, y: H - 6, "font-size": 10, fill: "var(--muted)" }, fmtDay(first, { day: "numeric", month: "short" })),
    s("text", { x: W - P.r, y: H - 6, "text-anchor": "end", "font-size": 10, fill: "var(--muted)" }, fmtDay(last, { day: "numeric", month: "short" })),
  );
}

/** Small daily bar chart with optional target ticks; tap a bar for numbers. */
function dayBars(days, valueOf, { color, label, unit = "g", targetOf = null, fmt = (v) => r0(v) } = {}) {
  const W = 340, H = 92, P = { l: 30, r: 4, t: 16, b: 16 };
  const vals = days.map((d) => ({ d, v: valueOf(d), tv: targetOf ? targetOf(d) : null }));
  const max = Math.max(1, ...vals.map((x) => Math.max(x.v || 0, x.tv || 0))) * 1.1;
  const bw = (W - P.l - P.r) / days.length;
  const Y = (v) => P.t + (1 - v / max) * (H - P.t - P.b);
  const withData = vals.filter((x) => x.v != null);
  const mean = withData.length ? withData.reduce((a, x) => a + x.v, 0) / withData.length : null;
  return h("div", { style: "margin-top:8px" },
    h("div", { class: "row small" }, h("b", {}, label), h("span", { class: "muted num" }, mean != null ? `avg ${fmt(mean)}${unit ? " " + unit : ""}` : "")),
    s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart" },
      s("line", { x1: P.l, x2: W - P.r, y1: Y(0), y2: Y(0), stroke: "var(--line)" }),
      s("text", { x: P.l - 4, y: Y(max / 1.1) + 4, "text-anchor": "end", "font-size": 9, fill: "var(--muted)" }, fmt(max / 1.1)),
      ...vals.map((x, i) => {
        const x0 = P.l + i * bw + 2, w = Math.max(2, bw - 4);
        const g = s("g", { style: "cursor:pointer" },
          s("rect", { x: P.l + i * bw, y: P.t, width: bw, height: H - P.t - P.b, fill: "transparent" }),
          x.v != null ? s("rect", { x: x0, y: Y(x.v), width: w, height: Math.max(1, Y(0) - Y(x.v)), rx: 3, fill: color }) : null,
          x.tv != null ? s("line", { x1: x0 - 1, x2: x0 + w + 1, y1: Y(x.tv), y2: Y(x.tv), stroke: "var(--text)", "stroke-width": 2 }) : null);
        g.addEventListener("click", () => toast(`${label} · ${fmtDay(x.d)}: ${x.v != null ? fmt(x.v) + (unit ? " " + unit : "") : "no data"}${x.tv != null ? ` of ${fmt(x.tv)}` : ""}`));
        return g;
      }),
      s("text", { x: P.l, y: H - 3, "font-size": 9, fill: "var(--muted)" }, fmtDay(days[0], { day: "numeric", month: "short" })),
      s("text", { x: W - P.r, y: H - 3, "text-anchor": "end", "font-size": 9, fill: "var(--muted)" }, "today")));
}

async function renderProgress(view) {
  const seg = state.progressTab || "goal";
  const segBtn = (key, lbl) => h("button", { role: "tab", "aria-selected": String(seg === key), class: seg === key ? "on" : null,
    onclick: () => { state.progressTab = key; render(); } }, lbl);
  const head = [h("h1", { class: "screen-title" }, "Progress"),
    h("div", { class: "segmented", role: "tablist" }, segBtn("goal", "Goal"), segBtn("body", "Body"), segBtn("food", "Food"), segBtn("training", "Training"))];
  const t = today();
  const days14 = Array.from({ length: 14 }, (_, i) => addDays(t, i - 13));

  if (seg === "goal") {
    fill(view, ...head, h("p", { class: "muted" }, "Loading…"));
    const [g, metrics, week, weekFood] = await Promise.all([
      goalInfo(true),
      sb.from("body_metrics").select("measured_on, weight_kg").gte("measured_on", addDays(t, -120)).order("measured_on").then(must),
      sb.from("daily_summary").select("*").gte("day", addDays(t, -6)).lte("day", t).then(must),
      sb.from("food_logs").select("eaten_on, meal").eq("status", "eaten").gte("eaten_on", addDays(t, -6)).lte("eaten_on", t).then(must),
    ]);
    if (g.bf == null) {
      fill(view, ...head, h("div", { class: "card" }, h("h3", {}, `Goal: ${g.target}% body fat`),
        h("p", {}, "Add waist and neck measurements to a weigh-in and the goal tracking starts here."),
        h("button", { class: "btn", onclick: openWeighIn }, "Weigh-in")));
      return;
    }
    const weights = metrics.map((m) => ({ day: m.measured_on, w: Number(m.weight_kg) }));
    // Planned path: from the first weigh-in, losing the planned % each week, to goal weight
    let plan = null, marks = [];
    if (weights.length && g.goalWeight) {
      const w0 = weights[0].w, d0 = weights[0].day;
      const weeks = Math.log(w0 / g.goalWeight) / -Math.log(1 - g.rate / 100);
      plan = Array.from({ length: Math.ceil(weeks) + 1 }, (_, i) => ({ day: addDays(d0, Math.min(i, weeks) * 7 | 0), w: Math.max(g.goalWeight, w0 * Math.pow(1 - g.rate / 100, Math.min(i, weeks))) }));
      marks = (g.milestones || []).map((m) => ({ day: m.date, w: m.weight, label: `${m.pct}%` }));
    }
    const days7 = Array.from({ length: 7 }, (_, i) => addDays(t, i - 6));
    const byDay = new Map(week.map((r) => [r.day, r]));
    const habit = (lbl, test, color) => {
      const hits = days7.map((d) => test(d));
      const counted = hits.filter((x) => x !== null);
      return h("div", { class: "habit" },
        h("span", {}, lbl),
        h("span", { class: "habit-dots", "aria-label": `${hits.filter(Boolean).length} of ${counted.length} days` },
          ...hits.map((x, i) => h("i", { class: x ? "on" : x === false ? "off" : "none", style: x ? `background:${color}` : null, title: fmtDay(days7[i]) }))),
        h("span", { class: "muted num" }, `${hits.filter(Boolean).length}/${counted.length}`));
    };
    const meals = (d) => new Set(weekFood.filter((f) => f.eaten_on === d).map((f) => f.meal));
    const leanDelta = g.startLean ? g.lean - g.startLean : null;
    fill(view, ...head,
      h("div", { class: "card stack" },
        h("div", { class: "row" },
          h("div", {}, h("div", { class: "small muted" }, "Goal"), h("div", { class: "goal-title" }, `${g.target}% body fat`)),
          h("span", { class: "pill" }, g.status)),
        h("div", { class: "row", style: "justify-content:flex-start;align-items:baseline;gap:10px" },
          h("span", { class: "goal-now num" }, `${g.bf}%`),
          h("span", { class: "small muted" }, g.start ? `now, from ${g.startBf}% on ${fmtDay(g.start.measured_on, { day: "numeric", month: "short" })}` : "now")),
        goalBar(g, 10),
        h("div", {}, g.plan.timeline ? ["Expected around ", h("b", {}, fmtDay(g.plan.timeline.eta, { day: "numeric", month: "long", year: "numeric" })), " at your current pace."] : "")),
      h("div", { class: "stats two" },
        h("div", { class: "stat num" }, h("span", {}, "Weight (trend)"), h("b", {}, `${g.weight} kg`)),
        h("div", { class: "stat num" }, h("span", {}, "Goal weight"), h("b", {}, `${r1(g.goalWeight)} kg`)),
        h("div", { class: "stat num" }, h("span", {}, "Pace"), h("b", {}, g.pace != null ? `${g.pace} kg/wk` : "–"), h("span", {}, `plan ${g.plannedPace.toFixed(2)}`)),
        h("div", { class: "stat num" }, h("span", {}, "Lean mass"), h("b", {}, `${r1(g.lean)} kg`),
          h("span", {}, leanDelta == null ? "" : Math.abs(leanDelta) < 0.5 ? "holding" : leanDelta > 0 ? `+${r1(leanDelta)} kg` : `${r1(leanDelta)} kg`))),
      weights.length >= 2 ? h("div", { class: "card" },
        h("div", { class: "row small" }, h("b", {}, "Weight vs plan"), h("span", { class: "muted" }, "line you · dashed plan")),
        weightChart(weights, { plan, marks })) : null,
      g.milestones?.length ? h("div", { class: "card list" },
        ...g.milestones.map((m) => h("div", { class: "list-row" },
          h("span", {}, h("b", {}, `${m.pct}%`), ` · ${r1(m.weight)} kg`),
          h("span", { class: "muted" }, `around ${fmtDay(m.date, { day: "numeric", month: "short" })}`)))) : null,
      h("div", { class: "card stack" }, h("h3", {}, "Last 7 days"),
        habit("Protein target hit", (d) => { const r = byDay.get(d); return r?.target_protein_g && r.food_entries ? Number(r.protein_g) >= 0.95 * r.target_protein_g : null; }, "var(--protein)"),
        habit("Trained", (d) => !!byDay.get(d)?.workouts, "var(--carbs)"),
        habit("Slept 7 h or more", (d) => { const r = byDay.get(d); return r?.sleep_min != null ? r.sleep_min >= 420 : null; }, "var(--muted)"),
        habit("Breakfast, lunch and dinner logged", (d) => { const m = meals(d); return m.has("breakfast") && m.has("lunch") && m.has("dinner"); }, "var(--accent)")),
      h("button", { class: "btn secondary", onclick: () => { state.tab = "settings"; render(); } }, "Edit goal and pace"),
      h("div", { class: "small muted" }, "Dates assume the weight you lose is fat and lean mass holds; real progress usually runs a little slower."));
    return;
  }

  if (seg === "body") {
    const [metrics, acts] = await Promise.all([
      sb.from("body_metrics").select("*").gte("measured_on", addDays(t, -120)).order("measured_on"),
      sb.from("daily_activity").select("day, low_hr, sleep_min").gte("day", addDays(t, -13)),
    ]).then((rs) => rs.map(must));
    const weights = metrics.map((m) => ({ day: m.measured_on, w: Number(m.weight_kg) }));
    const bfs = metrics.filter((m) => m.body_fat_pct != null).map((m) => ({ day: m.measured_on, w: Number(m.body_fat_pct) }));
    const aByDay = new Map(acts.map((a) => [a.day, a]));
    const tape = [["waist_cm", "Waist"], ["neck_cm", "Neck"], ["hip_cm", "Hips"], ["chest_cm", "Chest"], ["arm_cm", "Arm"], ["thigh_cm", "Thigh"]]
      .map(([k, label]) => {
        const rows = metrics.filter((m) => m[k] != null);
        if (!rows.length) return null;
        return { label, first: Number(rows[0][k]), last: Number(rows.at(-1)[k]) };
      }).filter(Boolean);
    fill(view, ...head,
      h("div", { class: "card" }, h("h3", {}, "Weight"),
        weights.length >= 2 ? weightChart(weights) : h("p", { class: "muted" }, "Two or more weigh-ins draw the chart."),
        h("div", { class: "small muted" }, "Dots are weigh-ins; the line is the 7-day average.")),
      bfs.length >= 2 ? h("div", { class: "card" }, h("h3", {}, "Body fat %"), weightChart(bfs)) : null,
      tape.length ? h("div", { class: "card" }, h("h3", {}, "Measurements (cm)"),
        h("table", { class: "num" },
          h("tr", {}, h("th", {}, ""), h("th", {}, "First"), h("th", {}, "Latest"), h("th", {}, "Change")),
          ...tape.map((m) => h("tr", {}, h("td", {}, m.label), h("td", {}, r1(m.first)), h("td", {}, r1(m.last)),
            h("td", { style: `color:${m.last < m.first ? "var(--accent)" : m.last > m.first ? "var(--warn)" : "inherit"}` },
              `${m.last - m.first > 0 ? "+" : ""}${r1(m.last - m.first)}`))))) : null,
      h("div", { class: "card" }, h("h3", {}, "Recovery, last 14 days"),
        dayBars(days14, (d) => aByDay.get(d)?.sleep_min != null ? aByDay.get(d).sleep_min / 60 : null, { color: "var(--muted)", label: "Sleep", unit: "h", fmt: (v) => r1(v), targetOf: () => 7 }),
        dayBars(days14, (d) => aByDay.get(d)?.low_hr ?? null, { color: "var(--fat)", label: "Resting heart rate", unit: "bpm" })),
      h("button", { class: "btn secondary", onclick: openWeighIn }, "Add a weigh-in"));
    return;
  }

  if (seg === "food") {
    const [summary, targets14] = await Promise.all([
      sb.from("daily_summary").select("*").gte("day", days14[0]).order("day", { ascending: false }),
      sb.from("daily_targets").select("for_date, kcal, protein_g, carbs_g, fat_g").gte("for_date", days14[0]).lte("for_date", t),
    ]).then((rs) => rs.map(must));
    const byDay = new Map(summary.map((r) => [r.day, r]));
    const tByDay = new Map(targets14.map((r) => [r.for_date, r]));
    const logged = days14.filter((d) => byDay.get(d)?.food_entries > 0);
    const avg = (k) => logged.length ? logged.reduce((a, d) => a + Number(byDay.get(d)[k]), 0) / logged.length : 0;
    const tAvg = (k) => targets14.length ? targets14.reduce((a, r) => a + r[k], 0) / targets14.length : null;
    const parts = macroParts({ protein_g: avg("protein_g"), carbs_g: avg("carbs_g"), fat_g: avg("fat_g") },
      targets14.length ? { protein_g: tAvg("protein_g"), carbs_g: tAvg("carbs_g"), fat_g: tAvg("fat_g") } : null);
    const val = (k) => (d) => byDay.get(d)?.food_entries ? Number(byDay.get(d)[k]) : null;
    const tv = (k) => (d) => tByDay.get(d)?.[k] ?? null;
    const reviewBox = h("div");
    const reviewBtn = h("button", { class: "btn secondary" }, "Weekly review (AI)");
    const showReview = (r) => fill(reviewBox, reviewCard(r, "Weekly review"));
    try { const c = JSON.parse(localStorage.getItem("tenth-review") || "null"); if (c) showReview(c); } catch { /* storage unavailable */ }
    reviewBtn.addEventListener("click", () => busy(reviewBtn, async () => {
      const r = await callFn("ai", { mode: "review", today: t, days: 7 });
      r.at = t;
      try { localStorage.setItem("tenth-review", JSON.stringify(r)); } catch { /* fine */ }
      showReview(r);
    }));
    fill(view, ...head,
      h("div", { class: "card" }, h("h3", {}, "Average split, last 14 days"),
        logged.length ? h("div", { style: "display:flex;gap:16px;align-items:center" }, donut(parts, 110, `${r0(avg("intake_kcal"))}`, "avg kcal"), macroLegend(parts))
          : h("p", { class: "muted" }, "Log some meals to see your macros."),
        logged.length ? dayBars(days14, val("intake_kcal"), { color: "var(--accent)", label: "Calories", unit: "kcal", targetOf: tv("kcal") }) : null,
        logged.length ? dayBars(days14, val("protein_g"), { color: "var(--protein)", label: "Protein", targetOf: tv("protein_g") }) : null,
        logged.length ? dayBars(days14, val("carbs_g"), { color: "var(--carbs)", label: "Carbs", targetOf: tv("carbs_g") }) : null,
        logged.length ? dayBars(days14, val("fat_g"), { color: "var(--fat)", label: "Fat", targetOf: tv("fat_g") }) : null,
        logged.length ? h("div", { class: "small muted", style: "margin-top:6px" }, "Bars are what you ate; the white tick is that day's target. Tap a bar for numbers.") : null),
      reviewBtn, reviewBox);
    return;
  }

  // Training
  const [works, acts] = await Promise.all([
    sb.from("workouts").select("*").eq("status", "confirmed").gte("done_on", addDays(t, -29)).order("started_at", { ascending: false }),
    sb.from("daily_activity").select("day, steps").gte("day", days14[0]),
  ]).then((rs) => rs.map(must));
  const aByDay = new Map(acts.map((a) => [a.day, a]));
  const wByDay = new Map();
  for (const w of works) wByDay.set(w.done_on, (wByDay.get(w.done_on) || 0) + Number(w.kcal_used || 0));
  fill(view, ...head,
    h("div", { class: "card" }, h("h3", {}, "Last 14 days"),
      dayBars(days14, (d) => wByDay.get(d) ?? null, { color: "var(--carbs)", label: "Workout burn", unit: "kcal" }),
      dayBars(days14, (d) => aByDay.get(d)?.steps ?? null, { color: "var(--accent)", label: "Steps", unit: "", fmt: (v) => Math.round(v).toLocaleString() })),
    h("div", { class: "card list" }, h("h3", {}, "Workouts, last 30 days"),
      works.length ? null : h("p", { class: "muted" }, "None yet."),
      ...works.map((w) => h("button", { class: "list-row", onclick: () => openWorkoutEdit(w) },
        h("span", {}, h("b", {}, w.type), h("div", { class: "small muted" },
          `${fmtDay(w.done_on)}${w.duration_s ? ` · ${r0(w.duration_s / 60)} min` : ""}${w.description ? ` · ${w.description}` : ""}`)),
        h("span", { class: "num", style: "text-align:right" }, `${w.kcal_used} kcal`, h("div", { class: "small muted" }, w.avg_hr ? `avg ${w.avg_hr}` : ""))))));
}

// ---------------------------------------------------------------------------
// Coach
// ---------------------------------------------------------------------------

function coachThread() {
  try { return localStorage.getItem("tenth-thread") || null; } catch { return state.thread || null; }
}
function setCoachThread(id) {
  state.thread = id;
  try { if (id) localStorage.setItem("tenth-thread", id); else localStorage.removeItem("tenth-thread"); } catch { /* fine */ }
}

function proposalCard(p, onDone) {
  const box = h("div", { class: "card attention stack" });
  const decide = async (keep, btn) => busy(btn, async () => {
    if (keep) {
      if (p.replaces_note_id) must(await sb.from("coach_notes").update({ note: p.note, updated_at: new Date().toISOString() }).eq("id", p.replaces_note_id));
      else must(await sb.from("coach_notes").insert({ note: p.note }));
    }
    p.decided = keep ? "kept" : "declined";
    await onDone();
    fill(box, h("div", { class: "small muted" }, keep ? `Remembered: ${p.note}` : "Not saved."));
  });
  fill(box,
    h("div", { class: "eyebrow" }, p.replaces_note_id ? "Update what I remember?" : "Remember this?"),
    h("div", {}, p.note),
    h("div", { class: "row", style: "gap:8px" },
      h("button", { class: "btn", onclick: (e) => decide(true, e.currentTarget) }, "Remember"),
      h("button", { class: "btn secondary", onclick: (e) => decide(false, e.currentTarget) }, "No thanks")));
  return box;
}

async function renderCoach(view) {
  const thread = coachThread();
  const msgs = thread ? must(await sb.from("coach_messages").select("*").eq("thread_id", thread).order("id")) : [];
  const list = h("div", { class: "chat" });

  const bubble = (m) => {
    const el = h("div", { class: `bubble ${m.role}` }, m.content);
    const pending = (m.proposals || []).filter((p) => !p.decided);
    if (m.role !== "assistant" || !pending.length) return el;
    const saveDecisions = async () => {
      must(await sb.from("coach_messages").update({ proposals: m.proposals }).eq("id", m.id));
    };
    return [el, ...pending.map((p) => proposalCard(p, saveDecisions))];
  };

  const input = h("textarea", { class: "chat-input", rows: 1, placeholder: "Ask about your food, training, sleep…", "aria-label": "Message the coach" });
  const sendBtn = h("button", { class: "send-btn", "aria-label": "Send" }, icon("send", 20, 2.4));
  const send = async (text) => {
    const msg = (text ?? input.value).trim();
    if (!msg) return;
    input.value = "";
    list.append(h("div", { class: "bubble user" }, msg));
    const thinking = h("div", { class: "bubble assistant muted" }, h("span", { class: "spinner" }), "Looking at your data…");
    list.append(thinking);
    thinking.scrollIntoView({ behavior: "smooth", block: "end" });
    sendBtn.disabled = true;
    try {
      const r = await callFn("coach", { message: msg, today: today(), thread_id: coachThread() }, 150000);
      setCoachThread(r.thread_id);
      thinking.remove();
      // Reload so proposals are tied to their saved message
      await renderCoach(view);
    } catch (e) {
      thinking.remove();
      list.append(h("div", { class: "warn" }, e.message));
      input.value = msg;
    } finally {
      sendBtn.disabled = false;
    }
  };
  sendBtn.addEventListener("click", () => send());
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });

  const starters = ["How was my week?", "Plan tomorrow's food", "Why is today's target what it is?", "Am I getting enough protein?"]
    .map((q) => h("button", { class: "chip", onclick: () => send(q) }, q));

  fill(list, ...(msgs.length ? msgs.flatMap(bubble) : [h("div", { class: "muted small", style: "text-align:center;margin:24px 0" },
    "The coach sees your last 14 days in detail and older weeks as summaries, plus anything you've let it remember.")]));

  fill(view,
    h("div", { class: "row" },
      h("h1", { class: "screen-title" }, "Coach"),
      h("button", { class: "chip", onclick: () => { setCoachThread(null); render(); } }, "New chat")),
    list,
    h("div", { class: "chat-bar" },
      h("div", { class: "chips nowrap" }, ...starters),
      h("div", { class: "chat-row" }, input, sendBtn)));
  requestAnimationFrame(() => list.lastElementChild?.scrollIntoView({ block: "end" }));
}

// ---------------------------------------------------------------------------
// Settings (behind the gear)
// ---------------------------------------------------------------------------

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  const field = (key, label, type = "number") =>
    h("div", {}, h("label", {}, label), h("input", {
      type, inputmode: type === "number" ? "decimal" : null, step: "any", value: v[key],
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
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    };
    state.profile = must(await sb.from("profile").upsert(row, { onConflict: "user_id" }).select().single());
    state.goal = null;
    toast("Profile saved");
  }));

  const [tok, notes] = await Promise.all([
    sb.from("hc_tokens").select("created_at, last_used_at, last_result").maybeSingle().then(must),
    sb.from("coach_notes").select("*").order("updated_at", { ascending: false }).then(must),
  ]);

  // Health Connect
  const endpoint = `${SUPABASE_URL}/functions/v1/hc`;
  const hcBox = h("div", { class: "stack" });
  const copyRow = (lbl, value) => h("div", {},
    h("label", {}, lbl),
    h("div", { class: "row", style: "gap:8px" },
      h("input", { value, readonly: true, onclick: (e) => e.target.select() }),
      h("button", { class: "chip", onclick: async () => { try { await navigator.clipboard.writeText(value); toast("Copied"); } catch { toast("Select and copy it instead", true); } } }, "Copy")));
  const showSetup = (token) => fill(hcBox,
    h("div", { class: "note small" }, "In Health Connect Webhook, add a webhook with just this URL. No headers needed; the token is in the link. It's shown once, so make a new one if you lose it."),
    copyRow("Webhook URL", `${endpoint}?token=${token}`),
    h("div", { class: "small muted" }, "Choose JSON if asked. Turn on steps, exercise, heart rate, active calories, distance, sleep and oxygen saturation, and sync every 30–60 minutes."));
  const newToken = h("button", { class: "btn secondary" }, tok ? "Make a new token" : "Set up automatic sync");
  newToken.addEventListener("click", () => busy(newToken, async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const token = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "").slice(0, 32);
    must(await sb.from("hc_tokens").upsert({ token_hash: await sha256Hex(token), created_at: new Date().toISOString() }, { onConflict: "user_id" }));
    showSetup(token);
  }));
  const r = tok?.last_result;
  fill(hcBox,
    tok?.last_used_at
      ? h("div", { class: "note small" }, `Last sync ${new Date(tok.last_used_at).toLocaleString()}`,
          r?.records ? ` · ${r.records.steps ?? 0} step, ${r.records.heart_rate ?? 0} heart-rate, ${r.records.exercise ?? 0} exercise, ${r.records.sleep ?? 0} sleep records` : "",
          r?.workouts_new ? ` · ${r.workouts_new} new workouts` : "", r?.sessions_detected ? ` · ${r.sessions_detected} sessions detected` : "")
      : h("div", { class: "small muted" }, tok ? "Token made; no data received yet." : "Band → Mi Fitness → Health Connect → HC Webhook → Tenth. Steps, sleep, heart rate and workouts arrive on their own."));

  const exportBtn = h("button", { class: "btn secondary" }, "Export all data (JSON)");
  exportBtn.addEventListener("click", () => busy(exportBtn, async () => {
    const tables = ["profile", "body_metrics", "daily_activity", "foods", "food_logs", "saved_meals", "workouts", "daily_targets", "coach_notes", "coach_messages"];
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
    h("div", { class: "row" }, h("h1", { class: "screen-title" }, "Settings"),
      state.profile ? h("button", { class: "chip", onclick: () => { state.tab = "today"; render(); } }, "Done") : null),
    h("div", { class: "card" },
      h("h3", {}, "Goal and profile"),
      !state.profile ? h("div", { class: "warn" }, "Fill this in first; the plan needs it.") : null,
      h("div", { class: "grid-2" }, field("target_bf_pct", "Goal body fat %"), field("loss_rate_pct", "Pace: % of weight / week")),
      h("div", { class: "small muted" }, "0.5% a week is gentle on muscle; 1.0% is the fastest allowed."),
      h("div", { class: "grid-2" }, h("div", {}, h("label", {}, "Sex"), sex), field("birth_date", "Birth date", "date")),
      h("div", { class: "grid-2" }, field("height_cm", "Height cm"), field("max_hr", "Max heart rate (observed)")),
      h("div", { class: "grid-3" }, field("protein_g_per_kg", "Protein g/kg"), field("fat_g_per_kg", "Fat g/kg"), field("activity_factor", "Daily movement")),
      h("div", { class: "small muted" }, "Daily movement covers life outside logged workouts: 1.2 desk job, 1.35 on your feet some of the day, 1.5 on your feet most of it."),
      h("div", { style: "height:10px" }), save),
    h("div", { class: "card stack" }, h("h3", {}, "Band data (Health Connect)"), hcBox, newToken),
    h("div", { class: "card stack" }, h("h3", {}, "What the coach remembers"),
      notes.length ? null : h("div", { class: "small muted" }, "Nothing yet. When the coach suggests something worth remembering, it asks you first."),
      ...notes.map((n) => h("div", { class: "list-row" },
        h("span", {}, n.note),
        h("button", {
          class: "icon-btn ghost", "aria-label": "Forget this",
          onclick: (ev) => busy(ev.currentTarget, async () => { must(await sb.from("coach_notes").delete().eq("id", n.id)); render(); }),
        }, "✕")))),
    h("div", { class: "card stack" },
      h("h3", {}, "App"),
      installBtn,
      !installBtn ? h("div", { class: "small muted" }, "To install: Chrome menu ⋮ → Add to Home screen. Installed, it appears in the Android share sheet for Mi Fitness images.") : null,
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
const fab = document.getElementById("fab");

async function render() {
  document.getElementById("brand").textContent = APP_NAME;
  if (!state.session) {
    tabs.hidden = true;
    fab.hidden = true;
    renderSignIn(view);
    return;
  }
  tabs.hidden = false;
  // The + stays in the corner on every screen except the chat, where the message box sits
  fab.hidden = state.tab === "coach" || state.tab === "settings";
  document.body.classList.toggle("chat-open", state.tab === "coach");
  for (const b of tabs.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === state.tab);
  try {
    if (state.tab === "today") await renderToday(view);
    else if (state.tab === "food") await renderFood(view);
    else if (state.tab === "progress") await renderProgress(view);
    else if (state.tab === "coach") await renderCoach(view);
    else await renderSettings(view);
  } catch (e) {
    fill(view, h("div", { class: "warn" }, e.message || String(e)));
  }
}

tabs.addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b) return;
  state.tab = b.dataset.tab;
  if (state.tab === "today") state.day = today();
  window.scrollTo(0, 0);
  render();
});
fab.addEventListener("click", openAddSheet);
document.getElementById("settings-btn").addEventListener("click", () => { state.tab = "settings"; window.scrollTo(0, 0); render(); });

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  state.installPrompt = e;
});

// New day while the app sat open (or the phone crossed time zones): move to the new today
state.lastToday = today();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !state.session) return;
  const t = today();
  if (t !== state.lastToday) {
    if (state.day === state.lastToday) state.day = t;
    state.lastToday = t;
    state.goal = null;
    syncTimeZone();
    if (!sheet.open) render();
  }
});

/** Keep the profile's time zone matching the phone, so band data lands on the right days when you travel. */
async function syncTimeZone() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!tz || !state.profile || state.profile.time_zone === tz) return;
  const { error } = await sb.from("profile").update({ time_zone: tz }).eq("user_id", state.profile.user_id);
  if (!error) state.profile.time_zone = tz;
}

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
  else syncTimeZone();
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
