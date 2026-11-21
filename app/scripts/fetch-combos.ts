/**
 * Fetches all MTG combo data from:
 *   1. EDHREC JSON API (top 100 per color identity - has popularity/deck counts)
 *   2. Commander Spellbook API (full dataset - paginated)
 *
 * Merges and deduplicates into a single graph-ready JSON file.
 *
 * Run: npx tsx scripts/fetch-combos.ts
 *
 * Patch the existing combos.json without refetching every combo (re-runs Scryfall
 * enrichment, fills in missing combo descriptions, re-dedupes). Safe to re-run; it resumes:
 *      npx tsx scripts/fetch-combos.ts --enrich-only
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ENRICH_ONLY = process.argv.includes("--enrich-only");
const OUT_PATH = path.resolve(import.meta.dirname, "../public/data/combos.json");

// Spellbook has 100k+ variants sorted by popularity (EDHREC deck count) desc; the long
// tail is mostly 0-5 decks. Stop paginating once a whole page falls below this floor.
const MIN_SPELLBOOK_DECKS = 50;

// Formats we record per-card legality for (Scryfall's legality keys). The app's format
// filter shows a combo when every card in it is legal in the chosen format.
const FORMATS = [
  "commander", "standard", "pioneer", "modern", "legacy", "vintage", "pauper",
  "brawl", "standardbrawl", "paupercommander", "oathbreaker", "premodern", "historic", "timeless",
];

// Scryfall requires a User-Agent + Accept header on API requests
const HEADERS = { "User-Agent": "MTGComboNetwork/1.0", "Accept": "application/json" };

const COLOR_SLUGS = [
  "colorless",
  "mono-white", "mono-blue", "mono-black", "mono-red", "mono-green",
  "azorius", "dimir", "rakdos", "gruul", "selesnya",
  "orzhov", "izzet", "golgari", "boros", "simic",
  "esper", "grixis", "jund", "naya", "bant",
  "abzan", "jeskai", "sultai", "mardu", "temur",
  "yore-tiller", "glint-eye", "dune-brood", "ink-treader", "witch-maw",
  "five-color",
];

// -- Shared output types --

interface CardNode {
  id: string;       // oracle ID
  name: string;
  colors: string;   // color identity e.g. "WU", "B", "" for colorless
  image: string;    // scryfall image URL (normal size)
  typeLine: string; // e.g. "Artifact", "Creature — Human Wizard"
  cmc: number;      // converted mana cost
  legal: string[];  // formats (from FORMATS) where the card is legal or restricted
}

interface ComboLink {
  source: string;   // oracle ID
  target: string;   // oracle ID
  comboId: string;
}

interface ComboMeta {
  id: string;
  cards: string[];   // oracle IDs
  colors: string;
  deckCount: number;
  results: string[];
  description: string;     // step-by-step instructions (from Spellbook)
  prerequisites: string;   // easy prerequisites text
  manaNeeded: string;      // mana cost to start the combo
}

// -- Shared state --

const cards = new Map<string, CardNode>();
const combos = new Map<string, ComboMeta>();
const linkSet = new Set<string>();
const links: ComboLink[] = [];
// Card IDs confirmed to be real Scryfall oracle IDs (EDHREC's card IDs are not)
const oracleVerified = new Set<string>();

function addCombo(comboId: string, cardEntries: { id: string; name: string }[], colors: string, deckCount: number, results: string[], description = '', prerequisites = '', manaNeeded = '') {
  if (combos.has(comboId)) {
    const existing = combos.get(comboId)!;
    if (deckCount > existing.deckCount) existing.deckCount = deckCount;
    // Backfill description if existing combo lacks it
    if (!existing.description && description) existing.description = description;
    if (!existing.prerequisites && prerequisites) existing.prerequisites = prerequisites;
    if (!existing.manaNeeded && manaNeeded) existing.manaNeeded = manaNeeded;
    return;
  }

  const cardIds: string[] = [];
  for (const c of cardEntries) {
    if (!cards.has(c.id)) cards.set(c.id, { id: c.id, name: c.name, colors: '', image: '', typeLine: '', cmc: 0, legal: [] });
    cardIds.push(c.id);
  }

  combos.set(comboId, { id: comboId, cards: cardIds, colors, deckCount, results, description, prerequisites, manaNeeded });

  for (let i = 0; i < cardIds.length; i++) {
    for (let j = i + 1; j < cardIds.length; j++) {
      const a = cardIds[i] < cardIds[j] ? cardIds[i] : cardIds[j];
      const b = cardIds[i] < cardIds[j] ? cardIds[j] : cardIds[i];
      const key = `${a}|${b}|${comboId}`;
      if (!linkSet.has(key)) {
        linkSet.add(key);
        links.push({ source: a, target: b, comboId });
      }
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Retries rate limits (403/429), server errors, and network failures with exponential backoff
const RETRYABLE = new Set([403, 429, 500, 502, 503, 504]);
async function fetchWithRetry(url: string, retries = 4, baseMs = 2000): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(url, { headers: HEADERS });
      if (res.ok || !RETRYABLE.has(res.status) || attempt >= retries) return res;
    } catch (e) {
      if (attempt >= retries) throw e;
    }
    const retryAfter = Number(res?.headers.get("retry-after"));
    const wait = retryAfter > 0 ? retryAfter * 1000 : baseMs * 2 ** attempt;
    console.warn(`    ${res ? `HTTP ${res.status}` : "Network error"}, retrying in ${wait / 1000}s...`);
    await res?.body?.cancel();
    await sleep(wait);
  }
}

// -- EDHREC --

async function fetchEDHREC() {
  console.log("=== Fetching from EDHREC ===");
  for (const slug of COLOR_SLUGS) {
    const url = `https://json.edhrec.com/pages/combos/${slug}.json`;
    console.log(`  ${slug}...`);
    try {
      const res = await fetchWithRetry(url);
      if (!res.ok) { console.error(`    ${res.status}`); continue; }
      const page = await res.json();
      const entries = page.container?.json_dict?.cardlists ?? [];
      for (const entry of entries) {
        const c = entry.combo;
        if (!c) continue;
        addCombo(
          c.comboId,
          entry.cardviews.map((cv: any) => ({ id: cv.id, name: cv.name })),
          c.colors,
          c.count ?? 0,
          c.results ?? [],
        );
      }
      console.log(`    ${entries.length} combos`);
    } catch (e) {
      console.error(`    Failed: ${e}`);
    }
    await sleep(250);
  }
  console.log(`  EDHREC done. Running total: ${combos.size} combos, ${cards.size} cards`);
}

// -- Commander Spellbook API --

async function fetchSpellbook() {
  console.log("\n=== Fetching from Commander Spellbook API ===");
  const LIMIT = 100; // Spellbook caps page size at 100
  let url: string | null = `https://backend.commanderspellbook.com/variants/?limit=${LIMIT}&offset=0&status=OK`;
  let page = 0;

  while (url) {
    try {
      const res = await fetchWithRetry(url);
      if (!res.ok) { console.error(`  HTTP ${res.status} at offset ${page * LIMIT} — stopping early, data will be partial`); break; }
      const data = await res.json();
      const results = data.results ?? [];

      let belowFloor = 0;
      for (const v of results) {
        // Skip long-tail combos, but still let them backfill descriptions on EDHREC combos we already have
        if ((v.popularity ?? 0) < MIN_SPELLBOOK_DECKS && !combos.has(v.id)) { belowFloor++; continue; }
        const cardEntries = (v.uses ?? []).map((u: any) => ({
          id: u.card.oracleId,
          name: u.card.name,
        }));
        addCombo(
          v.id,
          cardEntries,
          v.identity ?? "",
          v.popularity ?? 0,
          (v.produces ?? []).map((p: any) => p.feature?.name).filter(Boolean),
          v.description ?? '',
          v.easyPrerequisites ?? '',
          v.manaNeeded ?? '',
        );
      }

      page++;
      if (page % 10 === 0) {
        console.log(`  Page ${page}: ${results.length} results (total combos: ${combos.size}, cards: ${cards.size})`);
      }

      if (results.length > 0 && belowFloor === results.length) {
        console.log(`  Reached popularity floor (<${MIN_SPELLBOOK_DECKS} decks) at offset ${page * LIMIT}`);
        break;
      }

      url = data.next;
    } catch (e) {
      console.error(`  Error on page ${page}: ${e}`);
      break;
    }
    await sleep(100);
  }
  console.log(`  Spellbook done. Total: ${combos.size} combos, ${cards.size} cards`);
}

// -- Scryfall bulk data enrichment --

async function enrichWithScryfall() {
  console.log("\n=== Enriching with Scryfall bulk data ===");

  // Step 1: Get the current bulk data download URL
  console.log("  Fetching bulk data manifest...");
  const bulkRes = await fetchWithRetry("https://api.scryfall.com/bulk-data");
  if (!bulkRes.ok) throw new Error(`Scryfall bulk manifest: HTTP ${bulkRes.status}`);
  const bulkData = await bulkRes.json();
  const oracleEntry = bulkData.data.find((d: any) => d.type === "oracle_cards");
  if (!oracleEntry) throw new Error("Could not find oracle_cards bulk data");

  // Scryfall now serves gzipped JSON Lines (jsonl_download_uri); older manifests had a plain JSON array (download_uri)
  const isJsonl = !!oracleEntry.jsonl_download_uri;
  const dlUri = oracleEntry.jsonl_download_uri ?? oracleEntry.download_uri;
  if (!dlUri) throw new Error(`No download URI in oracle_cards entry: ${JSON.stringify(oracleEntry)}`);

  console.log(`  Downloading oracle cards from ${dlUri}...`);
  const dlRes = await fetchWithRetry(dlUri);
  if (!dlRes.ok) throw new Error(`Scryfall bulk download: HTTP ${dlRes.status}`);
  let buf = Buffer.from(await dlRes.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf); // gzip magic bytes
  const text = buf.toString("utf8");
  const allCards: any[] = isJsonl
    ? text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    : JSON.parse(text);
  console.log(`  Downloaded ${allCards.length} cards`);

  // Step 2: Build oracle ID -> card data lookup
  const oracleMap = new Map<string, any>();
  for (const card of allCards) {
    if (card.oracle_id) oracleMap.set(card.oracle_id, card);
  }

  // Step 3: Build name -> card lookup for fallback matching
  // Tokens and art cards share names with real cards, so keep them out of the name lookups.
  // EDHREC lists double-faced/adventure cards by front face only ("Fable of the Mirror-Breaker"),
  // while Scryfall and Spellbook use the full "Front // Back" name, so index front faces too.
  const SKIP_LAYOUTS = new Set(["art_series", "token", "double_faced_token", "emblem"]);
  const isLegal = (c: any) => c.legalities?.commander === "legal";
  const nameMap = new Map<string, any>();
  const frontFaceMap = new Map<string, any>();
  const put = (map: Map<string, any>, key: string, card: any) => {
    const prev = map.get(key);
    if (!prev || (!isLegal(prev) && isLegal(card))) map.set(key, card);
  };
  for (const card of allCards) {
    if (!card.name || SKIP_LAYOUTS.has(card.layout)) continue;
    const key = card.name.toLowerCase();
    put(nameMap, key, card);
    const sep = key.indexOf(" // ");
    if (sep !== -1) put(frontFaceMap, key.slice(0, sep), card);
  }

  // Step 4: Enrich our cards (oracle ID first, then name fallback)
  let enriched = 0;
  let enrichedByName = 0;
  for (const [oracleId, node] of cards) {
    const nameKey = node.name.toLowerCase();
    const scryfall = oracleMap.get(oracleId) ?? nameMap.get(nameKey) ?? frontFaceMap.get(nameKey);
    if (!scryfall) continue;

    // Canonical Scryfall name, so the same card from EDHREC and Spellbook merges in dedup
    node.name = scryfall.name;
    if (scryfall.oracle_id === oracleId) oracleVerified.add(oracleId);

    // color_identity is ["W","U"] etc
    node.colors = (scryfall.color_identity ?? []).join('');
    node.typeLine = scryfall.type_line ?? '';
    node.cmc = scryfall.cmc ?? 0;
    node.legal = FORMATS.filter((f) => {
      const status = scryfall.legalities?.[f];
      return status === "legal" || status === "restricted"; // restricted (Vintage) = playable as a 1-of
    });

    // Image: prefer normal size, handle double-faced cards
    if (scryfall.image_uris?.normal) {
      node.image = scryfall.image_uris.normal;
    } else if (scryfall.card_faces?.[0]?.image_uris?.normal) {
      node.image = scryfall.card_faces[0].image_uris.normal;
    }
    if (!oracleMap.has(oracleId)) enrichedByName++;
    enriched++;
  }
  console.log(`  Enriched ${enriched}/${cards.size} cards (${enrichedByName} by name fallback)`);
}

// -- Deduplication --

function deduplicateByName() {
  console.log("\n=== Deduplicating cards by name ===");

  // Group card IDs by name
  const nameToIds = new Map<string, string[]>();
  for (const [id, node] of cards) {
    const key = node.name.toLowerCase();
    if (!nameToIds.has(key)) nameToIds.set(key, []);
    nameToIds.get(key)!.push(id);
  }

  // Build ID redirect map: duplicate ID -> canonical ID
  const redirect = new Map<string, string>();
  let dupeCount = 0;

  for (const [, ids] of nameToIds) {
    if (ids.length <= 1) continue;

    // Prefer the enriched version (has colors or image)
    // Prefer the real oracle ID, then any enriched version (has colors or image)
    const enrichedId = ids.find(id => oracleVerified.has(id))
      ?? ids.find(id => cards.get(id)!.colors || cards.get(id)!.image) ?? ids[0];

    for (const id of ids) {
      if (id === enrichedId) continue;
      // Merge combo count: the enriched node keeps all references
      redirect.set(id, enrichedId);
      cards.delete(id);
      dupeCount++;
    }
  }

  console.log(`  Removed ${dupeCount} duplicate nodes (${cards.size} remaining)`);

  // Redirect combo card references
  let comboFixCount = 0;
  for (const [, combo] of combos) {
    for (let i = 0; i < combo.cards.length; i++) {
      const newId = redirect.get(combo.cards[i]);
      if (newId) { combo.cards[i] = newId; comboFixCount++; }
    }
  }
  console.log(`  Redirected ${comboFixCount} combo card references`);

  // Rebuild links from scratch (old links reference stale IDs)
  links.length = 0;
  linkSet.clear();
  for (const [, combo] of combos) {
    const cardIds = combo.cards;
    for (let i = 0; i < cardIds.length; i++) {
      for (let j = i + 1; j < cardIds.length; j++) {
        const a = cardIds[i] < cardIds[j] ? cardIds[i] : cardIds[j];
        const b = cardIds[i] < cardIds[j] ? cardIds[j] : cardIds[i];
        const key = `${a}|${b}|${combo.id}`;
        if (!linkSet.has(key)) {
          linkSet.add(key);
          links.push({ source: a, target: b, comboId: combo.id });
        }
      }
    }
  }
  console.log(`  Rebuilt ${links.length} links`);
}

// -- Enrich combos with Spellbook individual lookups --

async function enrichWithSpellbook() {
  const toEnrich = Array.from(combos.values()).filter(c => !c.description);
  if (toEnrich.length === 0) {
    console.log("\n=== Spellbook enrichment: all combos already have descriptions ===");
    return;
  }
  console.log(`\n=== Enriching ${toEnrich.length} combos from Commander Spellbook ===`);

  // One request at a time with long backoff: Spellbook rate-limits bursts (429) for minutes at a stretch
  let enriched = 0;
  let notFound = 0;
  for (let i = 0; i < toEnrich.length; i++) {
    const combo = toEnrich[i];
    let res: Response;
    try {
      res = await fetchWithRetry(`https://backend.commanderspellbook.com/variants/${combo.id}/`, 5, 15000);
    } catch (e) {
      console.error(`  Network error on ${combo.id}, stopping enrichment: ${e}`);
      break;
    }
    if (res.status === 404) { notFound++; continue; }
    if (!res.ok) {
      console.error(`  HTTP ${res.status} on ${combo.id} after retries, stopping. Re-run with --enrich-only later to resume.`);
      break;
    }
    const data = await res.json();
    if (data.description) combo.description = data.description;
    if (data.manaNeeded) combo.manaNeeded = data.manaNeeded;
    const prereqs = [data.easyPrerequisites, data.notablePrerequisites].filter(Boolean).join(" ");
    if (prereqs) combo.prerequisites = prereqs;
    enriched++;

    if ((i + 1) % 50 === 0) console.log(`  Progress: ${i + 1}/${toEnrich.length} (${enriched} enriched, ${notFound} not found)`);
    await sleep(400);
  }
  console.log(`  Spellbook enrichment done: ${enriched} enriched, ${notFound} not found, ${toEnrich.length - enriched - notFound} skipped`);
}

// -- Load previous output (for --enrich-only) --

function loadExisting() {
  console.log(`=== Loading existing data from ${OUT_PATH} ===`);
  const prev = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
  for (const n of prev.nodes) cards.set(n.id, { legal: [], ...n });
  for (const c of prev.combos) combos.set(c.id, c);
  // Links are rebuilt from combos in deduplicateByName()
  console.log(`  ${cards.size} cards, ${combos.size} combos`);
}

// -- Main --

async function main() {
  if (ENRICH_ONLY) {
    loadExisting();
  } else {
    await fetchEDHREC();
    await fetchSpellbook();
  }
  // Scryfall runs between the two Spellbook passes so Spellbook's rate limit has time to cool down
  await enrichWithScryfall();
  await enrichWithSpellbook();
  deduplicateByName();

  const output = {
    generatedAt: new Date().toISOString(),
    nodes: Array.from(cards.values()),
    links,
    combos: Array.from(combos.values()),
  };

  const described = output.combos.filter(c => c.description).length;
  console.log(`\nFinal: ${output.nodes.length} cards, ${output.combos.length} combos (${described} with descriptions), ${output.links.length} links`);

  // Write to a temp file first so a crash mid-write can't leave a truncated combos.json
  const tmpPath = OUT_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(output));
  fs.renameSync(tmpPath, OUT_PATH);
  console.log(`Written to ${OUT_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
