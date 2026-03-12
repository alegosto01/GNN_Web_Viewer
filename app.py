from flask import Flask, render_template, jsonify, abort, Response, request
from openslide import OpenSlide
from openslide.deepzoom import DeepZoomGenerator
import torch
import torch.nn.functional as F
import numpy as np
import io
import json
import pandas as pd
import os
app = Flask(__name__)




BASE_DATA_DIR = "/home/ale/Desktop/GNN_Web_Viewer/data"
CSV_PATH = "/home/ale/Desktop/GNN_Web_Viewer/WSI_VIEWER_ALIPANC.csv"   # or copy it into your repo/data if you prefer

metadata_df = pd.read_csv(CSV_PATH)


slide = None
dz = None
slide_width = None
slide_height = None
coords = None
features = None
clusters = None
num_patches = None
current_annotation_path = None


def find_file_containing(folder, keyword, extensions):
    """
    Search for a file in 'folder' whose name contains 'keyword'
    and has one of the provided extensions.
    """
    keyword = keyword.lower()

    for fname in os.listdir(folder):
        fname_lower = fname.lower()

        if keyword in fname_lower:
            for ext in extensions:
                if fname_lower.endswith(ext):
                    return os.path.join(folder, fname)

    return None

def load_case(wsi_id):
    global slide, dz, slide_width, slide_height
    global coords, features, clusters, num_patches, current_annotation_path, CURRENT_WSI

    if wsi_id not in CASE_REGISTRY:
        raise ValueError(f"Unknown WSI: {wsi_id}")

    case = CASE_REGISTRY[wsi_id]

    slide = OpenSlide(case["slide_path"])
    dz = DeepZoomGenerator(slide, tile_size=256, overlap=0, limit_bounds=False)
    slide_width, slide_height = slide.dimensions

    data = torch.load(case["graph_path"], map_location="cpu", weights_only=False)

    coords = data.pos.detach().cpu().numpy().astype(np.float32)
    features_t = data.zn.detach().float().cpu()
    features_t = F.normalize(features_t, dim=1)
    features = features_t

    clusters_arr = data.x.detach().cpu().numpy()
    if clusters_arr.ndim == 2 and clusters_arr.shape[1] == 1:
        clusters_arr = clusters_arr[:, 0]

    clusters = clusters_arr

    num_patches = coords.shape[0]
    current_annotation_path = case["geojson_path"]
    CURRENT_WSI = wsi_id

def build_case_registry():
    registry = {}

    for _, row in metadata_df.iterrows():
        wsi_id = row["wsi"]

        slide_path = find_file_containing(BASE_DATA_DIR, wsi_id, [".svs"])
        graph_path = find_file_containing(BASE_DATA_DIR, wsi_id, [".pt"])
        geojson_path = find_file_containing(BASE_DATA_DIR, wsi_id, [".geojson"])

        project_value = row["project"] if "project" in metadata_df.columns and not pd.isna(row["project"]) else str(wsi_id).split("-")[0]

        if slide_path is None:
            print(f"WARNING: slide not found for {wsi_id}")

        if graph_path is None:
            print(f"WARNING: graph not found for {wsi_id}")

        registry[wsi_id] = {
            "wsi": wsi_id,
            "slide_path": slide_path,
            "graph_path": graph_path,
            "geojson_path": geojson_path,
            "meta": {
                "project": project_value,
                "sex": None if pd.isna(row["sex"]) else row["sex"],
                "age": None if pd.isna(row["age"]) else int(row["age"]),
                "age_group": None if pd.isna(row["age_group"]) else row["age_group"],
                "grade": None if pd.isna(row["grade"]) else row["grade"],
                "stage": None if pd.isna(row["stage"]) else row["stage"],
                "death": None if pd.isna(row["death"]) else float(row["death"]),
                "follow": None if pd.isna(row["follow"]) else float(row["follow"]),
                "survival_days": None if pd.isna(row["survival_days"]) else float(row["survival_days"]),
                "outcome_class": None if pd.isna(row["outcome_class"]) else row["outcome_class"],
                "kalimuthu_class": None if pd.isna(row["kalimuthu_class"]) else row["kalimuthu_class"],
            }
        }

    return registry
CASE_REGISTRY = build_case_registry()
DEFAULT_WSI = list(CASE_REGISTRY.keys())[0]
CURRENT_WSI = DEFAULT_WSI



PATCH_SIZE = 224           # patch size in slide pixels, adjust if needed
COORD_SCALE = 1.0          # change this later if data.pos is not in svs space

# # -------------------------
# # Load slide
# # -------------------------
# slide = OpenSlide(SLIDE_PATH)
# dz = DeepZoomGenerator(slide, tile_size=PATCH_SIZE, overlap=0, limit_bounds=False)

# slide_width, slide_height = slide.dimensions

# # -------------------------
# # Load graph
# # -------------------------
# data = torch.load(GRAPH_PATH, map_location="cpu", weights_only=False)

# coords = data.pos.detach().cpu().numpy().astype(np.float32)
# features = data.zn.detach().float().cpu()
# clusters = data.x.detach().cpu().numpy()

# if clusters.ndim == 2 and clusters.shape[1] == 1:
#     clusters = clusters[:, 0]

# features = F.normalize(features, dim=1)

# num_patches = coords.shape[0]

# -------------------------
# Helpers
# -------------------------
def cluster_value(i):
    v = clusters[i]
    if np.issubdtype(type(v), np.integer) or np.issubdtype(np.array(v).dtype, np.integer):
        return int(v)
    return float(v)

def get_patch_record(i, score=None):
    x = float(coords[i, 0] * COORD_SCALE)
    y = float(coords[i, 1] * COORD_SCALE)

    record = {
        "patch_id": int(i),
        "x": x,
        "y": y,
        "width": PATCH_SIZE,
        "height": PATCH_SIZE,
        "cluster": cluster_value(i),
    }
    if score is not None:
        record["score"] = float(score)
    return record

# initialize first slide when the server starts
load_case(DEFAULT_WSI)   

# -------------------------
# Routes
# -------------------------
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/dzi")
def dzi():
    return Response(dz.get_dzi("jpeg"), mimetype="application/xml")

@app.route("/dzi_files/<int:level>/<int:col>_<int:row>.jpeg")
def tile(level, col, row):
    try:
        tile = dz.get_tile(level, (col, row))
    except Exception:
        abort(404)

    buf = io.BytesIO()
    tile.save(buf, format="JPEG")
    buf.seek(0)
    return Response(buf.getvalue(), mimetype="image/jpeg")

@app.route("/annotation")
def annotation():
    if not current_annotation_path or not os.path.exists(current_annotation_path):
        return jsonify({"type": "FeatureCollection", "features": []})

    with open(current_annotation_path, "r") as f:
        data = json.load(f)
    return jsonify(data)

@app.route("/slide_info")
def slide_info():
    return jsonify({
        "width": slide_width,
        "height": slide_height,
        "num_patches": int(num_patches),
        "embedding_dim": int(features.shape[1]),
        "coord_min": coords.min(axis=0).tolist(),
        "coord_max": coords.max(axis=0).tolist(),
        "patch_size": PATCH_SIZE,
        "coord_scale": COORD_SCALE,
    })

@app.route("/patches")
def patches():
    return jsonify([get_patch_record(i) for i in range(num_patches)])

@app.route("/similarities/<int:patch_id>")
def similarities(patch_id):
    if patch_id < 0 or patch_id >= num_patches:
        abort(404)

    query = features[patch_id]
    sims = torch.matmul(features, query).cpu().numpy()

    result = [get_patch_record(i, score=sims[i]) for i in range(num_patches)]
    result.sort(key=lambda d: d["score"], reverse=True)
    return jsonify(result)


@app.route("/cases")
def cases():
    return jsonify([
        {
            "wsi": wsi_id,
            **case["meta"]
        }
        for wsi_id, case in CASE_REGISTRY.items()
    ])

@app.route("/current_case")
def current_case():
    case = CASE_REGISTRY[CURRENT_WSI]
    return jsonify({
        "wsi": CURRENT_WSI,
        **case["meta"]
    })

@app.route("/select_case", methods=["POST"])
def select_case():
    payload = request.get_json()
    wsi_id = payload.get("wsi")

    if wsi_id not in CASE_REGISTRY:
        return jsonify({"error": "Unknown WSI"}), 404

    load_case(wsi_id)
    case = CASE_REGISTRY[wsi_id]

    return jsonify({
        "ok": True,
        "wsi": wsi_id,
        **case["meta"]
    })



if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)