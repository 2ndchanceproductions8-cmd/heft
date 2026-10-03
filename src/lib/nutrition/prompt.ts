/*
 * The meal-analysis prompt, ported from SnapPlate (app/api/analyze/route.ts buildPrompt). Claude's job is
 * RECOGNITION + PORTION only; USDA supplies the numbers (lib/nutrition/usda.ts, ground.ts) and Claude's own
 * nutrient figures are a labelled fallback. The output FORMAT is enforced by structured outputs (schema.ts), so
 * SnapPlate's "STRICT JSON / no fences / match this schema" paragraph is gone; field names are still used
 * below where the guidance refers to them.
 */

export interface PromptInput {
  imageCount: number;
  description?: string | null;
  weightG?: number | null;
}

export function buildPrompt({ imageCount, description, weightG }: PromptInput): string {
  const hasImage = imageCount > 0;
  const desc = description?.trim() ?? '';
  const weight = typeof weightG === 'number' && Number.isFinite(weightG) && weightG > 0 ? Math.round(weightG * 10) / 10 : null;
  const hasUserContext = !!(desc || weight);

  // Multi-frame's whole value is depth and occlusion: a single top-down shot hides how tall a pile of rice is,
  // and a side shot hides what's behind the chicken. The risk is the model treating each frame as a separate
  // meal, so say plainly that it is one meal and the union of items is what to report.
  const multiFrame =
    imageCount > 1
      ? `
You are given ${imageCount} PHOTOS OF THE SAME MEAL, taken from different angles or distances. They are labelled "Photo 1 of ${imageCount}", "Photo 2 of ${imageCount}", and so on.
- This is ONE meal, not ${imageCount} meals. NEVER add up the same food across photos.
- Report the UNION of distinct foods: if an item appears in several photos it is still ONE item, and if an item is visible in only one photo it still counts.
- Use the angles together to judge portion: a top-down frame shows surface area, a side or three-quarter frame shows HEIGHT and depth. A pile that looks large from above may be shallow. Cross-check before committing to weight_g.
- Use whichever frame shows an item most clearly to identify it, and prefer the sharpest, best-lit view for close judgement calls.
- Because you can see the food from multiple angles, portion estimates should be BETTER than from one photo — you may set "confidence" one level higher than a single frame would justify, provided the frames genuinely agree. If the frames seem to show DIFFERENT meals, say so in notes and describe only what is common to them.
`
      : '';

  const userContext = hasUserContext
    ? `
USER-PROVIDED CONTEXT — TREAT AS AUTHORITATIVE GROUND TRUTH. Do not second-guess these values or override them based on the image:
${desc ? `- Food description: ${desc}\n` : ''}${weight ? `- Weight: ${weight} grams (use this exact weight; do not re-estimate portion)\n` : ''}${
        hasImage
          ? "Use the image only to identify additional details the user may have omitted (sauces, oils, hidden ingredients, cooking method) and to refine identification. The user's description and weight are final."
          : 'No image was provided. Identify the food and estimate portion from the user-supplied description and weight.'
      }
`
    : '';

  // Portion error is the single largest source of inaccuracy, and it comes from one place: you cannot recover
  // absolute scale from a single photo without a reference of known size. Everything below anchors that scale,
  // then converts it to mass through volume and density rather than by eyeballing grams directly.
  const portionGuidance = hasImage
    ? `PORTION ESTIMATION — follow this procedure in order.

STEP 1 — Find a scale reference. Look carefully for an object of known real-world size in the frame. In descending order of reliability:
- US quarter: 24.3 mm across | penny: 19.1 mm | nickel: 21.2 mm | dime: 17.9 mm
- Credit/debit/ID card: 85.6 x 54 mm
- Standard soda/beer can: 66 mm across, 122 mm tall
- Smartphone: about 150 mm tall, 72 mm wide
- Dinner fork: about 180 mm long | teaspoon: about 140 mm
- Dinner plate: 260-280 mm across (use only if nothing better — plate sizes vary a lot)
- An adult thumb is about 20 mm wide at the nail; an adult palm about 90 mm across
Record whichever you used in "scale_reference" (use null if you truly found none).

STEP 2 — Establish scale. Using that object's known size, work out roughly how many millimetres one image-width represents. Sanity-check it against a second reference if one is visible.

STEP 3 — Estimate volume, not grams. For each food, judge its footprint (length x width) and its HEIGHT above the plate, and get an approximate volume in cubic centimetres. Height is the step people skip and it is where most error lives — a mound of rice that covers a third of the plate might be 15 mm deep or 50 mm deep, a 3x difference in mass.

STEP 4 — Convert volume to mass using typical densities (g per cubic cm):
- cooked rice, pasta, grains: 0.75 | mashed potato: 1.0 | bread: 0.3
- cooked meat, poultry, fish: 1.05 | stew or curry with sauce: 1.0
- raw leafy salad: 0.2 | chopped raw vegetables: 0.6 | cooked vegetables: 0.85
- cheese: 1.05 | nuts: 0.6 | oils and butter: 0.92 | milk and most drinks: 1.0
weight_g = volume_cm3 x density. Show your reasoning in the notes field when a portion is unusually hard to call.

STEP 5 — Sanity-check against normal serving sizes. A typical restaurant rice portion is 150-250 g, a chicken breast 120-180 g, a slice of bread 30-40 g. If your figure is far outside the usual range for that food, re-check your scale before committing to it.

Do not forget cooking fats. Oil used to fry or saute is invisible but calorie-dense — if a dish was clearly cooked in fat, include a separate item for it (a sauteed dish typically carries 5-15 g of oil).

If NO scale reference is present, say so in "scale_reference" (null) and in the notes, set confidence no higher than "medium", and be conservative: prefer a lower estimate over a speculative high one.`
    : 'Be conservative when uncertain. Note any assumptions in the notes field.';

  const notFoodGuidance = hasImage
    ? 'If the image does not depict food (or you cannot tell), set is_food to false, leave items empty, and explain briefly in notes.'
    : 'If the description does not refer to food (or is missing), set is_food to false, leave items empty, and explain briefly in notes.';

  return `You are a registered-dietitian-level food-recognition model. Your job is to IDENTIFY the foods and ESTIMATE each item's weight. A nutrition database will supply the actual calories and macros, so identification and portion accuracy are what matter most.
${multiFrame}${userContext}
${portionGuidance}

For EACH distinct food item:
- "name": a clear, human-friendly label.
- "fdc_query": a concise search phrase optimized for the USDA FoodData Central database — use the common food name plus cooking method, no brand names, no adjectives like "delicious". Examples: "rice, white, cooked", "chicken breast, roasted", "olive oil", "cheddar cheese". Prefer the cooked/prepared form that matches what is shown.
- "portion": the portion in everyday words, e.g. "1 cup" or "1 medium breast".
- "weight_g": edible weight in grams. This is used to scale database nutrients, so estimate it carefully. If a user-provided weight applies to the whole dish, partition it across items by visible proportion.
- The nutrient fields (calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg): your best estimate FOR THAT EXACT WEIGHT. These are only a fallback used when the database has no match — still fill them in reasonably.

Set "confidence" based on how sure you are about identification and portion (not the numbers): "high" only with a clear photo and obvious portions; "low" when the dish is ambiguous, portions are unclear, or hidden fats/oils are likely.

${notFoodGuidance}`;
}
