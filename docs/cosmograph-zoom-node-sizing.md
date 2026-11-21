# Zoom-aware node sizing in Cosmograph

How the MTG Combo Network project makes nodes grow gently as you zoom in, without changing the overview.

Tested on `@cosmograph/cosmograph` 2.6.0 (engine `@cosmograph/cosmos` 2.6.0), 2D, about 4,400 points and 68,000 links. The working code is in `app/src/main.ts` of that project, in the block headed "Node size vs. zoom".

## The problem

Cosmograph gives two choices through `scalePointsOnZoom`, and neither works for a large graph:

- **`false` (default):** nodes keep a fixed on-screen size. A 2px node is still 2px when zoomed in, so small nodes are hard to click.
- **`true`:** nodes scale 1:1 with zoom. Sized to look right at the overview, they become enormous up close.

## The approach

Leave `scalePointsOnZoom` at `false` and drive `pointSizeScale` from the zoom level yourself:

```
growth = clamp( (zoom / fitZoom) ^ 0.5 , 1 , 4 )
pointSizeScale = yourOwnSizeSetting * growth
```

- **`fitZoom`** is the zoom level at which the graph fills the viewport. Growth is 1 there, so the overview looks exactly as before.
- **Square root** means on-screen spacing grows faster than node size, so zooming in never makes the graph more crowded.
- **The 4x cap** is reached at 16x the fit zoom.

Measured node diameters with base sizes from 2.3px to 20px:

| Zoom relative to fit | Growth | Smallest node | Largest node |
|---|---|---|---|
| 1x | 1.00 | 2.3px | 20px |
| 1.9x | 1.27 | 3.0px | 25px |
| 3.8x | 1.78 | 4.2px | 36px |
| 7.4x | 2.49 | 5.8px | 50px |
| 14x | 3.48 | 8.2px | 70px |
| 28x and beyond | 4.00 | 9.4px | 80px |

## Five details that make it work

### 1. Compute `fitZoom` from point positions, not from the camera

One layout unit is one CSS pixel at zoom 1. So:

```
fitZoom = min(width * 0.8 / spanX, height * 0.8 / spanY)
```

where 0.8 matches a `fitView` padding of 0.1 per side. With plain min/max spans this equalled `getZoomLevel()` after a `fitView` exactly.

- Trim the outermost 0.2% of points on each side before taking the span, so a node the user dragged far away doesn't change every node's size.
- Use the same set of points your "fit view" frames. We fit to the largest connected component.
- Recompute while the layout spreads out (we use 1.5s, 4s, 8s and 14s after a data change), in `onSimulationEnd`, and when the user presses Fit view. Set it to `null` when the data is rebuilt.

### 2. Don't update through `setConfig()` per frame

`setConfig()` deep-walks every point and link object on each call, about 50ms synchronous at our size. Call the engine underneath instead:

```ts
graph._cosmos.setConfigPartial({ pointSizeScale })
```

- It's a uniform update, it doesn't restart the simulation, and labels follow because they read the engine's live `pointSizeScale`.
- `_cosmos` is a private field, so guard it and fall back to one debounced `setConfig()` after zooming stops.
- Keep the current value in the config object you pass to `setConfig()`, and re-send it to the engine after each `setConfig()` promise resolves. `setConfig()` applies asynchronously and would otherwise overwrite the scale with a stale one.

### 3. Divide out the engine's own boost

With `scalePointsOnZoom: false` the shader multiplies size by `min(5, max(1, zoom * 0.01))`, so nodes grow up to 5x between zoom 100 and 500. Small graphs fit at a high zoom and reach that range quickly, where it would stack with your growth. Multiply by `boost(fitZoom) / boost(zoom)`. We measured sizes staying flat at the cap out to zoom 476.

### 4. Apply growth only after the user takes over the camera

While you are auto-fitting a settling layout, the camera lags the freshly computed `fitZoom`, and nodes would pulse at each re-fit. We set a `userMoved` flag in `onZoomStart` when `userDriven` is true, and keep growth at 1 until then.

### 5. Throttle and quantize

Hook `onZoom`, coalesce with `requestAnimationFrame`, and round growth to 2% geometric steps so most frames are a no-op.

## Code

Adapted from the working code with project-specific parts removed; the adapted version itself has not been run.

```ts
// Assumes: `graph` = Cosmograph instance, `container` = its element, `config` = the full
// config object you pass to setConfig() (must include pointSizeScale), scalePointsOnZoom = false.
const EXPONENT = 0.5   // 0 = fixed size, 1 = scales 1:1 with zoom
const MAX_GROWTH = 4
const STEP = 1.02      // apply in 2% steps
let fitZoom: number | null = null // zoom at which the graph fills the view
let userScale = 1                 // your own node-size setting, if you have one
let zoomGrowth = 1
let userMoved = false             // true once the user pans/zooms; false again when data is rebuilt
let queued = false
let fallbackTimer = 0

// The engine's built-in boost when scalePointsOnZoom is false (from the 2.6.0 shader)
const engineZoomBoost = (zoom: number) => Math.min(5, Math.max(1, zoom * 0.01))

function renderEngine() {
  const engine = (graph as any)._cosmos // private field: may disappear in a future version
  return typeof engine?.setConfigPartial === 'function' ? engine : null
}

function pushNodeScale() {
  const pointSizeScale = config.pointSizeScale
  const engine = renderEngine()
  if (engine) {
    if (engine.config?.pointSizeScale !== pointSizeScale) engine.setConfigPartial({ pointSizeScale })
    return
  }
  window.clearTimeout(fallbackTimer) // slow path: one setConfig() once zooming stops
  fallbackTimer = window.setTimeout(() => graph.setConfig({ ...config }), 150)
}

function applyZoomSizing() {
  queued = false
  const zoom = graph.getZoomLevel()
  let growth = 1
  if (userMoved && fitZoom && zoom) {
    const wanted = Math.min(MAX_GROWTH, Math.max(1, (zoom / fitZoom) ** EXPONENT))
    const raw = wanted * engineZoomBoost(fitZoom) / engineZoomBoost(zoom)
    growth = STEP ** Math.round(Math.log(raw) / Math.log(STEP))
  }
  if (growth === zoomGrowth) return
  zoomGrowth = growth
  config.pointSizeScale = userScale * zoomGrowth
  pushNodeScale()
}

function queueZoomSizing() {
  if (queued) return
  queued = true
  requestAnimationFrame(applyZoomSizing)
}

async function updateFitZoom() {
  const positions = await graph.getPointPositionsAsync() // [x0, y0, x1, y1, ...]
  if (!positions || positions.length < 4) return
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i + 1 < positions.length; i += 2) {
    if (Number.isFinite(positions[i]) && Number.isFinite(positions[i + 1])) {
      xs.push(positions[i])
      ys.push(positions[i + 1])
    }
  }
  if (xs.length < 2) return
  const span = (values: number[]) => {
    values.sort((a, b) => a - b)
    const trim = Math.floor(values.length * 0.002) // ignore the outermost 0.2% per side
    return values[values.length - 1 - trim] - values[trim]
  }
  const spanX = span(xs)
  const spanY = span(ys)
  const { width, height } = container.getBoundingClientRect()
  if (!(spanX > 0) || !(spanY > 0) || !width || !height) return
  fitZoom = Math.min((width * 0.8) / spanX, (height * 0.8) / spanY)
  queueZoomSizing()
}
```

### Wiring

| Where | What to call |
|---|---|
| `onZoom` | `queueZoomSizing()` |
| `onZoomStart(event, userDriven)` | `if (userDriven) userMoved = true` |
| `onSimulationEnd`, a few timers after each data load, your Fit view button | `updateFitZoom()` |
| After every `graph.setConfig(...)` | `.then(() => { if (renderEngine()) pushNodeScale() })` |
| Data rebuild | `fitZoom = null; userMoved = false` |

## Caveats

- **Private API and hard-coded constants:** the `_cosmos` access and the `0.01` and `5` boost constants come from reading the 2.6.0 source. Re-check both on upgrade.
- **Reference vs. real fit:** because of the 0.2% trim, `fitZoom` came out about 1.2x the real fit zoom on our graph, so growth starts slightly after the user begins zooming in.
- **Testing:** measured in headless Chrome with software WebGL, and then judged good on a real GPU by the project owner. Not tested in 3D mode.
- **Tuning:** `EXPONENT` and `MAX_GROWTH` are the two knobs. We settled on 0.5 and 4 for base sizes of 2–20px.
