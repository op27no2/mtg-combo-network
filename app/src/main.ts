import './style.css'
import { Cosmograph } from '@cosmograph/cosmograph'

// --- Color mapping for MTG color identities (keep in sync with --mana-* in style.css) ---
const COLOR_MAP: Record<string, string> = {
  W: '#f9faf4',  // White
  U: '#0e68ab',  // Blue
  B: '#4b4556',  // Black, drawn as charcoal so it stays visible on the dark canvas
  R: '#d3202a',  // Red
  G: '#00733e',  // Green
}
const COLORLESS = '#888888'
const MULTICOLOR = '#c9a94e' // gold for 3+ colors
const COLOR_NAMES: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' }

const GUILD_COLORS: Record<string, { color: string; name: string }> = {
  BG: { color: '#6aaa5a', name: 'Golgari' },
  BR: { color: '#b04040', name: 'Rakdos' },
  BU: { color: '#4070a0', name: 'Dimir' },
  BW: { color: '#b8a898', name: 'Orzhov' },
  GR: { color: '#b8a030', name: 'Gruul' },
  GU: { color: '#40a880', name: 'Simic' },
  GW: { color: '#a0d8a0', name: 'Selesnya' },
  RU: { color: '#a060c0', name: 'Izzet' },
  RW: { color: '#f0a0a0', name: 'Boros' },
  UW: { color: '#b3d4f0', name: 'Azorius' },
}

function identityToColor(identity: string): string {
  if (!identity || identity.length === 0) return COLORLESS
  if (identity.length === 1) return COLOR_MAP[identity] ?? COLORLESS
  const sorted = identity.split('').sort().join('')
  if (sorted.length === 2 && GUILD_COLORS[sorted]) return GUILD_COLORS[sorted].color
  return MULTICOLOR
}

// --- Small rendering helpers ---
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function esc(text: string): string {
  return text.replace(/[&<>"']/g, ch => ESCAPES[ch])
}

/** Escapes text and turns mana symbols like {2}{U} or {W/U} into Scryfall symbol icons. */
function richText(text: string): string {
  return esc(text)
    .replace(/\{([^{}]+)\}/g, (whole, sym: string) => {
      const file = sym.replace(/\//g, '').toUpperCase()
      if (!/^[A-Z0-9]+$/.test(file)) return whole
      return `<img class="mana-sym" src="https://svgs.scryfall.io/card-symbols/${file}.svg" alt="${whole}" title="${whole}" loading="lazy" />`
    })
    .replace(/\n+/g, '<br />')
}

/** Double-faced cards have long "Front // Back" names; show just the front where space is tight. */
function shortName(name: string): string {
  const sep = name.indexOf(' // ')
  return sep !== -1 && name.length > 28 ? name.substring(0, sep) : name
}

/**
 * Point indices of the largest connected cluster, or null when no single cluster dominates.
 * The graph has one big network plus a few tiny stray combos that drift far away; framing
 * only the big one keeps it from shrinking to a speck when the view is fitted.
 */
function mainClusterIndices(pointCount: number, links: { sourceIndex: number; targetIndex: number }[]): number[] | null {
  if (pointCount < 200) return null // small enough to show everything
  const parent = Array.from({ length: pointCount }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  for (const l of links) {
    const a = find(l.sourceIndex)
    const b = find(l.targetIndex)
    if (a !== b) parent[a] = b
  }
  const sizes = new Map<number, number>()
  let bestRoot = -1
  let bestSize = 0
  for (let i = 0; i < pointCount; i++) {
    const root = find(i)
    const size = (sizes.get(root) ?? 0) + 1
    sizes.set(root, size)
    if (size > bestSize) {
      bestSize = size
      bestRoot = root
    }
  }
  if (bestSize < pointCount * 0.6) return null
  const indices: number[] = []
  for (let i = 0; i < pointCount; i++) if (find(i) === bestRoot) indices.push(i)
  return indices
}

function swatch(color: string): string {
  return `<span class="swatch" style="background:${color}"></span>`
}

// --- Types matching our JSON ---
interface CardNode {
  id: string
  name: string
  colors: string
  image: string
  typeLine: string
  cmc: number
  legal?: string[] // formats where the card is legal (Scryfall keys, e.g. "modern")
}

interface Combo {
  id: string
  cards: string[]
  colors: string
  deckCount: number // popularity, only used to list the most-played combos first
  results: string[]
  description: string
  prerequisites: string
  manaNeeded: string
}

interface ComboData {
  generatedAt?: string
  nodes: CardNode[]
  links: { source: string; target: string; comboId: string }[]
  combos: Combo[]
}

/** Pre-computed node positions (public/data/layout.json), keyed by card id. */
interface LayoutData {
  positions: Record<string, [number, number]>
}

const COMBOS_PER_PAGE = 20

/** What this device's GPU offers for the float-texture work the layout simulation does. */
function probeGpu() {
  const info = { webgl2: false, colorBufferFloat: false, floatBlend: false, halfFloat: false, maxTexture: 0, renderer: '' }
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return info
    info.webgl2 = true
    info.colorBufferFloat = Boolean(gl.getExtension('EXT_color_buffer_float'))
    info.floatBlend = Boolean(gl.getExtension('EXT_float_blend'))
    info.halfFloat = Boolean(gl.getExtension('EXT_color_buffer_half_float'))
    info.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    info.renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    // leave the defaults: treated as "can't simulate"
  }
  return info
}

/**
 * The layout simulation runs on the GPU and keeps node positions in float textures it renders
 * to. Without that ability it cannot run at all. (Devices that have it but still don't move
 * anything are caught after load by fallBackIfStuck.)
 */
function gpuCanSimulate(): boolean {
  const gpu = probeGpu()
  return gpu.webgl2 && gpu.colorBufferFloat
}

// --- Main ---
async function main() {
  const appEl = document.getElementById('app')!
  const statsEl = document.getElementById('stats')!
  const searchEl = document.getElementById('search') as HTMLInputElement
  const cardInfoEl = document.getElementById('card-info')!
  const loadingEl = document.getElementById('loading-overlay')!
  const legendBodyEl = document.getElementById('legend-body')!

  // The legend starts collapsed where it would cover too much of the graph
  if (window.innerHeight < 820 || window.innerWidth < 1100) document.getElementById('legend')!.removeAttribute('open')

  // --- Filters panel toggle (starts closed on small screens, where it floats over the graph) ---
  const filtersToggle = document.getElementById('filters-toggle')!
  const setFiltersOpen = (open: boolean) => {
    appEl.classList.toggle('filters-closed', !open)
    filtersToggle.setAttribute('aria-expanded', String(open))
  }
  if (window.matchMedia('(max-width: 960px)').matches) setFiltersOpen(false)
  filtersToggle.addEventListener('click', () => setFiltersOpen(appEl.classList.contains('filters-closed')))

  // --- Load data ---
  let data: ComboData
  try {
    // BASE_URL keeps this working when the site is served from a sub-path
    const res = await fetch(`${import.meta.env.BASE_URL}data/combos.json`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data = await res.json()
  } catch (e) {
    console.error('Failed to load combo data', e)
    loadingEl.classList.add('error')
    loadingEl.querySelector('.loading-text')!.textContent = 'Could not load combo data. Check your connection and reload the page.'
    return
  }

  if (data.generatedAt) {
    const updated = new Date(data.generatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    document.getElementById('data-updated')!.textContent = `Updated ${updated}.`
  }

  // --- Layout mode ---
  // Where the GPU can't run the simulation, nodes are pinned to a pre-computed layout instead.
  // ?layout=static and ?layout=live force a mode. ?export-layout saves the settled positions
  // as layout.json (put it in public/data/ after refreshing the card data).
  const params = new URLSearchParams(location.search)
  const exportLayout = params.has('export-layout')
  const layoutParam = params.get('layout')
  async function loadStaticLayout(): Promise<LayoutData['positions'] | null> {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}data/layout.json`)
      if (!res.ok) return null
      return ((await res.json()) as LayoutData).positions ?? null
    } catch {
      return null
    }
  }
  // Positions the nodes are pinned to; null while the simulation does the layout
  let staticLayout: LayoutData['positions'] | null = null
  let layoutReason = 'live simulation' // shown by ?debug
  if (!exportLayout && (layoutParam === 'static' || (layoutParam !== 'live' && !gpuCanSimulate()))) {
    staticLayout = await loadStaticLayout()
    layoutReason = staticLayout
      ? (layoutParam === 'static' ? 'static (forced by URL)' : 'static (GPU cannot render to float textures)')
      : 'live simulation (no saved layout found)'
  }
  if (staticLayout) appEl.classList.add('static-layout')

  // ?debug: an on-screen readout for diagnosing a device we can't attach a console to
  const debugLines: string[] = []
  const debugOn = params.has('debug')
  if (debugOn) {
    window.addEventListener('error', e => debugLines.push(`error: ${String(e.message).slice(0, 90)}`))
    window.addEventListener('unhandledrejection', e => debugLines.push(`rejection: ${String(e.reason).slice(0, 90)}`))
  }

  // Build lookup maps
  const cardById = new Map(data.nodes.map(n => [n.id, n]))
  const comboById = new Map(data.combos.map(c => [c.id, c]))
  const combosByCard = new Map<string, string[]>()
  for (const combo of data.combos) {
    for (const cardId of combo.cards) {
      if (!combosByCard.has(cardId)) combosByCard.set(cardId, [])
      combosByCard.get(cardId)!.push(combo.id)
    }
  }

  // Build name -> oracle ID lookups for deck import
  const cardByName = new Map<string, string>()
  const cardByFrontName = new Map<string, string>()
  for (const n of data.nodes) {
    cardByName.set(n.name.toLowerCase(), n.id)
    const slashIdx = n.name.indexOf(' // ')
    if (slashIdx !== -1) {
      cardByFrontName.set(n.name.substring(0, slashIdx).toLowerCase(), n.id)
    }
  }

  // --- Deck import state ---
  let deckCardIds: Set<string> | null = null
  let deckMode: 'internal' | 'extension' = 'internal'
  let deckColors = ''
  const DECK_HIGHLIGHT = '#00e5ff'

  // --- View state ---
  // Combos passing the current filters; null while nothing is filtered out
  let activeComboIds: Set<string> | null = null
  let selectedCardId: string | null = null
  let shownCombos = COMBOS_PER_PAGE
  // True once the user pans/zooms/drags; until then the view re-fits itself as the layout settles
  let userMoved = false
  // What node size stands for: how connected a card is, or its mana value
  let sizeMode: 'links' | 'cmc' = 'links'
  const SIZE_COLUMN = { links: 'sizeLinks', cmc: 'sizeCmc' } as const

  function renderStats(cards: number, combos: number, links: number) {
    const stat = (n: number, label: string, cls = '') => `<span class="stat ${cls}"><b>${n.toLocaleString()}</b>${label}</span>`
    const deck = deckCardIds !== null
      ? `<span class="stat-deck">Deck: ${deckCardIds.size} cards · ${deckMode}</span>`
      : ''
    statsEl.innerHTML = deck + stat(cards, 'cards') + stat(combos, 'combos') + stat(links, 'links', 'stat-links')
  }
  renderStats(data.nodes.length, data.combos.length, data.links.length)

  function parseDeckList(text: string): { matched: Map<string, number>; unmatched: string[] } {
    const matched = new Map<string, number>()
    const unmatched: string[] = []

    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('//') || line.startsWith('#')) continue
      if (/^(sideboard|commander|mainboard|companion|deck)$/i.test(line)) continue

      const m = line.match(/^(?:(\d+)\s*x?\s+)?(.+)$/i)
      if (!m) continue

      const qty = m[1] ? parseInt(m[1]) : 1
      const name = m[2].trim().toLowerCase()

      const id = cardByName.get(name) ?? cardByFrontName.get(name)
      if (id) {
        matched.set(id, (matched.get(id) ?? 0) + qty)
      } else {
        unmatched.push(m[2].trim())
      }
    }

    return { matched, unmatched }
  }

  /** Builds the Cosmograph points and links for a set of cards and the combo links between them. */
  function buildGraph(nodes: CardNode[], linkData: ComboData['links']) {
    const indexById = new Map(nodes.map((n, i) => [n.id, i]))

    // Link degree (number of connections per card) drives node size
    const degree = new Map<string, number>()
    for (const l of linkData) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1)
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1)
    }
    let maxDegree = 1
    for (const d of degree.values()) if (d > maxDegree) maxDegree = d

    // Hair-thin, faded links keep the full graph readable; small graphs can afford bolder ones.
    // (By default the engine also fades links that are long on screen, which in a small,
    // zoomed-in graph is all of them - so that fade is switched off there.)
    const isSmall = linkData.length <= 2000
    const linkWidth = linkData.length > 20000 ? 0.2 : isSmall ? 0.9 : 0.4
    const linkStyle = {
      linkOpacity: isSmall ? 0.85 : 0.5,
      linkVisibilityMinTransparency: isSmall ? 1 : 0.25,
    }

    const links = linkData.map(l => ({
      source: l.source,
      target: l.target,
      sourceIndex: indexById.get(l.source) ?? 0,
      targetIndex: indexById.get(l.target) ?? 0,
      color: identityToColor(comboById.get(l.comboId)?.colors ?? ''),
      width: linkWidth,
    }))

    const mainIndices = mainClusterIndices(nodes.length, links)
    const highlightDeck = deckCardIds !== null && deckMode === 'extension'

    // Middle of the saved layout, where cards it does not know are parked
    const known = staticLayout ? Object.values(staticLayout) : []
    const layoutCenter = known.length
      ? [known.reduce((sum, p) => sum + p[0], 0) / known.length, known.reduce((sum, p) => sum + p[1], 0) / known.length]
      : [0, 0]
    const points = nodes.map((n, i) => {
      // A card missing from the saved layout (data refreshed since) lands near the middle
      const pinned = staticLayout?.[n.id] ?? [layoutCenter[0] + ((i * 37) % 60) - 30, layoutCenter[1] + ((i * 53) % 60) - 30]
      return {
        id: n.id,
        index: i,
        label: shortName(n.name),
        // Node color = the card's color identity from Scryfall
        color: highlightDeck && deckCardIds!.has(n.id) ? DECK_HIGHLIGHT : identityToColor(n.colors),
        // Both sizings ride along as columns, so switching the "Node size" option only swaps
        // which column is drawn and leaves the layout alone
        sizeLinks: Math.max(2, Math.min(20, 2 + 18 * Math.sqrt((degree.get(n.id) ?? 0) / maxDegree))),
        sizeCmc: Math.max(2, Math.min(16, 2 + (n.cmc ?? 0))),
        // Only used when the layout is static (pointXBy / pointYBy)
        layoutX: pinned[0],
        layoutY: pinned[1],
      }
    })

    return { points, links, mainIndices, linkStyle }
  }

  const initialGraph = buildGraph(data.nodes, data.links)
  const points = initialGraph.points
  const links = initialGraph.links

  const container = document.getElementById('graph-container')!

  // What "fit view" frames: the main cluster when there is one, otherwise everything
  let fitIndices = initialGraph.mainIndices
  function fitGraph(duration: number) {
    if (fitIndices) graph.fitViewByIndices(fitIndices, duration, 0.1)
    else graph.fitView(duration, 0.1)
  }

  // How much dragging a node (or changing a physics setting) re-energizes a layout at rest
  const DRAG_REHEAT = 0.3

  // --- Node size vs. zoom ---
  // Out of the box nodes either keep a fixed size on screen, which leaves the small ones as
  // hard-to-click specks once you zoom in, or grow 1:1 with the zoom, which is far too much.
  // We take the usual middle road of graph viewers: nodes grow with the square root of the
  // zoom, counted from the zoom at which the graph fills the view, and stop at 4x.
  const ZOOM_GROWTH_EXPONENT = 0.5
  const ZOOM_GROWTH_MAX = 4
  const ZOOM_GROWTH_STEP = 1.02 // applied in 2% steps; finer than that is invisible
  let fitZoom: number | null = null // zoom level at which the current graph fills the view
  let nodeSizeSetting = 1 // the "Node size" slider
  let zoomGrowth = 1 // what zooming in currently adds on top of the slider
  let zoomSizingQueued = false
  let slowScaleTimer = 0

  // The engine has a zoom boost of its own: past zoom level 100 it enlarges nodes, up to 5x at
  // 500. Only small graphs (a deck, a narrow filter) get that far, and there it would stack on
  // top of our growth, so applyZoomSizing() swaps it for ours.
  const engineZoomBoost = (zoom: number) => Math.min(5, Math.max(1, zoom * 0.01))

  /**
   * Applies the whole of baseConfig. Cosmograph's setConfig() replaces everything, which is why
   * every setting lives in baseConfig, and it deep-walks all cards and links on each call
   * (~50ms), which is why the per-frame node scaling below doesn't go through it.
   */
  function pushConfig() {
    // setConfig() lands asynchronously and may carry an older node scale than the zoom has
    // reached in the meantime, so the current one is re-sent once it has been applied
    return graph.setConfig({ ...baseConfig }).then(() => { if (renderEngine()) pushNodeScale() })
  }

  /** The rendering engine underneath Cosmograph. `_cosmos` is a private field, so this may come back empty. */
  function renderEngine() {
    type Engine = { config?: { pointSizeScale?: number }; setConfigPartial(config: { pointSizeScale: number }): void }
    const engine = (graph as unknown as { _cosmos?: Partial<Engine> })._cosmos
    return typeof engine?.setConfigPartial === 'function' ? engine as Engine : null
  }

  /**
   * Sends just the node scale to the renderer. setConfig() is too slow to call on every frame
   * of a zoom gesture, so this hands the value straight to the engine. Should a future
   * Cosmograph version hide the engine, we fall back to one setConfig() once the zooming stops.
   */
  function pushNodeScale() {
    const pointSizeScale = baseConfig.pointSizeScale
    const engine = renderEngine()
    if (engine) {
      if (engine.config?.pointSizeScale !== pointSizeScale) engine.setConfigPartial({ pointSizeScale })
      return
    }
    window.clearTimeout(slowScaleTimer)
    slowScaleTimer = window.setTimeout(() => graph.setConfig({ ...baseConfig }), 150)
  }

  function applyZoomSizing() {
    zoomSizingQueued = false
    const zoom = graph.getZoomLevel()
    let growth = 1
    // Until the user takes over the camera the view is just being kept fitted: no growth there
    if (userMoved && fitZoom && zoom) {
      const wanted = Math.min(ZOOM_GROWTH_MAX, Math.max(1, (zoom / fitZoom) ** ZOOM_GROWTH_EXPONENT))
      // Growth counts from how the fitted graph looks, engine boost included
      const raw = wanted * engineZoomBoost(fitZoom) / engineZoomBoost(zoom)
      growth = ZOOM_GROWTH_STEP ** Math.round(Math.log(raw) / Math.log(ZOOM_GROWTH_STEP))
    }
    if (growth === zoomGrowth) return
    zoomGrowth = growth
    baseConfig.pointSizeScale = nodeSizeSetting * zoomGrowth
    pushNodeScale()
  }

  function queueZoomSizing() {
    if (zoomSizingQueued) return
    zoomSizingQueued = true
    requestAnimationFrame(applyZoomSizing)
  }

  /**
   * Works out the zoom level at which the graph fills the view, straight from the node
   * positions (one layout unit is one pixel at zoom 1), so it doesn't matter where the camera
   * happens to be. Mirrors the 10% padding fitGraph() uses, but ignores the outermost 0.2% of
   * nodes on each side, so a node the user dragged far away doesn't count.
   */
  async function updateFitZoom() {
    const indices = fitIndices
    const positions = await graph.getPointPositionsAsync()
    if (!positions || positions.length < 4 || indices !== fitIndices) return
    const count = indices ? indices.length : positions.length / 2
    const xs: number[] = []
    const ys: number[] = []
    for (let n = 0; n < count; n++) {
      const i = indices ? indices[n] : n
      const x = positions[2 * i]
      const y = positions[2 * i + 1]
      if (Number.isFinite(x) && Number.isFinite(y)) {
        xs.push(x)
        ys.push(y)
      }
    }
    if (xs.length < 2) return
    const span = (values: number[]) => {
      values.sort((a, b) => a - b)
      const trim = Math.floor(values.length * 0.002)
      return values[values.length - 1 - trim] - values[trim]
    }
    const spanX = span(xs)
    const spanY = span(ys)
    const { width, height } = container.getBoundingClientRect()
    if (!(spanX > 0) || !(spanY > 0) || !width || !height) return
    fitZoom = Math.min((width * 0.8) / spanX, (height * 0.8) / spanY)
    queueZoomSizing()
  }

  // Cosmograph's setConfig() replaces everything, so callbacks must live in baseConfig
  const callbacks = {
    onClick: async (index: number | undefined) => {
      if (index === undefined) {
        showDefaultInfo()
        return
      }
      const ids = await graph.getPointIdsByIndices([index])
      if (!ids || ids.length === 0) return
      showCardInfo(ids[0])
    },
    onLabelClick: (_index: number, id: string) => {
      showCardInfo(id)
    },
    onZoomStart: (_e: unknown, userDriven: boolean) => {
      if (userDriven) userMoved = true
    },
    onZoom: () => queueZoomSizing(),
    onDragStart: () => {
      userMoved = true
    },
    onDrag: () => {
      // Wake a resting layout so the dragged node's neighbors follow it. This replaces the
      // engine's own reheat (simulationAlphaOnDrag), which also fires on a plain click and
      // un-pauses a paused layout: while paused, a drag moves that one node and nothing else.
      if (!paused && !graph.isSimulationRunning) graph.start(DRAG_REHEAT)
    },
    onSimulationEnd: () => {
      if (!userMoved) fitGraph(600)
      updateFitZoom()
      exportSettledLayout()
    },
  }

  let baseConfig = {
    points,
    pointIdBy: 'id' as const,
    pointIndexBy: 'index' as const,
    pointLabelBy: 'label' as const,
    pointColorBy: 'color' as const,
    pointColorStrategy: 'direct' as const,
    pointSizeBy: SIZE_COLUMN[sizeMode] as string,
    pointSizeStrategy: 'direct' as const,
    pointSizeScale: 1,
    // Labels always favor the best-connected cards, so the landmarks stay put in either size mode
    pointLabelWeightBy: 'sizeLinks' as const,
    pointIncludeColumns: ['sizeLinks', 'sizeCmc'],

    links,
    linkSourceBy: 'source' as const,
    linkSourceIndexBy: 'sourceIndex' as const,
    linkTargetBy: 'target' as const,
    linkTargetIndexBy: 'targetIndex' as const,
    linkColorBy: 'color' as const,
    linkColorStrategy: 'direct' as const,
    linkWidthBy: 'width' as const,
    linkWidthStrategy: 'direct' as const,

    // With a static layout the nodes sit at their saved x/y and nothing is simulated
    enableSimulation: !staticLayout,
    pointXBy: (staticLayout ? 'layoutX' : undefined) as string | undefined,
    pointYBy: (staticLayout ? 'layoutY' : undefined) as string | undefined,
    enableDrag: true,
    selectPointOnClick: true,
    focusPointOnClick: true,
    // Gravity is the only force anchoring the layout to the center. Too weak (it used to be 0.05)
    // and the main network drifts off while the stray combos get shoved far away; at 0.4 it
    // settles in place within ~15s with the strays in a ring around it. Repulsion 1.3 keeps
    // the network from packing too tight. Keep in sync with the slider defaults in index.html.
    simulationGravity: 0.4,
    simulationRepulsion: 1.3,
    // Cool down faster and damp momentum harder than the defaults (5000 / 0.85), so the layout
    // comes to rest in seconds instead of sliding around for a minute
    simulationDecay: 2000,
    simulationFriction: 0.75,
    simulationLinkDistance: 10,
    // The engine's reheat-on-drag is off; the onDrag callback does it, and only when appropriate
    simulationAlphaOnDrag: 0,
    linkWidthScale: 1,

    // Look and feel
    backgroundColor: '#0e1016',
    unknownColor: '#333344',
    ...initialGraph.linkStyle, // link opacity/fade, chosen by graph size in buildGraph()
    // A thin rim in a lighter/darker shade of each node keeps dark cards visible and separates overlaps
    pointDefaultStrokeWidth: 1,
    pointDefaultStrokeColor: 'auto' as const,
    pointStrokeContrast: 0.22,
    hoveredPointCursor: 'pointer',
    renderHoveredPointRing: true,
    hoveredPointRingColor: '#c9a94e',
    focusedPointRingColor: '#c9a94e',
    pointLabelFontSize: 12,
    pointLabelClassName: 'background: rgba(11, 12, 16, 0.74); color: #e8e7e3; font-weight: 500; border-radius: 5px;',
    showHoveredPointLabel: true,
    hoveredPointLabelClassName: 'background: #c9a94e; color: #17140a; font-weight: 600; border-radius: 5px; filter: none;',

    ...callbacks,
  }

  const graph = new Cosmograph(container, baseConfig)

  // Keep the pointer captured by the canvas for the whole press. Card labels are HTML elements
  // on top of the canvas; without capture, dragging a node across one makes Cosmograph think the
  // pointer left the canvas, and it silently stops moving the node until the button is released.
  container.addEventListener('pointerdown', (event) => {
    if (event.target instanceof HTMLCanvasElement) event.target.setPointerCapture(event.pointerId)
  })

  // Re-fit the view a few times while the layout settles, unless the user has taken over the camera
  let fitTimers: number[] = []
  function scheduleAutoFit() {
    fitTimers.forEach(t => clearTimeout(t))
    fitTimers = [1500, 4000, 8000, 14000].map(delay =>
      window.setTimeout(() => {
        if (!userMoved) fitGraph(600)
        updateFitZoom() // the layout is still spreading out, so keep the zoom reference current
      }, delay))
  }

  // Reveal the graph once the data is in
  const hideLoading = () => loadingEl.classList.add('done')
  graph.dataUploaded().then(hideLoading, hideLoading)
  graph.dataUploaded().then(() => window.setTimeout(fallBackIfStuck, 1500), () => {})
  scheduleAutoFit()

  /**
   * Safety net for devices that pass the GPU check but still don't move anything: if the
   * simulation says it is running and no node has moved across two seconds of rendered frames,
   * switch to the saved layout.
   */
  async function fallBackIfStuck() {
    if (staticLayout || exportLayout || layoutParam === 'live') return
    const sample = () => graph.getPointPositionsAsync().catch(() => undefined)
    const before = await sample()
    let frames = 0
    let counting = true
    const countFrame = () => {
      frames++
      if (counting) requestAnimationFrame(countFrame)
    }
    requestAnimationFrame(countFrame)
    await new Promise(resolve => window.setTimeout(resolve, 2000))
    counting = false
    // A hidden tab renders nothing, and a layout that has already settled isn't stuck
    if (frames < 20 || !graph.isSimulationRunning || staticLayout) return
    const after = await sample()
    let moved = false
    if (before && after && before.length === after.length) {
      for (let i = 0; i < after.length && !moved; i++) moved = Math.abs(after[i] - before[i]) > 0.01
    }
    if (moved) return
    const layout = await loadStaticLayout()
    if (!layout) return
    staticLayout = layout
    layoutReason = 'static (simulation ran but nothing moved)'
    appEl.classList.add('static-layout')
    baseConfig.enableSimulation = false
    baseConfig.pointXBy = 'layoutX'
    baseConfig.pointYBy = 'layoutY'
    applyFilters() // rebuilds the graph, now pinned to the saved positions
  }

  if (debugOn) {
    const panel = document.createElement('pre')
    panel.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;margin:0;padding:8px 10px;max-height:55vh;overflow:auto;'
      + 'background:rgba(0,0,0,.88);color:#9f9;font:11px/1.45 monospace;white-space:pre-wrap;pointer-events:none'
    document.body.appendChild(panel)
    const gpu = probeGpu()
    const started = performance.now()
    let uploadedAt = 0
    graph.dataUploaded().then(() => { uploadedAt = performance.now() }, () => { debugLines.push('data upload failed') })
    let frames = 0
    const countFrame = () => { frames++; requestAnimationFrame(countFrame) }
    requestAnimationFrame(countFrame)
    const canvas = () => container.querySelector('canvas')
    let contextLost = 0
    let lostHooked = false
    const glErrors = new Set<string>()
    let previous: Float32Array | undefined
    let movement = 'n/a'
    window.setInterval(async () => {
      const c = canvas()
      if (c && !lostHooked) {
        lostHooked = true
        c.addEventListener('webglcontextlost', () => { contextLost++ })
      }
      const gl = c?.getContext('webgl2')
      if (gl) {
        const code = gl.getError()
        if (code !== gl.NO_ERROR) glErrors.add(`0x${code.toString(16)}`)
      }
      try {
        const now = await graph.getPointPositionsAsync()
        if (now && previous && now.length === previous.length) {
          let max = 0
          for (let i = 0; i < now.length; i++) max = Math.max(max, Math.abs(now[i] - previous[i]))
          movement = `${max.toFixed(2)} units in the last second`
        } else if (!now) {
          movement = 'position readback returned nothing'
        }
        previous = now ? new Float32Array(now) : undefined
      } catch (e) {
        movement = `position readback failed: ${String(e).slice(0, 60)}`
      }
      panel.textContent = [
        `layout: ${layoutReason}`,
        `simulation running: ${graph.isSimulationRunning} | progress: ${graph.progress ?? 'n/a'}`,
        `node movement: ${movement}`,
        `frames: ${frames} | points: ${baseConfig.points.length} | canvas: ${c ? `${c.width}x${c.height}` : 'none'} | dpr ${window.devicePixelRatio}`,
        `webgl2: ${gpu.webgl2} | float render: ${gpu.colorBufferFloat} | float blend: ${gpu.floatBlend} | half float: ${gpu.halfFloat} | max texture: ${gpu.maxTexture}`,
        `gpu: ${gpu.renderer}`,
        `gl errors: ${glErrors.size ? [...glErrors].join(' ') : 'none'} | context lost: ${contextLost}`,
        `data uploaded after: ${uploadedAt ? `${((uploadedAt - started) / 1000).toFixed(1)}s` : 'not yet'}`,
        `ua: ${navigator.userAgent.slice(0, 120)}`,
        ...debugLines.slice(0, 5),
      ].join('\n')
    }, 1000)
  }

  // ?export-layout: once the layout has settled, hand back the positions as layout.json
  let layoutExported = false
  async function exportSettledLayout() {
    if (!exportLayout || layoutExported || baseConfig.points.length !== data.nodes.length) return
    const positions = await graph.getPointPositionsAsync()
    if (!positions || positions.length < data.nodes.length * 2) return
    layoutExported = true
    const saved: LayoutData['positions'] = {}
    const round = (value: number) => Math.round(value * 10) / 10
    data.nodes.forEach((n, i) => { saved[n.id] = [round(positions[2 * i]), round(positions[2 * i + 1])] })
    const json = JSON.stringify({ generatedAt: new Date().toISOString(), positions: saved })
    ;(window as unknown as { exportedLayout?: string }).exportedLayout = json
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    link.download = 'layout.json'
    link.click()
  }

  // --- Simulation controls ---
  const pauseBtn = document.getElementById('pause-btn') as HTMLButtonElement
  let paused = false
  function setPaused(value: boolean) {
    paused = value
    pauseBtn.classList.toggle('is-paused', paused)
    pauseBtn.querySelector('span')!.textContent = paused ? 'Resume' : 'Pause'
  }

  pauseBtn.addEventListener('click', () => {
    if (paused) graph.unpause()
    else graph.pause()
    setPaused(!paused)
  })

  document.getElementById('reheat-btn')!.addEventListener('click', () => {
    graph.start(3)
    setPaused(false)
  })

  document.getElementById('fit-btn')!.addEventListener('click', () => {
    fitGraph(400)
    updateFitZoom()
  })

  // Paint the filled part of single-thumb sliders
  function paintSlider(input: HTMLInputElement) {
    const min = parseFloat(input.min)
    const max = parseFloat(input.max)
    input.style.setProperty('--fill', `${((parseFloat(input.value) - min) / (max - min)) * 100}%`)
  }
  document.querySelectorAll<HTMLInputElement>('input.slider').forEach(input => {
    paintSlider(input)
    input.addEventListener('input', () => paintSlider(input))
  })

  /**
   * Wires a "Graph settings" slider. `store` must write the value into baseConfig, so later
   * setConfig() calls (other sliders, filters) don't reset it.
   */
  function bindSlider(id: string, store: (value: number) => void, affectsLayout = false) {
    const input = document.getElementById(id) as HTMLInputElement
    const valSpan = input.nextElementSibling as HTMLSpanElement
    input.addEventListener('input', () => {
      const val = parseFloat(input.value)
      valSpan.textContent = String(val)
      store(val)
      pushConfig()
      // A physics change only shows while the layout is moving, so wake a settled layout up.
      // A paused one stays paused and picks the change up when it is resumed.
      if (affectsLayout && !paused && !graph.isSimulationRunning) graph.start(DRAG_REHEAT)
    })
  }

  bindSlider('ctrl-gravity', v => { baseConfig.simulationGravity = v }, true)
  bindSlider('ctrl-repulsion', v => { baseConfig.simulationRepulsion = v }, true)
  bindSlider('ctrl-link-dist', v => { baseConfig.simulationLinkDistance = v }, true)
  bindSlider('ctrl-link-width', v => { baseConfig.linkWidthScale = v })
  bindSlider('ctrl-node-size', v => {
    nodeSizeSetting = v
    baseConfig.pointSizeScale = nodeSizeSetting * zoomGrowth // on top of the growth from zooming in
  })

  // "Node size" option: how connected a card is, or its mana value
  const sizeModeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#size-mode-toggle button'))
  sizeModeButtons.forEach(button => button.addEventListener('click', () => {
    const mode = button.dataset.sizeMode === 'cmc' ? 'cmc' : 'links'
    if (mode === sizeMode) return
    sizeMode = mode
    sizeModeButtons.forEach(b => {
      b.classList.toggle('active', b === button)
      b.setAttribute('aria-pressed', String(b === button))
    })
    baseConfig.pointSizeBy = SIZE_COLUMN[sizeMode]
    pushConfig()
    renderLegend()
  }))

  // --- Filters ---
  function parseManaValue(mana: string): number {
    if (!mana) return 0
    let total = 0
    for (const m of mana.matchAll(/\{([^}]+)\}/g)) {
      const sym = m[1]
      if (sym === 'X') continue
      const n = parseInt(sym)
      total += isNaN(n) ? 1 : n // colored symbols = 1, generic = face value
    }
    return total
  }

  function getColorFilter(): Set<string> {
    const checked = new Set<string>()
    document.querySelectorAll('#color-filters input[type="checkbox"]').forEach(cb => {
      if ((cb as HTMLInputElement).checked) checked.add((cb as HTMLInputElement).value)
    })
    return checked
  }

  function cardMatchesColorFilter(card: CardNode, allowedColors: Set<string>): boolean {
    if (!card.colors) return allowedColors.has('C')
    // Card passes if ALL its colors are in the checked set
    return card.colors.split('').every(c => allowedColors.has(c))
  }

  function applyFilters() {
    const allowedColors = getColorFilter()
    const minCards = parseInt((document.getElementById('filter-min-cards') as HTMLInputElement).value)
    const maxCards = parseInt((document.getElementById('filter-max-cards') as HTMLInputElement).value)
    const minCmc = parseInt((document.getElementById('filter-min-cmc') as HTMLInputElement).value)
    const maxCmc = parseInt((document.getElementById('filter-max-cmc') as HTMLInputElement).value)
    const maxManaCost = parseInt((document.getElementById('filter-max-mana') as HTMLInputElement).value)

    // Every card in the data is Commander-legal, so "commander" means no format restriction
    const format = document.querySelector<HTMLInputElement>('#format-filters input:checked')?.value ?? 'commander'
    const legalInFormat = (card: CardNode) => format === 'commander' || (card.legal?.includes(format) ?? false)

    // Filter cards by format, color and CMC
    const passesCardFilter = (card: CardNode) =>
      legalInFormat(card) && cardMatchesColorFilter(card, allowedColors) && card.cmc >= minCmc && card.cmc <= maxCmc

    // Deck color identity set for extension mode filtering
    const deckColorSet = deckColors ? new Set(deckColors.split('')) : null

    // Find combos that match card-count filter, card filters, and deck filter
    const validComboIds = new Set<string>()
    for (const combo of data.combos) {
      if (combo.cards.length < minCards || combo.cards.length > maxCards) continue
      if (!combo.cards.every(cid => { const c = cardById.get(cid); return c && passesCardFilter(c) })) continue

      // Mana activation cost filter (10 = no limit)
      if (maxManaCost < 10 && combo.manaNeeded && parseManaValue(combo.manaNeeded) > maxManaCost) continue

      // Deck filtering layer
      if (deckCardIds !== null) {
        if (deckMode === 'internal') {
          if (!combo.cards.every(cid => deckCardIds!.has(cid))) continue
        } else {
          // Extension: at least one deck card, and combo must fit deck's color identity
          if (!combo.cards.some(cid => deckCardIds!.has(cid))) continue
          if (deckColorSet && combo.colors) {
            if (!combo.colors.split('').every(c => deckColorSet.has(c))) continue
          }
        }
      }

      validComboIds.add(combo.id)
    }

    // Cards that appear in at least one valid combo
    const validCardIds = new Set<string>()
    for (const combo of data.combos) {
      if (!validComboIds.has(combo.id)) continue
      for (const cid of combo.cards) validCardIds.add(cid)
    }

    // Rebuild the graph from the cards and links that survive the filters
    const filteredNodes = data.nodes.filter(n => validCardIds.has(n.id))
    const filteredLinkData = data.links
      .filter(l => validComboIds.has(l.comboId) && validCardIds.has(l.source) && validCardIds.has(l.target))
    const { points: filteredPoints, links: filteredLinks, mainIndices, linkStyle } = buildGraph(filteredNodes, filteredLinkData)

    // Cosmograph rejects an empty dataset, so when nothing matches we keep the old graph
    // loaded and cover it with the "No combos found" overlay instead
    if (filteredPoints.length > 0) {
      baseConfig.points = filteredPoints
      baseConfig.links = filteredLinks
      Object.assign(baseConfig, linkStyle)
      fitIndices = mainIndices
      fitZoom = null // measured again once the new layout has spread out
      userMoved = false // the graph just changed shape, so let it re-fit once it settles
      if (paused) {
        // A paused layout would leave the new cards piled on top of each other
        graph.unpause()
        setPaused(false)
      }
      pushConfig()
      scheduleAutoFit()
    }
    renderStats(filteredNodes.length, validComboIds.size, filteredLinks.length)

    // Keep an open card panel in step with the filters
    activeComboIds = validComboIds.size === data.combos.length ? null : validComboIds
    if (selectedCardId) showCardInfo(selectedCardId)

    // Show/hide empty state overlay
    const overlay = document.getElementById('empty-overlay')!
    if (validComboIds.size === 0 && data.combos.length > 0) {
      let hint = 'Try adjusting your filters.'
      if (deckCardIds !== null) {
        if (deckMode === 'internal') {
          hint = 'Your deck may not contain a full combo. Try switching to Extension mode.'
        } else {
          hint = 'Try broadening color or card-count filters.'
        }
      }
      overlay.querySelector('.empty-hint')!.textContent = hint
      overlay.style.display = 'flex'
    } else {
      overlay.style.display = 'none'
    }
  }

  // Bind filter controls
  document.querySelectorAll('#color-filters input').forEach(cb => cb.addEventListener('change', applyFilters))
  document.querySelectorAll('#format-filters input').forEach(radio => radio.addEventListener('change', applyFilters))

  function bindDualRange(minId: string, maxId: string, labelId: string) {
    const minEl = document.getElementById(minId) as HTMLInputElement
    const maxEl = document.getElementById(maxId) as HTMLInputElement
    const label = document.getElementById(labelId)!
    const wrap = minEl.parentElement!
    const lo = parseFloat(minEl.min)
    const span = parseFloat(minEl.max) - lo
    const paint = () => {
      // Paint the selected span between the two thumbs
      wrap.style.setProperty('--lo', String((parseInt(minEl.value) - lo) / span))
      wrap.style.setProperty('--hi', String((parseInt(maxEl.value) - lo) / span))
      label.textContent = `${minEl.value} – ${maxEl.value}`
    }
    const update = () => {
      if (parseInt(minEl.value) > parseInt(maxEl.value)) {
        // Clamp: whichever was just moved, match the other
        const active = document.activeElement
        if (active === minEl) maxEl.value = minEl.value
        else minEl.value = maxEl.value
      }
      paint()
      applyFilters()
    }
    minEl.addEventListener('input', update)
    maxEl.addEventListener('input', update)
    paint()
  }
  bindDualRange('filter-min-cards', 'filter-max-cards', 'cards-range-val')
  bindDualRange('filter-min-cmc', 'filter-max-cmc', 'cmc-range-val')

  // Mana activation cost slider
  const manaSlider = document.getElementById('filter-max-mana') as HTMLInputElement
  const manaLabel = document.getElementById('mana-range-val')!
  manaSlider.addEventListener('input', () => {
    manaLabel.textContent = manaSlider.value === '10' ? '10+' : manaSlider.value
    applyFilters()
  })

  // --- Deck import ---
  const deckInputEl = document.getElementById('deck-input') as HTMLTextAreaElement
  const deckImportBtn = document.getElementById('deck-import-btn') as HTMLButtonElement
  const deckClearBtn = document.getElementById('deck-clear-btn') as HTMLButtonElement
  const deckStatusEl = document.getElementById('deck-status')!
  const deckModeDesc = document.getElementById('deck-mode-desc')!
  const modeInternalBtn = document.getElementById('mode-internal') as HTMLButtonElement
  const modeExtensionBtn = document.getElementById('mode-extension') as HTMLButtonElement

  deckImportBtn.addEventListener('click', () => {
    const text = deckInputEl.value.trim()
    if (!text) return

    const { matched, unmatched } = parseDeckList(text)

    if (matched.size === 0) {
      deckStatusEl.style.display = 'block'
      deckStatusEl.innerHTML = `<span class="unmatched">No card names recognized. Check spelling or try different names.</span>`
      return
    }

    deckCardIds = new Set(matched.keys())

    // Compute deck color identity
    const colorSet = new Set<string>()
    for (const id of deckCardIds) {
      const card = cardById.get(id)
      if (card?.colors) {
        for (const c of card.colors) colorSet.add(c)
      }
    }
    deckColors = Array.from(colorSet).sort().join('')

    // Check how many combos exist for these cards
    let comboCount = 0
    for (const combo of data.combos) {
      if (deckMode === 'internal') {
        if (combo.cards.every(cid => deckCardIds!.has(cid))) comboCount++
      } else {
        if (combo.cards.some(cid => deckCardIds!.has(cid))) comboCount++
      }
    }

    const totalQty = Array.from(matched.values()).reduce((s, q) => s + q, 0)
    let statusHtml = `<span class="matched">${matched.size} unique cards matched (${totalQty} total)</span>`
    if (deckColors) {
      statusHtml += `<br><span class="deck-colors">Deck colors: ${deckColors.split('').join(', ')}</span>`
    } else {
      statusHtml += `<br><span class="deck-colors">Deck colors: Colorless</span>`
    }
    if (comboCount === 0) {
      statusHtml += `<br><span class="unmatched">No combos found for these cards in ${deckMode} mode. Try switching to Extension mode.</span>`
    }
    if (unmatched.length > 0) {
      statusHtml += `<br><span class="unmatched">${unmatched.length} not in combo database:</span>`
      statusHtml += `<br><span class="unmatched-list">${esc(unmatched.slice(0, 10).join(', '))}${unmatched.length > 10 ? ` (+${unmatched.length - 10} more)` : ''}</span>`
    }
    deckStatusEl.style.display = 'block'
    deckStatusEl.innerHTML = statusHtml
    deckClearBtn.disabled = false

    applyFilters()
    showDefaultInfo()
  })

  deckClearBtn.addEventListener('click', () => {
    deckCardIds = null
    deckColors = ''
    deckInputEl.value = ''
    deckStatusEl.style.display = 'none'
    deckClearBtn.disabled = true
    applyFilters()
    showDefaultInfo()
  })

  modeInternalBtn.addEventListener('click', () => {
    deckMode = 'internal'
    modeInternalBtn.classList.add('active')
    modeExtensionBtn.classList.remove('active')
    deckModeDesc.textContent = 'Show combos where ALL cards are in your deck'
    if (deckCardIds !== null) {
      applyFilters()
      showDefaultInfo()
    }
  })

  modeExtensionBtn.addEventListener('click', () => {
    deckMode = 'extension'
    modeExtensionBtn.classList.add('active')
    modeInternalBtn.classList.remove('active')
    deckModeDesc.textContent = 'Show combos sharing at least ONE card with your deck'
    if (deckCardIds !== null) {
      applyFilters()
      showDefaultInfo()
    }
  })

  // --- Card details panel ---

  /** A card's combos that pass the current filters, most-played first. */
  function sortedCombos(cardId: string): Combo[] {
    return (combosByCard.get(cardId) ?? [])
      .filter(cid => activeComboIds === null || activeComboIds.has(cid))
      .map(cid => comboById.get(cid))
      .filter((c): c is Combo => Boolean(c))
      .sort((a, b) => (b.deckCount ?? 0) - (a.deckCount ?? 0))
  }

  function comboItemHtml(combo: Combo, selectedId: string): string {
    const cardNames = combo.cards
      .map(cid => {
        const c = cardById.get(cid)
        const name = c ? esc(shortName(c.name)) : 'Unknown card'
        if (cid === selectedId || !c) return `<span class="this-card">${name}</span>`
        return `<button type="button" class="card-link" data-card-id="${esc(cid)}" title="Show ${esc(c.name)}">${name}</button>`
      })
      .join('<span class="plus">+</span>')

    const results = combo.results.map(r => `<li>${esc(r)}</li>`).join('')

    const parts: string[] = []
    if (combo.prerequisites) parts.push(`<div><strong>Prerequisites</strong>${richText(combo.prerequisites)}</div>`)
    if (combo.manaNeeded) parts.push(`<div><strong>Mana needed</strong>${richText(combo.manaNeeded)}</div>`)
    if (combo.description) {
      const steps = combo.description.split('\n').filter(s => s.trim())
      parts.push(`<div><strong>Steps</strong><ol class="combo-steps">${steps.map(s => `<li>${richText(s)}</li>`).join('')}</ol></div>`)
    }
    const hasDetails = parts.length > 0

    return `<article class="combo-item" style="--combo-color:${identityToColor(combo.colors)}">
      <div class="combo-cards">${cardNames}</div>
      ${results ? `<ul class="combo-results">${results}</ul>` : ''}
      <div class="combo-meta">
        ${hasDetails ? `<button type="button" class="combo-toggle" aria-expanded="false">Show steps</button>` : '<span></span>'}
        <a class="ext-link" href="https://commanderspellbook.com/combo/${encodeURIComponent(combo.id)}/" target="_blank" rel="noopener">Spellbook ↗</a>
      </div>
      ${hasDetails ? `<div class="combo-details" hidden>${parts.join('')}</div>` : ''}
    </article>`
  }

  function showMoreHtml(remaining: number): string {
    return remaining > 0
      ? `<button type="button" class="btn show-more">Show ${Math.min(COMBOS_PER_PAGE, remaining)} more</button>`
      : ''
  }

  function showCardInfo(cardId: string) {
    const card = cardById.get(cardId)
    if (!card) return
    selectedCardId = cardId
    shownCombos = COMBOS_PER_PAGE
    appEl.classList.add('has-card', 'seen-card') // opens the card pane; the canvas hint has done its job

    const combos = sortedCombos(cardId)
    const shown = combos.slice(0, shownCombos)
    const total = (combosByCard.get(cardId) ?? []).length
    const plural = (n: number) => `combo${n !== 1 ? 's' : ''}`
    const totalLabel = combos.length < total
      ? `${combos.length.toLocaleString()} of ${total.toLocaleString()} ${plural(total)} match your filters`
      : `${total.toLocaleString()} ${plural(total)}`

    const imageHtml = card.image
      ? `<img class="card-image" src="${esc(card.image)}" alt="${esc(card.name)}" />`
      : ''

    const identity = 'WUBRG'.split('').filter(c => card.colors.includes(c))
    const pips = identity.length > 0
      ? identity.map(c => `<span class="swatch" style="background:${COLOR_MAP[c]}" title="${COLOR_NAMES[c]}"></span>`).join('')
      : `<span class="swatch" style="background:${COLORLESS}" title="Colorless"></span>`

    const countLabel = combos.length > shown.length
      ? `Top ${shown.length} of ${combos.length.toLocaleString()}`
      : `${combos.length} ${plural(combos.length)}`

    cardInfoEl.innerHTML = `
      <div class="card-head">
        <div class="card-head-bar">
          <span class="section-title">Card</span>
          <button type="button" class="card-close" aria-label="Close card details" title="Close">
            <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true"><path d="M2 2l10 10M12 2 2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </button>
        </div>
        ${imageHtml}
        <h2 class="card-title">${esc(card.name)}</h2>
        ${card.typeLine ? `<p class="card-type">${esc(card.typeLine)}</p>` : ''}
        <div class="card-meta">
          <span class="card-pips">${pips}</span>
          <span>${totalLabel}</span>
          <a class="ext-link" href="https://scryfall.com/search?q=${encodeURIComponent(`!"${card.name}"`)}" target="_blank" rel="noopener">Scryfall ↗</a>
        </div>
      </div>
      <div class="combo-section">
        <div class="combo-section-head">
          <h3 class="section-title">Combos</h3>
          <span class="count">${countLabel}</span>
        </div>
        <div class="combo-list">${shown.map(c => comboItemHtml(c, cardId)).join('')}</div>
        ${combos.length === 0 ? '<p class="field-hint">None of this card’s combos match your current filters.</p>' : ''}
        ${showMoreHtml(combos.length - shown.length)}
      </div>
    `
    document.getElementById('panel-right')!.scrollTop = 0
  }

  /** A card plus every card it shares a combo with. */
  function neighborhood(cardId: string): string[] {
    const ids = new Set<string>([cardId])
    for (const comboId of combosByCard.get(cardId) ?? []) {
      for (const cid of comboById.get(comboId)?.cards ?? []) ids.add(cid)
    }
    return Array.from(ids)
  }

  /** Zooms the view to the given cards. A few cards alone would zoom in absurdly far, so their combo partners are framed too. */
  async function frameCards(cardIds: string[]) {
    const ids = cardIds.length <= 3 ? Array.from(new Set(cardIds.flatMap(neighborhood))) : cardIds
    const indices = (await graph.getPointIndicesByIds(ids) ?? []).filter(i => Number.isInteger(i) && i >= 0)
    if (indices.length > 1) {
      userMoved = true // the user chose this view; don't auto-fit over it
      graph.fitViewByIndices(indices, 500, 0.2)
    }
  }

  /** Opens a card's details and highlights it (and its combo partners) in the graph. */
  async function focusCard(cardId: string) {
    showCardInfo(cardId)
    const indices = await graph.getPointIndicesByIds([cardId])
    if (indices && indices.length > 0 && Number.isInteger(indices[0])) {
      graph.selectPoint(indices[0], false, true)
      graph.setFocusedPoint(indices[0])
      frameCards([cardId])
    }
  }

  // One delegated listener handles everything clickable inside the card panel
  cardInfoEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement

    const toggle = target.closest<HTMLElement>('.combo-toggle')
    if (toggle) {
      const details = toggle.closest('.combo-item')!.querySelector<HTMLElement>('.combo-details')!
      details.hidden = !details.hidden
      toggle.textContent = details.hidden ? 'Show steps' : 'Hide steps'
      toggle.setAttribute('aria-expanded', String(!details.hidden))
      return
    }

    const cardLink = target.closest<HTMLElement>('.card-link')
    if (cardLink?.dataset.cardId) {
      focusCard(cardLink.dataset.cardId)
      return
    }

    const more = target.closest<HTMLElement>('.show-more')
    if (more && selectedCardId) {
      const combos = sortedCombos(selectedCardId)
      const next = combos.slice(shownCombos, shownCombos + COMBOS_PER_PAGE)
      shownCombos += next.length
      cardInfoEl.querySelector('.combo-list')!.insertAdjacentHTML('beforeend', next.map(c => comboItemHtml(c, selectedCardId!)).join(''))
      cardInfoEl.querySelector('.combo-section-head .count')!.textContent = shownCombos < combos.length
        ? `Top ${shownCombos} of ${combos.length.toLocaleString()}`
        : `${combos.length} combos`
      more.outerHTML = showMoreHtml(combos.length - shownCombos)
      return
    }

    if (target.closest('.card-close')) {
      graph.unselectAllPoints()
      graph.setFocusedPoint(undefined)
      showDefaultInfo()
    }
  })

  // --- Search ---
  function searchMatches(): CardNode[] {
    const query = searchEl.value.trim().toLowerCase()
    if (!query) return []
    return data.nodes
      .filter(n => n.name.toLowerCase().includes(query))
      .slice(0, 50)
  }

  searchEl.addEventListener('input', async () => {
    const matches = searchMatches()
    if (matches.length === 0) {
      graph.unselectAllPoints()
      return
    }
    const indices = await graph.getPointIndicesByIds(matches.map(m => m.id))
    if (indices && indices.length > 0) {
      graph.selectPoints(indices)
      frameCards(matches.map(m => m.id))
    }
  })

  searchEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      // Open the exact match if there is one, otherwise the first result
      const matches = searchMatches()
      const query = searchEl.value.trim().toLowerCase()
      const best = matches.find(m => m.name.toLowerCase() === query || shortName(m.name).toLowerCase() === query) ?? matches[0]
      if (best) focusCard(best.id)
    } else if (event.key === 'Escape') {
      searchEl.value = ''
      searchEl.dispatchEvent(new Event('input'))
      searchEl.blur()
    }
  })

  // "/" jumps to search from anywhere outside a text field
  document.addEventListener('keydown', (event) => {
    const el = event.target as HTMLElement
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
    event.preventDefault()
    searchEl.focus()
    searchEl.select()
  })

  // --- Legend + empty state ---
  function renderLegend() {
    const item = (color: string, label: string) => `<span class="legend-item">${swatch(color)}${label}</span>`
    const deckItem = (deckCardIds !== null && deckMode === 'extension')
      ? `<div class="legend-grid">${item(DECK_HIGHLIGHT, 'In your deck')}</div>`
      : ''

    legendBodyEl.innerHTML = `
      <div class="legend-group-title">Color identity</div>
      <div class="legend-grid mono">
        ${'WUBRG'.split('').map(c => item(COLOR_MAP[c], COLOR_NAMES[c])).join('')}
        ${item(COLORLESS, 'Colorless')}
      </div>
      <div class="legend-group-title">Two colors</div>
      <div class="legend-grid">
        ${Object.values(GUILD_COLORS).map(g => item(g.color, g.name)).join('')}
      </div>
      <div class="legend-grid">${item(MULTICOLOR, '3+ colors')}</div>
      ${deckItem}
      <div class="legend-note">
        <span class="legend-sizes"><i style="width:4px;height:4px"></i><i style="width:7px;height:7px"></i><i style="width:11px;height:11px"></i></span>
        Bigger node = ${sizeMode === 'cmc' ? 'higher mana value' : 'more connections'}
      </div>
    `
  }

  function showDefaultInfo() {
    selectedCardId = null
    appEl.classList.remove('has-card')
    renderLegend()

    cardInfoEl.innerHTML = '' // the card pane is hidden until a card is selected
  }
  showDefaultInfo()
}

main()
