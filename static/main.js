let viewer = null;
let slideWidth = null;
let slideHeight = null;

let allPatches = [];
let selectedPatchId = null;
let selectedOverlay = null;

let coordMinX = null;
let coordMaxX = null;
let coordMinY = null;
let coordMaxY = null;

let uniqueX = [];
let uniqueY = [];
let xToCol = new Map();
let yToRow = new Map();
let patchMapZoom = null;
let annotationGeoJSON = null;
let patchMapViewState = null;

let allCases = [];
const CELL_SIZE = 14;
const CELL_GAP = 0;
const SIMILARITY_MIN = -1;
const SIMILARITY_MAX = 1;

async function init() {
    allCases = await fetch("/cases").then(r => r.json());
    populateCaseSelector(allCases);

    const currentCase = await fetch("/current_case").then(r => r.json());
    document.getElementById("case-select").value = currentCase.wsi;
    renderCaseMeta(currentCase);
    const slideInfo = await fetch("/slide_info").then(r => r.json());
    slideWidth = slideInfo.width;
    slideHeight = slideInfo.height;

    viewer = OpenSeadragon({
        id: "openseadragon",
        prefixUrl: "https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/",
        tileSources: "/dzi",
        showNavigator: true,
        gestureSettingsTouch: {
            pinchToZoom: true,
            flickEnabled: true,
            clickToZoom: false,
            dblClickToZoom: true
        }
    });

    viewer.addHandler("open", redrawAnnotations);
    viewer.addHandler("animation", redrawAnnotations);
    viewer.addHandler("resize", redrawAnnotations);
    viewer.addHandler("pan", redrawAnnotations);
    viewer.addHandler("zoom", redrawAnnotations);

    allPatches = await fetch("/patches").then(r => r.json());

    try {
        annotationGeoJSON = await fetch("/annotation").then(r => r.json());
    } catch (e) {
        console.warn("No annotation loaded", e);
    }

    computeCoordBounds(allPatches);

    renderPatchMap(allPatches, null, null);
    setupPatchMapZoom();

    // const mapContainer = document.getElementById("patch-map-container");

    // mapContainer.addEventListener("wheel", function (e) {
    //     e.preventDefault();
    // }, { passive: false });

    renderColorbar();

    window.addEventListener("resize", () => {
        renderPatchMap(allPatches, null, selectedPatchId);
    });
}

function computeCoordBounds(patches) {
    const xs = patches.map(p => p.x);
    const ys = patches.map(p => p.y);

    coordMinX = Math.min(...xs);
    coordMaxX = Math.max(...xs);
    coordMinY = Math.min(...ys);
    coordMaxY = Math.max(...ys);

    uniqueX = Array.from(new Set(xs)).sort((a, b) => a - b);
    uniqueY = Array.from(new Set(ys)).sort((a, b) => a - b);

    xToCol = new Map(uniqueX.map((x, i) => [x, i]));
    yToRow = new Map(uniqueY.map((y, i) => [y, i]));
}

function patchToMapCoords(patch) {
    const dataWidth = Math.max(1, coordMaxX - coordMinX);
    const dataHeight = Math.max(1, coordMaxY - coordMinY);

    return {
        x: ((patch.x - coordMinX) / dataWidth) * 1000,
        y: ((patch.y - coordMinY) / dataHeight) * 1000
    };
}

function renderPatchMap(patches, scoreMap = null, selectedId = null) {
    patchMapViewState = savePatchMapViewState();

    const svg = document.getElementById("patch-map");
    svg.innerHTML = "";
    const nCols = uniqueX.length;
    const nRows = uniqueY.length;

    const totalWidth = nCols * (CELL_SIZE + CELL_GAP);
    const totalHeight = nRows * (CELL_SIZE + CELL_GAP);

    svg.setAttribute("viewBox", `0 0 ${totalWidth} ${totalHeight}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    renderColorbar();

    patches.forEach(patch => {
        const { col, row } = patchToGridCoords(patch);

        const x = col * (CELL_SIZE + CELL_GAP);
        const y = row * (CELL_SIZE + CELL_GAP);

        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", x);
        rect.setAttribute("y", y);
        rect.setAttribute("width", CELL_SIZE);
        rect.setAttribute("height", CELL_SIZE);

        let fill = "#d9d9d9";
        if (scoreMap && scoreMap.has(patch.patch_id)) {
            fill = similarityToFixedScale(scoreMap.get(patch.patch_id));
        }

        rect.setAttribute("fill", fill);
        rect.setAttribute("stroke", patch.patch_id === selectedId ? "red" : "none");
        rect.setAttribute("stroke-width", patch.patch_id === selectedId ? "2" : "0");
        rect.style.cursor = "pointer";

        rect.addEventListener("click", () => selectPatch(patch.patch_id));
        svg.appendChild(rect);

        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", x + CELL_SIZE / 2);
        label.setAttribute("y", y + CELL_SIZE / 2);
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("dominant-baseline", "middle");
        label.setAttribute("fill", "white");
        label.setAttribute("font-size", Math.max(7, CELL_SIZE * 0.45));
        label.setAttribute("font-family", "Arial, sans-serif");
        label.setAttribute("pointer-events", "none");
        label.textContent = patch.cluster;

        svg.appendChild(label);
    });
    setupPatchMapZoom();
    restorePatchMapViewState();

}

function setupPatchMapZoom() {
    if (patchMapZoom) {
        patchMapZoom.destroy();
        patchMapZoom = null;
    }

    patchMapZoom = svgPanZoom('#patch-map', {
        zoomEnabled: true,
        controlIconsEnabled: false,
        fit: true,
        center: true,
        minZoom: 0.5,
        maxZoom: 50,
        zoomScaleSensitivity: 0.3,
        panEnabled: true,
        customEventsHandler: {
            haltEventListeners: [
                'touchstart',
                'touchend',
                'touchmove',
                'touchleave',
                'touchcancel'
            ],
            init: function (options) {
                const instance = options.instance;
                const svgElement = options.svgElement;

                this.hammer = new Hammer(svgElement, {
                    inputClass: Hammer.SUPPORT_POINTER_EVENTS
                        ? Hammer.PointerEventInput
                        : Hammer.TouchInput
                });

                this.hammer.get('pinch').set({ enable: true });
                this.hammer.get('pan').set({ direction: Hammer.DIRECTION_ALL });

                let lastScale = 1;
                let pannedX = 0;
                let pannedY = 0;

                this.hammer.on('doubletap', function () {
                    instance.zoomIn();
                });

                this.hammer.on('panstart panmove', function (ev) {
                    if (ev.type === 'panstart') {
                        pannedX = 0;
                        pannedY = 0;
                    }

                    instance.panBy({
                        x: ev.deltaX - pannedX,
                        y: ev.deltaY - pannedY
                    });

                    pannedX = ev.deltaX;
                    pannedY = ev.deltaY;
                });

                this.hammer.on('pinchstart pinchmove', function (ev) {
                    if (ev.type === 'pinchstart') {
                        lastScale = 1;
                    }

                    const zoomFactor = ev.scale / lastScale;
                    lastScale = ev.scale;

                    instance.zoomAtPointBy(
                        zoomFactor,
                        { x: ev.center.x, y: ev.center.y },
                        true
                    );
                });
            },
            destroy: function () {
                if (this.hammer) {
                    this.hammer.destroy();
                }
            }
        }
    });
}

function savePatchMapViewState() {
    if (!patchMapZoom) return null;

    return {
        zoom: patchMapZoom.getZoom(),
        pan: patchMapZoom.getPan()
    };
}

function restorePatchMapViewState() {
    if (!patchMapZoom || !patchMapViewState) return;

    patchMapZoom.zoom(patchMapViewState.zoom);
    patchMapZoom.pan(patchMapViewState.pan);
}
async function selectPatch(patchId) {
    selectedPatchId = patchId;

    const similarities = await fetch(`/similarities/${patchId}`).then(r => r.json());

    const scoreMap = new Map();
    similarities.forEach(p => scoreMap.set(p.patch_id, p.score));

    renderPatchMap(allPatches, scoreMap, patchId);

    const patch = allPatches.find(p => Number(p.patch_id) === Number(patchId));
    if (!patch) return;

    // updatePatchInfo(patchId, similarities);
    showPatchOnWSI(patch);
}

// function updatePatchInfo(patchId, similarities) {
//     const selected = similarities.find(p => Number(p.patch_id) === Number(patchId));
//     const patchInfo = document.getElementById("patch-info");

//     patchInfo.innerHTML = `
//         <strong>Selected patch:</strong> ${patchId}<br>
//         <strong>x:</strong> ${Math.round(selected.x)}<br>
//         <strong>y:</strong> ${Math.round(selected.y)}<br>
//         <strong>cluster:</strong> ${selected.cluster}<br>
//         <strong>self-similarity:</strong> ${Number(selected.score).toFixed(4)}
//     `;
// }

function patchToRect(patch) {
    const x = patch.x / slideWidth;
    const y = patch.y / slideHeight;
    const w = patch.width / slideWidth;
    const h = patch.height / slideHeight;
    return new OpenSeadragon.Rect(x, y, w, h);
}

function showPatchOnWSI(patch) {
    const rect = patchToRect(patch);
    viewer.viewport.fitBounds(rect.expand(3));

    if (selectedOverlay) {
        try {
            viewer.removeOverlay(selectedOverlay);
        } catch (e) {
            console.warn(e);
        }
        selectedOverlay = null;
    }

    const overlay = document.createElement("div");
    overlay.style.border = "2px solid red";
    overlay.style.background = "rgba(255,0,0,0.10)";
    overlay.style.boxSizing = "border-box";

    viewer.addOverlay({
        element: overlay,
        location: rect
    });

    selectedOverlay = overlay;
}


function populateCaseSelector(cases) {
    const select = document.getElementById("case-select");
    select.innerHTML = "";

    cases.forEach(c => {
        const opt = document.createElement("option");
        opt.value = c.wsi;

        const parts = [
            c.wsi,
            `project ${c.project ?? "-"}`,
            `sex ${c.sex ?? "-"}`,
            `age ${c.age ?? "-"}`,
            `grade ${c.grade ?? "-"}`,
            `stage ${c.stage ?? "-"}`,
            `outcome ${c.outcome_class ?? "-"}`,
            `kalimuthu ${c.kalimuthu_class ?? "-"}`
        ];

        opt.textContent = parts.join(" • ");
        select.appendChild(opt);
    });

    select.addEventListener("change", async (e) => {
        await switchCase(e.target.value);
    });
}
function renderCaseMeta(meta) {
    const el = document.getElementById("case-meta");
    el.innerHTML = `
        <span class="case-meta-item"><strong>WSI:</strong> ${meta.wsi ?? "-"}</span>
        <span class="case-meta-item"><strong>Project:</strong> ${meta.project ?? "-"}</span>
        <span class="case-meta-item"><strong>Sex:</strong> ${meta.sex ?? "-"}</span>
        <span class="case-meta-item"><strong>Age:</strong> ${meta.age ?? "-"}</span>
        <span class="case-meta-item"><strong>Age group:</strong> ${meta.age_group ?? "-"}</span>
        <span class="case-meta-item"><strong>Grade:</strong> ${meta.grade ?? "-"}</span>
        <span class="case-meta-item"><strong>Stage:</strong> ${meta.stage ?? "-"}</span>
        <span class="case-meta-item"><strong>Survival:</strong> ${meta.survival_days ?? "-"}</span>
        <span class="case-meta-item"><strong>Outcome:</strong> ${meta.outcome_class ?? "-"}</span>
        <span class="case-meta-item"><strong>Kalimuthu:</strong> ${meta.kalimuthu_class ?? "-"}</span>
    `;
}

function interpolateAnchors(t, anchors) {
    const n = anchors.length - 1;
    const scaled = Math.max(0, Math.min(1, t)) * n;
    const i = Math.floor(scaled);
    const frac = Math.min(1, scaled - i);

    if (i >= n) {
        const c = anchors[n];
        return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }

    const c0 = anchors[i];
    const c1 = anchors[i + 1];

    const r = Math.round(c0[0] + frac * (c1[0] - c0[0]));
    const g = Math.round(c0[1] + frac * (c1[1] - c0[1]));
    const b = Math.round(c0[2] + frac * (c1[2] - c0[2]));
    return `rgb(${r}, ${g}, ${b})`;
}

function colorFromPinkRamp(t) {
    // Match the Python snippet:
    // R=1.0, G: 0.08->0.80, B: 0.58->0.80
    const clamped = Math.max(0, Math.min(1, t));
    const r = 255;
    const g = Math.round((0.08 + (0.80 - 0.08) * clamped) * 255);
    const b = Math.round((0.58 + (0.80 - 0.58) * clamped) * 255);
    return `rgb(${r}, ${g}, ${b})`;
}

function similarityToFixedScale(value) {
    const v = Math.max(SIMILARITY_MIN, Math.min(SIMILARITY_MAX, value));

    const viridisAnchors = [
        [68, 1, 84],
        [59, 82, 139],
        [33, 145, 140],
        [94, 201, 98],
        [253, 231, 37]
    ];

    if (v < 0) {
        const tNeg = (v - SIMILARITY_MIN) / (0 - SIMILARITY_MIN);
        return colorFromPinkRamp(tNeg);
    }

    const tPos = (v - 0) / (SIMILARITY_MAX - 0);
    return interpolateAnchors(tPos, viridisAnchors);
}

function renderColorbar() {
    const svg = document.getElementById("colorbar");
    svg.innerHTML = "";

    const width = 700;
    const height = 80;

    const barX = 55;
    const barY = 24;
    const barWidth = 600;
    const barHeight = 16;

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const gradient = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");

    gradient.setAttribute("id", "colorbar-gradient");
    gradient.setAttribute("x1", "0%");
    gradient.setAttribute("y1", "0%");
    gradient.setAttribute("x2", "100%");
    gradient.setAttribute("y2", "0%");

    // Build the colorbar from sampled values so it follows the exact same mapping
    // used for the patch colors (fixed scale, split at 0).
    const nStops = 100;
    for (let i = 0; i <= nStops; i++) {
        const t = i / nStops;
        const value = SIMILARITY_MIN + t * (SIMILARITY_MAX - SIMILARITY_MIN);
        const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
        stop.setAttribute("offset", `${t * 100}%`);
        stop.setAttribute("stop-color", similarityToFixedScale(value));
        gradient.appendChild(stop);
    }

    defs.appendChild(gradient);
    svg.appendChild(defs);

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", barX);
    rect.setAttribute("y", barY);
    rect.setAttribute("width", barWidth);
    rect.setAttribute("height", barHeight);
    rect.setAttribute("fill", "url(#colorbar-gradient)");
    rect.setAttribute("stroke", "black");
    rect.setAttribute("stroke-width", "0.8");
    svg.appendChild(rect);

    const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
    title.setAttribute("x", barX);
    title.setAttribute("y", 14);
    title.setAttribute("font-size", "14");
    title.setAttribute("font-weight", "600");
    title.textContent = "Cosine similarity (fixed scale)";
    svg.appendChild(title);

    const tickValues = [-1, -0.5, 0, 0.5, 1];

    tickValues.forEach(value => {
        const t = (value - SIMILARITY_MIN) / (SIMILARITY_MAX - SIMILARITY_MIN);
        const x = barX + t * barWidth;

        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", x);
        line.setAttribute("x2", x);
        line.setAttribute("y1", barY + barHeight);
        line.setAttribute("y2", barY + barHeight + 8);
        line.setAttribute("stroke", "black");
        line.setAttribute("stroke-width", "0.8");
        svg.appendChild(line);

        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", x);
        label.setAttribute("y", barY + barHeight + 24);
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("font-size", "12");
        label.textContent = value.toFixed(2);
        svg.appendChild(label);
    });
}

function patchToGridCoords(patch) {
    return {
        col: xToCol.get(patch.x),
        row: yToRow.get(patch.y)
    };
}

function imageToViewerPixel(x, y) {
    const point = viewer.viewport.imageToViewerElementCoordinates(
        new OpenSeadragon.Point(x, y)
    );
    return point;
}

function redrawAnnotations() {
    const svg = document.getElementById("annotation-overlay");
    svg.innerHTML = "";

    if (!annotationGeoJSON || !annotationGeoJSON.features || !viewer) return;

    annotationGeoJSON.features.forEach(feature => {
        const geom = feature.geometry;
        if (!geom) return;

        if (geom.type === "Polygon") {
            drawPolygonCoordinates(geom.coordinates, svg);
        } else if (geom.type === "MultiPolygon") {
            geom.coordinates.forEach(polyCoords => {
                drawPolygonCoordinates(polyCoords, svg);
            });
        }
    });
}

function drawPolygonCoordinates(polygonCoords, svg) {
    // polygonCoords for Polygon is an array of rings:
    // [ outer_ring, hole1, hole2, ... ]
    polygonCoords.forEach((ring, ringIdx) => {
        if (!ring || ring.length === 0) return;

        let d = "";

        ring.forEach((coord, i) => {
            const x = coord[0];
            const y = coord[1];

            const pt = imageToViewerPixel(x, y);

            if (i === 0) {
                d += `M ${pt.x} ${pt.y} `;
            } else {
                d += `L ${pt.x} ${pt.y} `;
            }
        });

        d += "Z";

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);

        // Outer ring visible, holes optional styling
        if (ringIdx === 0) {
            path.setAttribute("fill", "rgba(255,0,0,0.08)");
            path.setAttribute("stroke", "red");
            path.setAttribute("stroke-width", "2");
        } else {
            path.setAttribute("fill", "white");
            path.setAttribute("stroke", "red");
            path.setAttribute("stroke-width", "1");
        }

        svg.appendChild(path);
    });
}
async function switchCase(wsi) {
    const response = await fetch("/select_case", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ wsi })
    });

    const selectedCase = await response.json();
    renderCaseMeta(selectedCase);

    // reload slide info
    const slideInfo = await fetch("/slide_info").then(r => r.json());
    slideWidth = slideInfo.width;
    slideHeight = slideInfo.height;

    // reload patches
    allPatches = await fetch("/patches").then(r => r.json());

    // reload annotation
    try {
        annotationGeoJSON = await fetch("/annotation").then(r => r.json());
    } catch (e) {
        annotationGeoJSON = null;
    }

    // reset local state
    selectedPatchId = null;
    if (selectedOverlay) {
        try {
            viewer.removeOverlay(selectedOverlay);
        } catch (e) {}
        selectedOverlay = null;
    }

    computeCoordBounds(allPatches);
    renderPatchMap(allPatches, null, null);
    redrawAnnotations();

    // reopen OpenSeadragon tile source
    viewer.open("/dzi");
}

init();