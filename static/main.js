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
let currentMinScore = null;
let currentMaxScore = null;
let patchMapZoom = null;
let annotationGeoJSON = null;
let patchMapViewState = null;

const CELL_SIZE = 14;
const CELL_GAP = 0;

async function init() {
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

    renderColorbar(null, null);

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

    const scores = scoreMap ? Array.from(scoreMap.values()) : null;
    let minScore = null;
    let maxScore = null;

    if (scores && scores.length > 0) {
        minScore = Math.min(...scores);
        maxScore = Math.max(...scores);
    }

    currentMinScore = minScore;
    currentMaxScore = maxScore;
    renderColorbar(minScore, maxScore);

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
            fill = similarityToViridis(scoreMap.get(patch.patch_id), minScore, maxScore);
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

    updatePatchInfo(patchId, similarities);
    showPatchOnWSI(patch);
}

function updatePatchInfo(patchId, similarities) {
    const selected = similarities.find(p => Number(p.patch_id) === Number(patchId));
    const patchInfo = document.getElementById("patch-info");

    patchInfo.innerHTML = `
        <strong>Selected patch:</strong> ${patchId}<br>
        <strong>x:</strong> ${Math.round(selected.x)}<br>
        <strong>y:</strong> ${Math.round(selected.y)}<br>
        <strong>cluster:</strong> ${selected.cluster}<br>
        <strong>self-similarity:</strong> ${Number(selected.score).toFixed(4)}
    `;
}

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

function similarityToViridis(value, minValue, maxValue) {
    if (minValue === null || maxValue === null || maxValue <= minValue) {
        return "rgb(68, 1, 84)";
    }

    let t = (value - minValue) / (maxValue - minValue);
    t = Math.max(0, Math.min(1, t));

    const anchors = [
        [68, 1, 84],
        [59, 82, 139],
        [33, 145, 140],
        [94, 201, 98],
        [253, 231, 37]
    ];

    const n = anchors.length - 1;
    const scaled = t * n;
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

function renderColorbar(minScore, maxScore) {
    const svg = document.getElementById("colorbar");
    svg.innerHTML = "";

    const width = 60;
    const height = 320;
    const barX = 10;
    const barY = 20;
    const barWidth = 20;
    const barHeight = 260;

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    // gradient definition
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const gradient = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
    gradient.setAttribute("id", "colorbar-gradient");
    gradient.setAttribute("x1", "0%");
    gradient.setAttribute("y1", "100%");
    gradient.setAttribute("x2", "0%");
    gradient.setAttribute("y2", "0%");

    const stops = [
        { offset: "0%", color: "rgb(68, 1, 84)" },
        { offset: "25%", color: "rgb(59, 82, 139)" },
        { offset: "50%", color: "rgb(33, 145, 140)" },
        { offset: "75%", color: "rgb(94, 201, 98)" },
        { offset: "100%", color: "rgb(253, 231, 37)" }
    ];

    stops.forEach(s => {
        const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
        stop.setAttribute("offset", s.offset);
        stop.setAttribute("stop-color", s.color);
        gradient.appendChild(stop);
    });

    defs.appendChild(gradient);
    svg.appendChild(defs);

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", barX);
    rect.setAttribute("y", barY);
    rect.setAttribute("width", barWidth);
    rect.setAttribute("height", barHeight);
    rect.setAttribute("fill", "url(#colorbar-gradient)");
    rect.setAttribute("stroke", "black");
    rect.setAttribute("stroke-width", "0.5");
    svg.appendChild(rect);

    if (minScore === null || maxScore === null) {
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", 5);
        label.setAttribute("y", 15);
        label.setAttribute("font-size", "7");
        label.textContent = "No scale";
        svg.appendChild(label);
        return;
    }

    const ticks = 5;
    for (let i = 0; i < ticks; i++) {
        const t = i / (ticks - 1);
        const y = barY + barHeight - t * barHeight;
        const value = minScore + t * (maxScore - minScore);

        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", barX + barWidth);
        line.setAttribute("x2", barX + barWidth + 5);
        line.setAttribute("y1", y);
        line.setAttribute("y2", y);
        line.setAttribute("stroke", "black");
        line.setAttribute("stroke-width", "0.5");
        svg.appendChild(line);

        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", barX + barWidth + 8);
        text.setAttribute("y", y + 2);
        text.setAttribute("font-size", "6");
        text.textContent = value.toFixed(2);
        svg.appendChild(text);
    }

    const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
    title.setAttribute("x", 2);
    title.setAttribute("y", 10);
    title.setAttribute("font-size", "7");
    title.textContent = "Cos sim";
    svg.appendChild(title);
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


init();